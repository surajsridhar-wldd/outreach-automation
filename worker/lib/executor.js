// Turns a plan into messages, according to the run mode. All I/O goes through injected
// `store` and `senders`, so this file is fully testable without a database or network.
//
// Modes (the only thing that decides whether anything can reach a real person):
//   shadow    - compose and store drafts. Sends NOTHING. Does not change any state.
//   rehearsal - send the real emails, but ONLY to settings.redirectTo (the owner), each marked
//               with a banner saying who it would have gone to. Capped at settings.rehearsalMax
//               (default 10) so the owner's inbox is not flooded; the rest stay drafts. Does not
//               change any state.
//   canary    - send for real, but only to recipients on settings.allowlist; everyone else is
//               stored as a draft. State advances only for what was really sent.
//   live      - send for real to everyone the plan selected.
// Real sends (canary/live) additionally require the 11:00-19:00 IST working-day window and pass
// the circuit breaker; at most one message per person per day.

import { inSendWindow, istDate } from './time.js';
import { breakerCheck, CATEGORY } from './planner.js';
import { buildEmail, buildSlackPing, FIRST_SUBJECT, rehearsalBanner } from './templates.js';

export const MODES = ['shadow', 'rehearsal', 'canary', 'live'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const prettyDate = (dateStr) => `${Number(dateStr.slice(8, 10))} ${MONTHS[Number(dateStr.slice(5, 7)) - 1]}`;

export async function executePlan({
  plan, mode, now, runId, store, senders, issuesById, people,
  holidays = new Set(), recentRunCounts = [],
  manual = false, // the owner pressed "send now": no send window, no breaker, no once-a-day rule; everything else is identical
  settings = {}, // { allowlist: [], redirectTo, senderName, senderEmail, sendWindow: {start_hour,end_hour} }
}) {
  if (!MODES.includes(mode)) throw new Error(`Unknown mode "${mode}"`);
  const stats = {
    mode, planned: plan.messages.length, drafted: 0, sent: 0, failed: 0, slackPings: 0,
    skippedNoEmail: 0, skippedAlreadyToday: 0, managerMissing: 0, skipped: null, breakerLimit: null,
  };
  const real = mode === 'live' || mode === 'canary';
  if (manual && mode !== 'live') throw new Error('manual sends are live sends');
  const nowIso = now.toISOString();

  if (real && !manual) {
    const w = settings.sendWindow || { start_hour: 11, end_hour: 19 };
    if (!inSendWindow(now, holidays, w.start_hour, w.end_hour)) return { ...stats, skipped: 'outside_send_window' };
    const br = breakerCheck(plan.messages.length, recentRunCounts);
    stats.breakerLimit = br.limit;
    if (!br.ok) {
      await store.addReviewItem({ kind: 'send_failed', note: `Circuit breaker: run would message ${plan.messages.length} people (limit ${br.limit}). Nothing was sent.` });
      return { ...stats, skipped: 'circuit_breaker' };
    }
  }

  const allow = new Set((settings.allowlist || []).map((x) => String(x).toLowerCase()));
  const rehearsalMax = settings.rehearsalMax ?? 10;
  let rehearsalSent = 0;

  for (const m of plan.messages) {
    const person = people.get(m.recipientId);
    if (person?.unreachable_at) { stats.skippedUnreachable = (stats.skippedUnreachable || 0) + 1; continue; }
    if (!person?.email) {
      stats.skippedNoEmail++;
      await store.addReviewItem({ kind: 'needs_owner', note: `No email address on file for DMS user ${m.recipientId}` });
      continue;
    }
    if (real && !manual && (await store.hasMessageToday(m.recipientId, plan.today))) { stats.skippedAlreadyToday++; continue; }

    const items = m.items.map((it) => {
      const issue = issuesById.get(it.issueId);
      return { ...it, ...issue, issueId: it.issueId, claimedDone: !!(issue?.claimedDone || issue?.claimed_done_at) };
    });
    const built = buildEmail(items, {
      name: person.name, senderName: settings.senderName, kind: m.kind, final: m.final,
      monthEnd: plan.monthEnd, finalNoticeDay: plan.finalNoticeDay,
      hasInvoice: items.some((i) => i.category === CATEGORY.INVOICE),
    });

    let cc = [];
    if (m.ccManager) {
      const manager = person.manager_override_email || person.manager_email;
      if (manager) cc = [manager];
      else {
        stats.managerMissing++;
        await store.addReviewItem({ kind: 'manager_missing', note: `${person.name} reached nudge 4+ but has no manager on file, so nobody was copied.` });
      }
    }

    // Zero-cost-service reminders have always copied the inventory team.
    if (items.some((i) => i.category === CATEGORY.ZERO_COST) && settings.inventoryCc && !cc.includes(settings.inventoryCc)) cc = [...cc, settings.inventoryCc];

    const isReal = mode === 'live' || (mode === 'canary' && (allow.has(person.email.toLowerCase()) || allow.has(String(person.dms_user_id).toLowerCase())));
    const rehearse = mode === 'rehearsal' && rehearsalSent < rehearsalMax;
    const threaded = isReal && person.email_thread_id && person.email_rfc_message_id;
    const subject = rehearse ? `[REHEARSAL] ${FIRST_SUBJECT}` : threaded ? `Re: ${person.email_subject || FIRST_SUBJECT}` : FIRST_SUBJECT;
    const body = rehearse ? `${rehearsalBanner({ intendedTo: person.email, cc })}\n\n${built.body}` : built.body;
    const to = rehearse ? settings.redirectTo : person.email;

    const messageId = await store.insertMessage({
      run_id: runId, recipient_dms_user_id: m.recipientId, channel: 'email', lane: m.lane,
      kind: m.final ? 'final' : m.kind, status: isReal || rehearse ? 'sending' : 'draft',
      to_address: to, cc_addresses: rehearse ? [] : cc, subject, body, mode,
      intended_to: rehearse ? person.email : null,
    });
    await store.insertItems(m.items.map((it) => ({
      message_out_id: messageId, issue_id: it.issueId, item_no: built.itemNumbers[it.issueId] ?? null, nudge_no: it.nextN ?? null,
    })));

    if (!isReal && !rehearse) { stats.drafted++; continue; }

    // Only a failure of the SEND itself counts as "failed". Once the email has gone out, any
    // bookkeeping error below is allowed to abort the run: the message row stays 'sending' (later
    // flagged as unconfirmed), which is far safer than recording a delivered email as failed.
    let r;
    try {
      r = await senders.email({
        idempotencyKey: messageId,
        from: settings.senderEmail, to, cc: rehearse ? [] : cc, subject, body,
        threadId: threaded ? person.email_thread_id : undefined,
        inReplyTo: threaded ? person.email_rfc_message_id : undefined,
        references: threaded ? person.email_rfc_message_id : undefined,
      });
    } catch (e) {
      stats.failed++;
      await store.updateMessage(messageId, { status: 'failed', error: e.message });
      await store.addReviewItem({ kind: 'send_failed', note: `Email to ${person.email} failed: ${e.message}` });
      continue;
    }

    await store.updateMessage(messageId, { status: 'sent', sent_at: nowIso, gmail_message_id: r.gmailMessageId, gmail_thread_id: r.threadId });
    stats.sent++;
    if (!isReal) { rehearsalSent++; continue; }              // rehearsal: no state change

    await store.savePersonThread(m.recipientId, { email_thread_id: r.threadId, email_rfc_message_id: r.rfcMessageId, email_subject: FIRST_SUBJECT });
    // State moves forward immediately, message by message, so a run killed half way never
    // forgets a message that really went out.
    await store.applySent({
      issues: m.items.map((it) => ({ id: it.issueId, nudgeCount: issuesById.get(it.issueId)?.nudge_count ?? 0 })),
      recipientIds: [m.recipientId], deferredIds: [], nowIso,
    });

    // "Done" claims that Mongo does not confirm are counted; the second one goes to the human queue.
    for (const it of items.filter((i) => i.claimedDone)) {
      const n = await store.recordFalseDone?.(it.issueId);
      if (n >= 2) await store.addReviewItem({ kind: 'false_done_twice', issue_id: it.issueId, note: `${person.name} has said "done" twice for ${it.campaign_name}, but DMS still shows it as pending.` });
    }

    // One short Slack ping, at the 3rd nudge only, pointing back to the email. A failure here never
    // affects the email that already went out.
    if (m.items.some((i) => i.nextN === 3)) {
      const text = buildSlackPing({ name: person.name, count: m.items.length, emailDate: prettyDate(plan.today) });
      const slackId = await store.insertMessage({
        run_id: runId, recipient_dms_user_id: m.recipientId, channel: 'slack', lane: m.lane, kind: 'followup',
        status: 'sending', body: text, mode,
      });
      try {
        const sl = await senders.slack({ person, text, idempotencyKey: slackId });
        await store.updateMessage(slackId, { status: sl.ok ? 'sent' : 'failed', sent_at: nowIso, slack_ts: sl.ts, slack_channel_id: sl.channel, error: sl.ok ? null : sl.error });
        if (sl.ok) {
          stats.slackPings++;
          await store.savePersonThread(m.recipientId, { slack_user_id: sl.slackUserId, slack_dm_channel_id: sl.channel });
        }
      } catch (e) {
        await store.updateMessage(slackId, { status: 'failed', error: e.message });
      }
    }
  }

  // The entry cap only exists in live mode; a canary must not age the real waiting queue.
  if (mode === 'live' && plan.deferredRecipientIds.length) {
    await store.applySent({ issues: [], recipientIds: [], deferredIds: plan.deferredRecipientIds, nowIso });
  }
  return { ...stats, rampDone: mode === 'live' && plan.rampDone, todayIst: istDate(now) };
}
