// One run of the nudge worker. Started by GitHub Actions (workflow_dispatch).
//
// Order: read Mongo -> sync `issues` (clear whatever Mongo no longer flags) -> plan -> execute.
// Nothing reaches a real person unless the database setting `mode` is canary or live.

import { MongoClient } from 'mongodb';
import { fetchOpenIssues } from './lib/mongoCategories.js';
import { diffIssues, peopleFromIssues } from './lib/sync.js';
import { resolveRecipients } from './lib/recipients.js';
import { planRun } from './lib/planner.js';
import { executePlan, MODES } from './lib/executor.js';
import { istDate } from './lib/time.js';
import { makeAppSender } from './lib/appSender.js';
import * as S from './lib/store.js';
import { writeFileSync, appendFileSync } from 'node:fs';

/**
 * A dispatch can always ask for a SAFER mode (shadow/rehearsal). It can only ask for canary/live
 * if the database setting already says the same, so a stray click can never make it live.
 */
export function effectiveMode(requested, configured) {
  if (!requested) return configured;
  if (!MODES.includes(requested)) throw new Error(`Unknown RUN_MODE "${requested}"`);
  if (requested === 'shadow' || requested === 'rehearsal') return requested;
  if (requested !== configured) throw new Error(`RUN_MODE=${requested} refused: the database setting is "${configured}"`);
  return requested;
}

/**
 * AS_OF lets a shadow or rehearsal run plan "as if" it were another moment (e.g. preview Monday's
 * messages on a Sunday). Reading Mongo and syncing always use the real time. Refused for canary/live.
 */
export function resolveNow(asOf, mode, realNow = new Date()) {
  if (!asOf) return realNow;
  if (mode === 'canary' || mode === 'live') throw new Error(`AS_OF is not allowed in ${mode} mode`);
  const d = new Date(asOf);
  if (Number.isNaN(d.getTime())) throw new Error(`AS_OF "${asOf}" is not a valid date-time`);
  return d;
}

