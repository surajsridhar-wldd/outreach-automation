import { db, logEvent } from "./supabase";
import { threadReplies, dmAllHistory } from "./slack";
import { threadRepliesFrom } from "./gmail";
import { classifyReply } from "./claude";

export async function checkOneRecord(rec, owner) {
  const c = rec.contacts;

  if (["resolved", "escalated", "pending", "monitoring"].includes(rec.status)) {
    return { newStatus: rec.status, skipped: true };
  }
  if (!rec.channel) {
    return { newStatus: rec.status, skipped: true, error: "Not sent yet" };
  }

  let messages = [];
  let deterministic = false;

  try {
    if (rec.channel === "email" && rec.gmail_thread_id) {
      const sinceMs = new Date(rec.reached_out_at).getTime();
      messages = await threadRepliesFrom(owner, rec.gmail_thread_id, c.email, sinceMs);
      deterministic = true;

    } else if (rec.channel === "slack") {
      if (!rec.slack_channel_id) {
        return { newStatus: rec.status, skipped: true, error: "Missing Slack channel" };
      }
      const pocSlackId = c.slack_user_id;
      if (!pocSlackId) {
        return { newStatus: rec.status, skipped: true, error: "POC's Slack ID not on file — resend or edit contact" };
      }

      // Layer 1: real thread replies (rare in DMs, but check anyway — channels use this)
      if (rec.slack_message_ts) {
        const threaded = await threadReplies(owner, rec.slack_channel_id, rec.slack_message_ts);
        const fromPoc = threaded.filter(m => m.user === pocSlackId);
        if (fromPoc.length > 0) {
          messages = fromPoc.map(m => m.text || "(no text)");
          deterministic = true;
        }
      }

      // Layer 2: full DM history, filtered by INCLUSION — only messages whose author
      // is the POC's known Slack user ID count. This is robust even if our own
      // user id is ever wrong/stale, since we never rely on excluding "not us".
      if (!messages.length) {
        const all = await dmAllHistory(owner, rec.slack_channel_id, 100);
        const fromPoc = all.filter(m => m.user === pocSlackId);
        messages = fromPoc.map(m => m.text || "(no text)").filter(Boolean);
        deterministic = false;
      }
    }
  } catch (e) {
    console.error("checkOneRecord error:", e.message);
    return { newStatus: rec.status, error: e.message };
  }

  const now = new Date().toISOString();

  if (!messages.length) {
    // No POC messages found in this check. If the record was already "active" (they replied
    // before), do NOT silently revert it back to no_reply — that would erase a real reply.
    // Only set no_reply if we're checking from sent/followup/stalled (i.e. truly never replied yet).
    if (rec.status === "active") {
      await logEvent({ outreachId: rec.id, userId: owner.id, action: "reply_checked", prevStatus: rec.status, newStatus: rec.status, payload: { note: "Re-checked — no new messages since last reply. Status unchanged." } });
      return { newStatus: rec.status, note: "No new messages — still active" };
    }
    const newStatus = "no_reply";
    await db.from("outreach_records").update({ status: newStatus, last_action_at: now }).eq("id", rec.id);
    await logEvent({ outreachId: rec.id, userId: owner.id, action: "reply_checked", prevStatus: rec.status, newStatus });
    return { newStatus };
  }

  // We have real messages from the POC (verified by Slack user ID match, or email thread match).
  // Classify ONLY for context — never auto-resolve. Once active, status never silently reverts.
  const result = await classifyReply({ campaign: c.campaign, issue: c.issue, messages });
  const newStatus = (!deterministic && result.confidence < 0.4) ? "needs_review" : "active";

  await db.from("outreach_records").update({
    status: newStatus,
    last_action_at: now,
    reply_classification: result.classification,
    reply_confidence: result.confidence,
    message_notes: result.summary,
    replied_at: now,
  }).eq("id", rec.id);

  await logEvent({
    outreachId: rec.id, userId: owner.id,
    action: "reply_classified",
    prevStatus: rec.status, newStatus,
    payload: { classification: result.classification, confidence: result.confidence, summary: result.summary, deterministic, messages },
  });

  return { newStatus, summary: result.summary, messages };
}
