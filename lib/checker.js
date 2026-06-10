import { db, logEvent } from "./supabase";
import { threadReplies, dmHistorySince } from "./slack";
import { threadRepliesFrom } from "./gmail";
import { classifyReply } from "./claude";

// Checks one outreach record for replies. Returns { newStatus, classification? }
export async function checkOneRecord(rec, owner) {
  const c = rec.contacts;
  if (!["sent", "awaiting_reply", "followup", "no_reply"].includes(rec.status)) {
    return { newStatus: rec.status, skipped: true };
  }

  let messages = [];
  let deterministic = false;

  try {
    if (rec.channel === "email" && rec.gmail_thread_id) {
      const sinceMs = new Date(rec.reached_out_at).getTime();
      messages = await threadRepliesFrom(owner, rec.gmail_thread_id, c.email, sinceMs);
      deterministic = true; // a reply in our exact thread is a reply to this outreach
    } else if (rec.channel === "slack" && rec.slack_channel_id && rec.slack_message_ts) {
      const threaded = await threadReplies(owner, rec.slack_channel_id, rec.slack_message_ts);
      if (threaded.length) {
        messages = threaded.map((m) => m.text);
        deterministic = true; // threaded to our exact message
      } else {
        const loose = await dmHistorySince(owner, rec.slack_channel_id, rec.slack_message_ts);
        messages = loose.map((m) => m.text);
        deterministic = false; // loose DM — needs classification
      }
    }
  } catch (e) {
    return { newStatus: rec.status, error: e.message };
  }

  const now = new Date().toISOString();

  if (!messages.length) {
    // No movement → mark no_reply (enters follow-up queue)
    if (rec.status === "sent" || rec.status === "awaiting_reply" || rec.status === "followup") {
      await db.from("outreach_records").update({ status: "no_reply", last_action_at: now }).eq("id", rec.id);
      await logEvent({ outreachId: rec.id, userId: owner.id, action: "reply_checked", prevStatus: rec.status, newStatus: "no_reply" });
      return { newStatus: "no_reply" };
    }
    await logEvent({ outreachId: rec.id, userId: owner.id, action: "reply_checked", prevStatus: rec.status, newStatus: rec.status });
    return { newStatus: rec.status };
  }

  // We have messages — classify (even deterministic ones benefit from resolved-vs-acknowledged detection)
  const result = await classifyReply({ campaign: c.campaign, issue: c.issue, messages });

  let newStatus;
  if (!deterministic && result.confidence < 0.6) {
    newStatus = "needs_review";
  } else if (result.classification === "unrelated" && !deterministic) {
    newStatus = rec.status === "sent" ? "no_reply" : rec.status; // unrelated chatter doesn't count
  } else if (result.classification === "resolved" && result.confidence >= 0.8) {
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
  };
  if (newStatus === "replied" || newStatus === "resolved_auto") patch.replied_at = now;

  await db.from("outreach_records").update(patch).eq("id", rec.id);
  await logEvent({
    outreachId: rec.id, userId: owner.id, action: "reply_classified",
    prevStatus: rec.status, newStatus,
    payload: { classification: result.classification, confidence: result.confidence, summary: result.summary, deterministic },
  });
  return { newStatus, classification: result.classification };
}