export async function main(env = process.env) {
  const db = S.makeDb(env);
  const realNow = new Date();
  const settings = await S.loadSettings(db);
  const mode = effectiveMode(env.RUN_MODE || null, settings.mode || 'shadow');
  const now = resolveNow(env.AS_OF || null, mode, realNow);
  const runId = await S.startRun(db, { mode, trigger: env.GITHUB_EVENT_NAME || 'manual' });
  const mongo = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });

  try {
    // 1. Read Mongo (read-only) and mirror it into `issues`.
    await mongo.connect();
    const { issues: fetched, orphans } = await fetchOpenIssues(mongo.db('test'), realNow, { log: console.log });
    const existingOpen = await S.loadOpenIssues(db);
    const diff = diffIssues(existingOpen, fetched);
    await S.applySync(db, { diff, people: peopleFromIssues(fetched), nowIso: realNow.toISOString() });
    for (const s of diff.suspectCategories) {
      await S.addReviewItem(db, { kind: 'sync_guard', note: `${s.category}: ${s.wouldClear} of ${s.wasOpen} open issues vanished at once; treated as a bad read, nothing cleared or sent for this category.` });
    }
    const suspect = new Set(diff.suspectCategories.map((s) => s.category));

    // 2. Build the planner input from the freshly synced state.
    const [openRows, overrides, peopleRows, holidays, recentCounts] = await Promise.all([
      S.loadOpenIssues(db), S.loadOverrides(db), S.loadPeople(db), S.loadHolidays(db), S.recentSentCounts(db),
    ]);
    const overridesByIssue = new Map();
    for (const o of overrides) overridesByIssue.set(o.issue_id, [...(overridesByIssue.get(o.issue_id) || []), o]);

    // Categories can be switched on one at a time (e.g. invoice approvals first). Unset = all five.
    const enabled = Array.isArray(settings.enabled_categories) ? new Set(settings.enabled_categories) : null;
    const plannerIssues = openRows.filter((r) => !suspect.has(r.category) && (!enabled || enabled.has(r.category))).map((r) => {
      const { ownerIds, needsOwner } = resolveRecipients(r, overridesByIssue.get(r.id) || []);
      return { id: r.id, category: r.category, ownerIds, needsOwner, nudgeCount: r.nudge_count, lastNudgedAt: r.last_nudged_at, holdUntil: r.hold_until, firstSeenAt: r.first_seen_at };
    });
    const people = new Map(peopleRows.map((p) => [p.dms_user_id, p]));
    const planPeople = new Map(peopleRows.map((p) => [p.dms_user_id, { enteredAt: p.entered_at, skippedCount: p.skipped_count }]));

    const plan = planRun({
      now, issues: plannerIssues, people: planPeople, holidays,
      settings: { laneACap: Number(settings.lane_a_cap ?? 40), rampActive: settings.ramp_active !== false },
    });
    for (const id of plan.needsOwnerIssueIds) await S.addReviewItem(db, { kind: 'needs_owner', issue_id: id, note: 'Campaign lead is deleted, inactive or missing in DMS.' });
    for (const id of plan.exhaustedIssueIds) await S.addReviewItem(db, { kind: 'ladder_exhausted', issue_id: id, note: 'Five nudges sent without resolution.' });

    // 3. Execute according to the mode.
    // Sending goes through the website's own server, which already holds the Gmail and Slack access.
    const senderRow = await S.loadSender(db, settings.sender_user_email);
    const senders = mode !== 'shadow' && plan.messages.length
      ? makeAppSender({ baseUrl: settings.app_base_url, key: env.SUPABASE_SERVICE_ROLE_KEY })
      : { email: null, slack: null };
    const issuesById = new Map(openRows.map((r) => [r.id, r]));
    const exec = await executePlan({
      plan, mode, now, runId, store: S.executorStore(db), senders, issuesById, people, holidays,
      recentRunCounts: recentCounts,
      settings: {
        senderName: senderRow.name, senderEmail: senderRow.gmail_address, redirectTo: settings.rehearsal_redirect_to,
        allowlist: settings.canary_allowlist || [], sendWindow: settings.send_window, rehearsalMax: settings.rehearsal_max,
      },
    });
    if (exec.rampDone) await S.setSetting(db, 'ramp_active', false);

    const stats = {
      ...exec, today: plan.today, nudgeDay: plan.nudgeDay, monthEnd: plan.monthEnd, weeklySlot: plan.weeklySlot,
      issuesOpen: openRows.length, inserted: diff.toInsert.length, updated: diff.toUpdate.length, cleared: diff.toClear.length,
      orphans: orphans.length, suspectCategories: diff.suspectCategories, excluded: plan.excluded, planCounts: plan.counts,
    };
    await S.finishRun(db, runId, { ok: true, stats });
    await report({ db, runId, stats, plan });
    return stats;
  } catch (err) {
    await S.finishRun(db, runId, { ok: false, stats: {}, error: err.message }).catch(() => {});
    throw err;
  } finally {
    await mongo.close().catch(() => {});
  }
}

/** Human-readable summary: the job summary in GitHub, plus a full report file kept as an artifact. */
async function report({ db, runId, stats, plan }) {
  const { data: msgs } = await db.from('messages_out').select('recipient_dms_user_id,channel,lane,kind,status,to_address,intended_to,subject,body,mode').eq('run_id', runId).order('created_at');
  const rows = msgs || [];
  const summary = [
    `## Nudge run: ${stats.mode} (${stats.today})`,
    `Nudge day: **${stats.nudgeDay}**, month-end window: **${stats.monthEnd}**, weekly slot: ${stats.weeklySlot}`,
    `Issues open: **${stats.issuesOpen}** (new ${stats.inserted}, updated ${stats.updated}, cleared ${stats.cleared}, orphans ${stats.orphans})`,
    `Planned messages: **${stats.planned}** (lane A ${plan.counts.laneA}, deferred ${plan.counts.laneADeferred}, lane B ${plan.counts.laneB})`,
    `Drafted ${stats.drafted}, sent ${stats.sent}, failed ${stats.failed}, Slack pings ${stats.slackPings}${stats.skipped ? `, skipped: **${stats.skipped}**` : ''}`,
    stats.suspectCategories?.length ? `Bad-read guard tripped: ${JSON.stringify(stats.suspectCategories)}` : '',
  ].filter(Boolean).join('\n\n');
  const full = `${summary}\n\n---\n\n${rows.map((m) => `### ${m.channel} to ${m.intended_to || m.to_address || m.recipient_dms_user_id} (${m.status}, lane ${m.lane}, ${m.kind})\n**${m.subject || ''}**\n\n${m.body}\n`).join('\n')}`;
  writeFileSync('report.md', full);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n\nFull drafts are in the \`report\` artifact.\n`);
  console.log(summary);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
