import { db, logEvent } from "./supabase";
import { threadReplies, dmHistorySince } from "./slack";
import { threadRepliesFrom } from "./gmail";
import { classifyReply } from "./claude";

export async function checkOneRecord(rec, owner) {
  const c = rec.contacts;

  if (["resolved", "needs_review"].includes(rec.status)) {
    return { newStatus: rec.status, skipped: true };
  }
  if (!rec.channel) {
    return { newStatus: rec.status, skipped: true, error: "No channel - outreach not sent yet" };
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
      const threaded = await threadReplies(owner, rec.slack_channel_id, rec.slack_message_ts);
      if (threaded.length > 0) {
        messages = threaded.map(m => m.text || "(no text)");
        deterministic = true;
      } else {
        const loose = await dmHistorySince(owner, rec.slack_channel_id, rec.slack_message_ts);
        messages = loose.map(m => m.text || "(no text)").filter(Boolean);
        deterministic = false;
      }
    }
  } catch (e) {
    console.error("checkOneRecord error:", e.message);
    return { newStatus: rec.status, error: e.message };
  }

  const now = new Date().toISOString();

  if (!messages.length) {
    await db.from("outreach_records").update({ status: "no_reply", last_action_at: now }).eq("id", rec.id);
    await logEvent({ outreachId: rec.id, userId: owner.id, action: "reply_checked", prevStatus: rec.status, newStatus: "no_reply" });
    return { newStatus: "no_reply" };
  }

  const result = await classifyReply({ campaign: c.campaign, issue: c.issue, messages });

  let newStatus;
  if (!deterministic && result.confidence < 0.5) {
    newStatus = "needs_review";
  } else if (result.classification === "unrelated" && !deterministic) {
    newStatus = "no_reply";
  } else if (result.classification === "resolved" && result.confidence >= 0.75) {
    newStatus = "resolved_auto";
  } else {
    newStatus = "replied";
  }

  const patch = {
    status: newStatus,
    last_action_at: now,
    reply_classification: result.classification,
    reply_confidence: result.confidence,
    message_notes: result.summary,
    replied_at: now,
  };

  await db.from("outreach_records").update(patch).eq("id", rec.id);

  // Store full messages in history so they're always retrievable
  await logEvent({
    outreachId: rec.id, userId: owner.id,
    action: "reply_classified",
    prevStatus: rec.status, newStatus,
    payload: {
      classification: result.classification,
      confidence: result.confidence,
      summary: result.summary,
      deterministic,
      messages, // ← full message list stored here
    },
  });

  return { newStatus, classification: result.classification, summary: result.summary, messages };
}
