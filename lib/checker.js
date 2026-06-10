import { db, logEvent } from "./supabase";
import { threadReplies, dmHistorySince } from "./slack";
import { threadRepliesFrom } from "./gmail";
import { classifyReply } from "./claude";

export async function checkOneRecord(rec, owner) {
  const c = rec.contacts;

  // Allow checking any non-resolved status
  if (["resolved", "resolved_auto", "needs_review"].includes(rec.status)) {
    return { newStatus: rec.status, skipped: true };
  }

  // Must have been sent via a channel
  if (!rec.channel) {
    return { newStatus: rec.status, skipped: true, error: "No channel set — outreach not sent yet" };
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
        return { newStatus: rec.status, skipped: true, error: "Missing Slack channel/message anchor" };
      }

      // Layer 1: thread replies
      const threaded = await threadReplies(owner, rec.slack_channel_id, rec.slack_message_ts);
      console.log(`Thread replies for ${rec.id}:`, threaded.length);

      if (threaded.length > 0) {
        messages = threaded.map((m) => m.text || "(no text)");
        deterministic = true;
      } else {
        // Layer 2: any DM message after our send
        const loose = await dmHistorySince(owner, rec.slack_channel_id, rec.slack_message_ts);
        console.log(`Loose DMs for ${rec.id}:`, loose.length, loose.map(m => m.text));
        messages = loose.map((m) => m.text || "(no text)").filter(Boolean);
        deterministic = false;
      }
    }
  } catch (e) {
    console.error("checkOneRecord error:", e.message);
    return { newStatus: rec.status, error: e.message };
  }

  const now = new Date().toISOString();

  if (!messages.length) {
    // No reply found
    const newStatus = "no_reply";
    await db.from("outreach_records").update({ status: newStatus, last_action_at: now }).eq("id", rec.id);
    await logEvent({
      outreachId: rec.id, userId: owner.id, action: "reply_checked",
      prevStatus: rec.status, newStatus,
      payload: { channel: rec.channel, checked_at: now }
    });
    return { newStatus };
  }

  // Classify the messages
  const result = await classifyReply({ campaign: c.campaign, issue: c.issue, messages });
  console.log(`Classification for ${rec.id}:`, result);

  let newStatus;
  if (!deterministic && result.confidence < 0.5) {
    // Very uncertain and not deterministic → needs human review
    newStatus = "needs_review";
  } else if (result.classification === "unrelated" && !deterministic) {
    // Clearly unrelated loose DM → still no reply on this issue
    newStatus = "no_reply";
  } else if (result.classification === "resolved" && result.confidence >= 0.75) {
    newStatus = "resolved_auto";
  } else if (result.classification === "unrelated" && deterministic) {
    // Even in thread, classified as unrelated — treat as replied but flag
    newStatus = "replied";
  } else {
    newStatus = "replied";
  }

  const patch = {
    status: newStatus,
    last_action_at: now,
    reply_classification: result.classification,
    reply_confidence: result.confidence,
    message_notes: result.summary,
  };
  if (["replied", "resolved_auto", "resolved"].includes(newStatus)) {
    patch.replied_at = now;
  }

  await db.from("outreach_records").update(patch).eq("id", rec.id);
  await logEvent({
    outreachId: rec.id, userId: owner.id, action: "reply_classified",
    prevStatus: rec.status, newStatus,
    payload: { classification: result.classification, confidence: result.confidence, summary: result.summary, deterministic, messages },
  });
  return { newStatus, classification: result.classification, summary: result.summary };
}
