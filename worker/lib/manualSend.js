// "Send now": the owner picks issues (drafts he imported, or open ones) and sends them immediately, on any day.
// It uses exactly the same message building, threading, state updates and reply reading as an automated run, so a
// manual nudge and an automated one are indistinguishable afterwards. Differences: it ignores the send window,
// the circuit breaker, the entry cap, holds and the "already messaged today" rule, because a person asked for it.

import { executePlan } from './executor.js';
import { resolveRecipients } from './recipients.js';
import { istDate } from './time.js';
import { DEFAULT_SETTINGS } from './planner.js';

/**
 * issues: issue rows (draft or open). overridesByIssue: Map issueId -> issue_owners rows.
 * Returns { plan, skipped:[{issueId, why}] }
 */
export function buildManualPlan({ issues, overridesByIssue = new Map(), redirects = new Map(), now, settings = {} }) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const byRecipient = new Map();
  const skipped = [];
  for (const issue of issues) {
    const { ownerIds, needsOwner } = resolveRecipients(issue, overridesByIssue.get(issue.id) || [], redirects);
    if (needsOwner || !ownerIds.length) { skipped.push({ issueId: issue.id, why: 'no owner to send to' }); continue; }
    const item = { issueId: issue.id, category: issue.category, nextN: (issue.nudge_count || 0) + 1, firstSeenAt: issue.first_seen_at, final: false };
    for (const rid of ownerIds) byRecipient.set(rid, [...(byRecipient.get(rid) || []), item]);
  }
  const messages = [...byRecipient.entries()].map(([recipientId, items]) => ({
    recipientId, lane: 'B',
    kind: items.every((i) => i.nextN === 1) ? 'first' : 'followup',
    ccManager: items.some((i) => i.nextN >= s.managerFromNudge),
    final: false, items,
  }));
  return {
    plan: { today: istDate(now), monthEnd: false, finalNoticeDay: false, messages, deferredRecipientIds: [], rampDone: false },
    skipped,
  };
}

/** Loads what the executor needs, builds the plan and sends. `store`/`senders` are injected (Supabase + Gmail in production). */
export async function sendNow({ issues, overrides = [], redirects = new Map(), people, store, senders, now = new Date(), settings = {}, channel = 'email' }) {
  const overridesByIssue = new Map();
  for (const o of overrides) overridesByIssue.set(o.issue_id, [...(overridesByIssue.get(o.issue_id) || []), o]);
  const { plan, skipped } = buildManualPlan({ issues, overridesByIssue, redirects, now, settings });
  const stats = await executePlan({
    plan, mode: 'live', manual: true, channel, now, runId: null, store, senders,
    issuesById: new Map(issues.map((i) => [i.id, i])),
    people: new Map(people.map((p) => [p.dms_user_id, p])),
    settings,
  });
  return { ...stats, skippedNoOwner: skipped };
}
