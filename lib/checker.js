import { db, logEvent } from "./supabase";
import { threadReplies, dmAllHistory } from "./slack";
import { threadRepliesFrom } from "./gmail";
import { attributeReplies } from "./claude";

// checkOneRecord — checks a single outreach record for replies.
//
// Attribution model (per spec §1):
//   1. Deterministic: Slack thread-reply to our exact message, or email thread match.
//      These are certain — the message provably belongs to THIS outreach.
//   2. Loose Slack DM: every candidate message passes an LLM RELEVANCE GATE first.
//      "Is this about ANY of the person's open issues?" Chit-chat -> discarded.
//      Relevant -> attributed to the matching issue. Ambiguous -> needs_review.
//
// Timing is NEVER used as evidence a message is relevant — only to bound the fetch.
// We never auto-resolve; a resolved-type reply only sets the record active.
export async function checkOneRecord(rec, owner) {
  const c = rec.contacts;

  // Snoozed records CAN be manually reply-checked (this is a manual action). Only
  // resolved/escalated/pending are skipped. Auto-follow-ups still skip snoozed (the cron
  // never includes snoozed in its follow-up query), so the "no auto follow-ups while
  // snoozed" guarantee is preserved.
  if (["resolved", "escalated", "pending"].includes(rec.status)) {
    return { newStatus: rec.status, skipped: true };
  }
  if (!rec.channel) {
    return { newStatus: rec.status, skipped: true, error: "Not sent yet" };
  }

  // ── Gather candidate messages from the POC, with a deterministic flag ──────────
  let candidates = []; // [{ id, text }]
  let deterministic = false;

  try {
    if (rec.channel === "email" && rec.gmail_thread_id) {
      const sinceMs = new Date(rec.reached_out_at).getTime();
      const msgs = await threadRepliesFrom(owner, rec.gmail_thread_id, c.email, sinceMs);
      candidates = msgs.map((m, i) => ({ id: `email-${i}`, text: typeof m === "string" ? m : (m.text || "") }));
      deterministic = true; // email thread is a hard scope

    } else if (rec.channel === "slack") {
      if (!rec.slack_channel_id) return { newStatus: rec.status, skipped: true, error: "Missing Slack channel" };
      const pocSlackId = c.slack_user_id;
      if (!pocSlackId) return { newStatus: rec.status, skipped: true, error: "POC's Slack ID not on file — resend or edit contact" };

      // Layer 1 — real thread replies to our exact message. Deterministic.
      if (rec.slack_message_ts) {
        const threaded = await threadReplies(owner, rec.slack_channel_id, rec.slack_message_ts);
        const fromPoc = threaded.filter(m => m.user === pocSlackId);
        if (fromPoc.length > 0) {
          candidates = fromPoc.map((m, i) => ({ id: m.ts || `thread-${i}`, text: m.text || "" }));
          deterministic = true;
        }
      }

      // Layer 2 — loose DM history. NOT deterministic; must pass the relevance gate.
      // Bound the fetch to messages at/after our first outreach ts (purely to limit
      // how far back we look — NOT as evidence of relevance).
      if (!candidates.length) {
        const all = await dmAllHistory(owner, rec.slack_channel_id, 100);
        const anchorTs = rec.first_message_ts ? parseFloat(rec.first_message_ts) : 0;
        candidates = all
          .filter(m => m.user === pocSlackId)
          .filter(m => !anchorTs || parseFloat(m.ts || "0") >= anchorTs)
          .map(m => ({ id: m.ts || Math.random().toString(36), text: m.text || "" }))
          .filter(m => m.text.trim().length > 0);
        deterministic = false;
      }
    }
  } catch (e) {
    console.error("checkOneRecord error:", e.message);
    return { newStatus: rec.status, error: e.message };
  }

  const now = new Date().toISOString();

  // ── No candidates at all ──────────────────────────────────────────────────────
  if (!candidates.length) {
    return finalizeNoReply(rec, owner, now);
  }

  // ── Deterministic path: messages provably belong to this outreach ─────────────
  // No relevance gate needed — Slack/email already scoped them to THIS message.
  if (deterministic) {
    const messages = candidates.map(m => m.text);
    return applyReply(rec, owner, now, {
      messages,
      type: inferTypeFromText(messages),
      summary: messages[messages.length - 1].slice(0, 200),
      deterministic: true,
    });
  }

  // ── Loose path: relevance gate via LLM, attributing among ALL the POC's open issues ─
  // Attribution is per-person: fetch the POC's other open records so the LLM can
  // route each message to the right issue (or mark unrelated / ambiguous).
  const openIssues = await getOpenIssuesForContact(rec.contact_id);
  if (!openIssues.find(o => String(o.recordId) === String(rec.id))) {
    openIssues.push({ recordId: rec.id, campaign: c.campaign, issue: c.issue });
  }

  const { attributions } = await attributeReplies({ messages: candidates, openIssues });

  // Keep only messages the LLM judged relevant to THIS record.
  const mineRelevant = attributions.filter(a => a.relevant && String(a.recordId) === String(rec.id));
  // Relevant-but-unattributable messages (recordId null) -> this record goes to review
  // only if some ambiguous message could plausibly be ours. We send to review when there
  // is at least one relevant message that couldn't be attributed AND it isn't clearly someone else's.
  const ambiguous = attributions.filter(a => a.relevant && a.recordId === null);

  if (mineRelevant.length > 0) {
    const messages = mineRelevant.map(a => textForId(candidates, a.messageId)).filter(Boolean);
    const type = pickStrongestType(mineRelevant);
    const summary = mineRelevant[mineRelevant.length - 1].summary || messages[messages.length - 1]?.slice(0, 200) || "";
    return applyReply(rec, owner, now, { messages, type, summary, deterministic: false });
  }

  if (ambiguous.length > 0) {
    // Relevant to some issue but the model couldn't pick which — human decides.
    const messages = ambiguous.map(a => textForId(candidates, a.messageId)).filter(Boolean);
    const { error: upErr } = await db.from("outreach_records").update({
      status: "needs_review", last_action_at: now,
      message_notes: "Reply detected but could not be confidently matched to this issue — please review.",
    }).eq("id", rec.id);
    if (upErr) return { newStatus: rec.status, error: `DB update failed: ${upErr.message}` };
    await logEvent({
      outreachId: rec.id, userId: owner.id, action: "reply_classified",
      prevStatus: rec.status, newStatus: "needs_review",
      payload: { ambiguous: true, messages, summary: "Ambiguous attribution" },
    });
    return { newStatus: "needs_review", messages, note: "Ambiguous — sent to review" };
  }

  // No relevant messages (all chit-chat / unrelated) -> treat as no reply.
  return finalizeNoReply(rec, owner, now);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getOpenIssuesForContact(contactId) {
  const { data } = await db.from("outreach_records")
    .select("id, status, contacts(campaign, issue)")
    .eq("contact_id", contactId)
    .in("status", ["sent", "active", "no_reply", "followup", "stalled", "needs_review"]);
  return (data || []).map(r => ({ recordId: r.id, campaign: r.contacts?.campaign, issue: r.contacts?.issue }));
}

function textForId(candidates, id) {
  const m = candidates.find(c => String(c.id) === String(id));
  return m ? m.text : null;
}

function pickStrongestType(attrs) {
  // resolved > acknowledged > question > unrelated
  const order = ["resolved", "acknowledged", "question", "unrelated"];
  let best = "unrelated";
  for (const a of attrs) {
    if (order.indexOf(a.type) < order.indexOf(best)) best = a.type;
  }
  return best;
}

function inferTypeFromText(messages) {
  // Light heuristic for deterministic (threaded) replies where we skip the gate.
  const t = messages.join(" ").toLowerCase();
  if (/\b(done|fixed|resolved|sorted|completed|updated)\b/.test(t)) return "resolved";
  if (/\b(will|working on|on it|by (today|tonight|tomorrow|eod)|shortly)\b/.test(t)) return "acknowledged";
  if (/\?/.test(t)) return "question";
  return "acknowledged";
}

async function finalizeNoReply(rec, owner, now) {
  if (rec.status === "active") {
    await logEvent({ outreachId: rec.id, userId: owner.id, action: "reply_checked", prevStatus: rec.status, newStatus: rec.status, payload: { note: "Re-checked — no new relevant messages. Status unchanged." } });
    return { newStatus: rec.status, note: "No new relevant messages — still active" };
  }
  if (rec.status === "snoozed") {
    // Manually checking a snoozed record found nothing — leave it snoozed, don't yank
    // it back into the active flow just because you peeked.
    await logEvent({ outreachId: rec.id, userId: owner.id, action: "reply_checked", prevStatus: rec.status, newStatus: rec.status, payload: { note: "Re-checked while snoozed — no reply. Still snoozed." } });
    return { newStatus: rec.status, note: "No reply — still snoozed" };
  }
  const { error: upErr } = await db.from("outreach_records").update({ status: "no_reply", last_action_at: now }).eq("id", rec.id);
  if (upErr) { console.error("checkOneRecord update error:", upErr.message); return { newStatus: rec.status, error: `DB update failed: ${upErr.message}` }; }
  await logEvent({ outreachId: rec.id, userId: owner.id, action: "reply_checked", prevStatus: rec.status, newStatus: "no_reply" });
  return { newStatus: "no_reply" };
}

async function applyReply(rec, owner, now, { messages, type, summary, deterministic }) {
  const newStatus = "active"; // relevant reply -> active. Never auto-resolve.
  const { error: upErr } = await db.from("outreach_records").update({
    status: newStatus, last_action_at: now,
    reply_classification: type, reply_confidence: deterministic ? 1 : 0.8,
    message_notes: summary, replied_at: rec.replied_at || now,
  }).eq("id", rec.id);
  if (upErr) { console.error("checkOneRecord update error:", upErr.message); return { newStatus: rec.status, error: `Reply found but DB update failed: ${upErr.message}` }; }
  await logEvent({
    outreachId: rec.id, userId: owner.id, action: "reply_classified",
    prevStatus: rec.status, newStatus,
    payload: { classification: type, summary, deterministic, messages },
  });
  return { newStatus, summary, messages };
}
