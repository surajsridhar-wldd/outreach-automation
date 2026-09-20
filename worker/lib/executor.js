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
  settings = {}, // { allowlist: [], redirectTo, senderName, senderEmail, sendWindow: {start_hour,end_hour} }
}) {
  if (!MODES.includes(mode)) throw new Error(`Unknown mode "${mode}"`);
  const stats = {
    mode, planned: plan.messages.length, drafted: 0, sent: 0, failed: 0, slackPings: 0,
    skippedNoEmail: 0, skippedAlreadyToday: 0, managerMissing: 0, skipped: null, breakerLimit: null,
  };
  const real = mode === 'live' || mode === 'canary';
  const nowIso = now.toISOString();

  if (real) {
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
  const sentIssues = new Map();     // issueId -> nudge_count before this run
  const sentRecipients = [];
  const rehearsalMax = settings.rehearsalMax ?? 10;
  let rehearsalSent = 0;

  for (const m of plan.messages) {
    const person = people.get(m.recipientId);
    if (!person?.email) {
      stats.skippedNoEmail++;
      await store.addReviewItem({ kind: 'needs_owner', note: `No email address on file for DMS user ${m.recipientId}` });
      continue;
    }
    if (real && (await store.hasMessageToday(m.recipientId, plan.today))) { stats.skippedAlreadyToday++; continue; }

    const items = m.items.map((it) => {
      const issue = issuesById.get(it.issueId);
      return { ...it, ...issue, issueId: it.issueId, claimedDone: !!issue?.claimedDone };
    });
    const built = buildEmail(items, {
      name: person.name, senderName: settings.senderName, kind: m.kind, final: m.final,
      monthEnd: plan.monthEnd, finalNoticeDay: plan.finalNoticeDay,
      hasInvoice: items.some((i) => i.category === CATEGORY.INVOICE),
    });

    let cc = [];
    if (m.ccManager) {
      if (person.manager_email) cc = [person.manager_email];
      else {
        stats.managerMissing++;
        await store.addReviewItem({ kind: 'manager_missing', note: `${person.name} reached nudge 4+ but has no manager on file, so nobody was copied.` });
      }
    }

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
    await store.insertItems(built.itemOrder.map((issueId, idx) => ({
      message_out_id: messageId, issue_id: issueId, item_no: idx + 1, nudge_no: m.items.find((i) => i.issueId === issueId)?.nextN ?? null,
    })));

    if (!isReal && !rehearse) { stats.drafted++; continue; }

    try {
      const r = await senders.email({
        from: settings.senderEmail, to, cc: rehearse ? [] : cc, subject, body,
        threadId: threaded ? person.email_thread_id : undefined,
        inReplyTo: threaded ? person.email_rfc_message_id : undefined,
        references: threaded ? person.email_rfc_message_id : undefined,
      });
      await store.updateMessage(messageId, { status: 'sent', sent_at: nowIso, gmail_message_id: r.gmailMessageId, gmail_thread_id: r.threadId });
      stats.sent++;
      if (!isReal) { rehearsalSent++; continue; }              // rehearsal: no state change

      await store.savePersonThread(m.recipientId, { email_thread_id: r.threadId, email_rfc_message_id: r.rfcMessageId, email_subject: FIRST_SUBJECT });
      sentRecipients.push(m.recipientId);
      for (const it of m.items) sentIssues.set(it.issueId, issuesById.get(it.issueId)?.nudge_count ?? 0);

      // One short Slack ping, at the 3rd nudge only, pointing back to the email.
      if (m.items.some((i) => i.nextN === 3)) {
        const text = buildSlackPing({ name: person.name, count: m.items.length, emailDate: prettyDate(plan.today) });
        const slackId = await store.insertMessage({
          run_id: runId, recipient_dms_user_id: m.recipientId, channel: 'slack', lane: m.lane, kind: 'followup',
          status: 'sending', body: text, mode,
        });
        try {
          const s = await senders.slack({ person, text });
          await store.updateMessage(slackId, { status: s.ok ? 'sent' : 'failed', sent_at: nowIso, slack_ts: s.ts, slack_channel_id: s.channel, error: s.ok ? null : s.error });
          if (s.ok) {
            stats.slackPings++;
            await store.savePersonThread(m.recipientId, { slack_user_id: s.slackUserId, slack_dm_channel_id: s.channel });
          }
        } catch (e) {
          await store.updateMessage(slackId, { status: 'failed', error: e.message });
        }
      }
    } catch (e) {
      stats.failed++;
      await store.updateMessage(messageId, { status: 'failed', error: e.message });
      await store.addReviewItem({ kind: 'send_failed', note: `Email to ${person.email} failed: ${e.message}` });
    }
  }

  if (real && sentRecipients.length) {
    await store.applySent({
      issues: [...sentIssues].map(([id, nudgeCount]) => ({ id, nudgeCount })),
      recipientIds: sentRecipients,
      // The entry cap only exists in live mode; a canary must not age the real waiting queue.
      deferredIds: mode === 'live' ? plan.deferredRecipientIds : [],
      nowIso,
    });
  }
  return { ...stats, rampDone: mode === 'live' && plan.rampDone, todayIst: istDate(now) };
}
