// Reads replies (Gmail threads we started, Slack DMs we opened) and bounces, and applies the effects.
// All I/O is injected (`store`, `senders`, `llm`), so this is testable without a database or network.
//
// Safety rules: only threads/channels the nudge system created are read (the website enforces this
// too); each incoming message is stored once with its true timestamp; replies never resolve an issue;
// a message the model could not read stays unprocessed and is retried next run; a monthly spend cap
// stops model calls (messages are still stored and queued for reading).

import { cleanReply, isAutoReply, addressOf } from './cleanText.js';
import { buildPrompt } from './llm.js';
import { effectsFor } from './effects.js';
import { istDate } from './time.js';

export function makePersonResolver(people) {
  const active = people.filter((p) => !p.is_deleted && p.email && /@wldd\.in$/i.test(p.email));
  return (text) => {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return null;
    const byEmail = active.filter((p) => p.email.toLowerCase() === addressOf(t));
    if (byEmail.length === 1) return { id: byEmail[0].dms_user_id };
    const exact = active.filter((p) => (p.name || '').trim().toLowerCase() === t);
    if (exact.length === 1) return { id: exact[0].dms_user_id };
    if (exact.length > 1) return { ambiguous: true };
    const tokens = t.split(/\s+/).filter((x) => x.length > 1);
    if (tokens.length < 2) return active.filter((p) => (p.name || '').toLowerCase().split(/\s+/)[0] === t).length ? { ambiguous: true } : null;
    const loose = active.filter((p) => tokens.every((tok) => (p.name || '').toLowerCase().includes(tok)));
    return loose.length === 1 ? { id: loose[0].dms_user_id } : loose.length > 1 ? { ambiguous: true } : null;
  };
}

/** Bounces: mark the person unreachable so we stop emailing a dead address, and tell the owner via the website. */
export async function processBounces({ store, senders, peopleByEmail }) {
  let marked = 0;
  const res = await senders.bounces();
  for (const b of res.bounces || []) {
    for (const addr of b.recipients) {
      const p = peopleByEmail.get(addr);
      if (!p || p.unreachable_at) continue;
      await store.markUnreachable(p.dms_user_id, `Email bounced: ${b.subject || 'delivery failure'}`.slice(0, 200));
      await store.addReviewItem({ kind: 'send_failed', note: `${p.name} (${addr}) has an address that bounced. Emails to them are paused until you fix it (clear "unreachable" on the person).` });
      marked++;
    }
  }
  return marked;
}

