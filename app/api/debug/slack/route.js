import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

export async function GET(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const url = new URL(req.url);
  const outreachId = url.searchParams.get("id");
  if (!outreachId) return Response.json({ error: "Provide ?id=" }, { status: 400 });

  const token = decrypt(user.slack_access_token);
  const result = { user_slack_id: user.slack_user_id, has_token: !!token };

  const { data: rec } = await db.from("outreach_records").select("*, contacts(*)").eq("id", outreachId).single();
  if (!rec) return Response.json({ error: "Record not found" });

  result.record = {
    status: rec.status,
    slack_channel_id: rec.slack_channel_id,
    slack_message_ts: rec.slack_message_ts,
    slack_message_ts_type: typeof rec.slack_message_ts,
    reached_out_at: rec.reached_out_at,
  };

  if (rec.slack_channel_id) {
    const histRes = await fetch(
      `https://slack.com/api/conversations.history?channel=${rec.slack_channel_id}&oldest=${rec.slack_message_ts}&inclusive=false&limit=20`,
      { headers: { authorization: `Bearer ${token}` } }
    ).then(r => r.json());
    result.historyTest = histRes;

    const repliesRes = await fetch(
      `https://slack.com/api/conversations.replies?channel=${rec.slack_channel_id}&ts=${rec.slack_message_ts}&limit=20`,
      { headers: { authorization: `Bearer ${token}` } }
    ).then(r => r.json());
    result.repliesTest = repliesRes;

    // ALSO fetch history with NO oldest filter to see absolutely everything in the DM
    const allHistRes = await fetch(
      `https://slack.com/api/conversations.history?channel=${rec.slack_channel_id}&limit=30`,
      { headers: { authorization: `Bearer ${token}` } }
    ).then(r => r.json());
    result.allMessagesInChannel = (allHistRes.messages || []).map(m => ({
      user: m.user, ts: m.ts, text: m.text?.slice(0, 80), subtype: m.subtype, bot_id: m.bot_id,
    }));
  }

  return Response.json(result);
}
