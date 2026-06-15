import { db, logEvent } from "./supabase";
import { threadReplies, dmHistorySince } from "./slack";
import { threadRepliesFrom } from "./gmail";
import { classifyReply } from "./claude";

export async function checkOneRecord(rec, owner) {
  const c = rec.contacts;

  // Skip statuses that don't need checking
  if (["resolved", "escalated", "pending"].includes(rec.status)) {
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
      if (!rec.slack_channel_id || !rec.slack_message_ts) {
        return { newStatus: rec.status, skipped: true, error: "Missing Slack anchor" };
      }

      // Layer 1: thread replies to our exact message
      const threaded = await threadReplies(owner, rec.slack_channel_id, rec.slack_message_ts);
      // Filter: only messages NOT from us (owner's slack user id)
      const ownerSlackId = owner.slack_user_id;
      const pocReplies = threaded.filter(m => m.user !== ownerSlackId);

      if (pocReplies.length > 0) {
        messages = pocReplies.map(m => m.text || "(no text)");
        deterministic = true;
      } else {
        // Layer 2: DM history since our send — filter out our own messages
        const loose = await dmHistorySince(owner, rec.slack_channel_id, rec.slack_message_ts);
        const pocMessages = loose.filter(m => m.user !== ownerSlackId);
        messages = pocMessages.map(m => m.text || "(no text)").filter(Boolean);
        deterministic = false;
      }
    }
  } catch (e) {
    console.error("checkOneRecord error:", e.message);
    return { newStatus: rec.status, error: e.message };
  }

  const now = new Date().toISOString();

  if (!messages.length) {
    const newStatus = "no_reply";
    await db.from("outreach_records").update({ status: newStatus, last_action_at: now }).eq("id", rec.id);
    await logEvent({ outreachId: rec.id, userId: owner.id, action: "reply_checked", prevStatus: rec.status, newStatus });
    return { newStatus };
  }

  // We have messages from the POC — classify just to understand context
  // But we NEVER auto-resolve. Status becomes "active", user decides next step.
  const result = await classifyReply({ campaign: c.campaign, issue: c.issue, messages });

  // If very low confidence and not deterministic → needs_review
  // Otherwise → active (regardless of classification — user decides resolution)
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