export async function readReplies({ store, senders, interpret, apiKey, now, settings, people, issuesById, senderEmail, log = () => {} }) {
  const stats = { threadsRead: 0, newMessages: 0, interpreted: 0, effects: 0, reviewItems: 0, skippedCap: 0, llmErrors: 0, bounces: 0, cost: 0 };
  const todayIst = istDate(now);
  const own = String(senderEmail || '').toLowerCase();
  const peopleById = new Map(people.map((p) => [p.dms_user_id, p]));
  const peopleByEmail = new Map(people.filter((p) => p.email).map((p) => [p.email.toLowerCase(), p]));
  const resolvePerson = makePersonResolver(people);
  const cap = Number(settings.llm_monthly_cap_usd ?? 3);
  let spent = await store.monthLlmSpend(now);
  let capNoted = false;

  try { stats.bounces = await processBounces({ store, senders, peopleByEmail }); } catch (e) { log(`bounce check failed: ${e.message}`); }

  const handle = async ({ channel, externalId, threadRef, from, receivedAt, rawText, headers, senderPerson, ownerId, outs }) => {
    let row = await store.getMessageIn(channel, externalId);
    if (!row) {
      const fromOwner = !!senderPerson && senderPerson.dms_user_id === ownerId;
      const text = cleanReply(rawText);
      const auto = channel === 'email' && isAutoReply({ from, subject: headers.subject, autoSubmitted: headers.autoSubmitted, text });
      const id = await store.insertMessageIn({
        channel, external_id: externalId, thread_ref: threadRef, sender_address: from, sender_dms_user_id: senderPerson?.dms_user_id || null,
        received_at: new Date(receivedAt).toISOString(), clean_text: text, raw_text: String(rawText || '').slice(0, 6000),
        in_reply_to_message_out_id: outs.at(-1)?.id || null, from_owner: fromOwner, headers,
        processed_at: auto || !text ? new Date().toISOString() : null,
      });
      stats.newMessages++;
      if (auto || !text) return;
      row = { id, clean_text: text, from_owner: fromOwner, processed_at: null };
    }
    if (row.processed_at) return;

    // Items from the latest reminder that was sent before this reply, that are still open.
    const before = outs.filter((o) => new Date(o.sent_at) <= new Date(receivedAt));
    const ref = before.at(-1) || outs[0];
    const items = (ref?.items || []).filter((i) => issuesById.has(i.issue_id)).map((i) => {
      const iss = issuesById.get(i.issue_id);
      return { n: i.item_no, issueId: i.issue_id, category: iss.category, campaign_name: iss.campaign_name, ownerId: iss.owner_dms_user_id };
    });
    if (!items.length) { await store.markProcessed(row.id); return; }   // everything already resolved by Mongo

    if (spent >= cap) {
      stats.skippedCap++;
      if (!capNoted) { capNoted = true; await store.addReviewItem({ kind: 'low_confidence', note: `Monthly reply-reading budget ($${cap}) is used up. New replies are stored but not read until next month or you raise llm_monthly_cap_usd.` }); }
      return;
    }

    let result;
    try {
      const prompt = buildPrompt({ todayIst, items, replyText: row.clean_text, fromOwner: row.from_owner, senderName: senderPerson?.name });
      result = await interpret({ apiKey, prompt });
    } catch (e) {
      stats.llmErrors++; log(`interpret failed: ${e.message}`);
      return;                                                            // stays unprocessed; retried next run
    }
    spent += result.costUsd; stats.cost += result.costUsd; stats.interpreted++;

    const rows = [];
    for (const [idx, interp] of result.items.entries()) {
      const eff = effectsFor(interp, {
        todayIst, items, fromOwner: row.from_owner, senderId: senderPerson?.dms_user_id || null, holdCaps: settings.hold_caps, resolvePerson,
      });
      for (const e of eff.effects) { await store.applyEffect(e, row.id, todayIst, now.toISOString()); stats.effects++; }
      for (const r of eff.review) { await store.addReviewItem({ ...r, kind: r.kind, issue_id: r.issueId, message_in_id: row.id, note: r.note }); stats.reviewItems++; }
      const target = interp.target_person ? resolvePerson(interp.target_person) : null;
      rows.push({
        message_in_id: row.id, issue_id: eff.issueIds.length === 1 ? eff.issueIds[0] : null, intent: interp.intent,
        promised_date: /^\d{4}-\d{2}-\d{2}$/.test(interp.promised_date || '') ? interp.promised_date : null,
        target_dms_user_id: target?.id || null, target_text: interp.target_person || null, evidence: String(interp.evidence || '').slice(0, 300),
        confidence: interp.confidence, needs_review: eff.needsReview, model: result.model,
        tokens_in: idx === 0 ? result.tokensIn : 0, tokens_out: idx === 0 ? result.tokensOut : 0, cost_usd: idx === 0 ? result.costUsd : 0,
      });
    }
    await store.insertInterpretations(rows);
    await store.markProcessed(row.id);
  };

  // Email threads
  const threads = await store.replyThreads(now);
  for (const t of threads) {
    let msgs;
    try { msgs = (await senders.readThread(t.threadId)).messages; } catch (e) { log(`thread ${t.threadId}: ${e.message}`); continue; }
    stats.threadsRead++;
    const startedAt = Math.min(...t.outs.map((o) => new Date(o.sent_at).getTime()));
    for (const m of msgs) {
      const from = addressOf(m.from);
      if (from === own || m.internalDate < startedAt) continue;
      await handle({
        channel: 'email', externalId: m.id, threadRef: t.threadId, from, receivedAt: m.internalDate, rawText: m.text,
        headers: { subject: m.subject, autoSubmitted: m.autoSubmitted, to: m.to, cc: m.cc },
        senderPerson: peopleByEmail.get(from) || null, ownerId: t.recipientId, outs: t.outs,
      });
    }
  }

  // Slack DMs (only conversations we opened with the one-time ping)
  for (const c of await store.slackConversations(now)) {
    let res;
    try { res = await senders.slackHistory({ dmChannelId: c.channelId, oldest: c.oldest }); } catch (e) { log(`slack ${c.channelId}: ${e.message}`); continue; }
    if (!res.ok) { log(`slack ${c.channelId}: ${res.error}`); continue; }
    const owner = peopleById.get(c.recipientId);
    for (const m of res.messages) {
      if (!owner?.slack_user_id || m.user !== owner.slack_user_id) continue;        // only the owner's own messages
      await handle({
        channel: 'slack', externalId: `${c.channelId}:${m.ts}`, threadRef: c.channelId, from: m.user, receivedAt: Number(m.ts) * 1000,
        rawText: m.text, headers: {}, senderPerson: owner, ownerId: c.recipientId, outs: c.outs,
      });
    }
  }
  return stats;
}
