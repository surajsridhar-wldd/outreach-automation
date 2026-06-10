import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";

export async function GET(req) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const url = new URL(req.url);
  const outreachId = url.searchParams.get("id");
  const token = decrypt(user.slack_access_token);
  if (!token) return Response.json({ error: "No slack token for this user" });

  const result = {};

  // 1. Auth test
  result.authTest = await fetch("https://slack.com/api/auth.test", {
    headers: { authorization: `Bearer ${token}` },
  }).then(r => r.json());

  if (outreachId) {
    const { data: rec } = await db.from("outreach_records")
      .select("*, contacts(*)")
      .eq("id", outreachId)
      .eq("user_id", user.id)
      .single();

    if (!rec) return Response.json({ error: "Record not found" });

    result.record = {
      id: rec.id, status: rec.status,
      slack_channel_id: rec.slack_channel_id,
      slack_message_ts: rec.slack_message_ts,
      reached_out_at: rec.reached_out_at,
    };

    if (rec.slack_channel_id) {
      // Test history
      result.historyTest = await fetch(
        `https://slack.com/api/conversations.history?channel=${rec.slack_channel_id}&oldest=${rec.slack_message_ts}&inclusive=false&limit=20`,
        { headers: { authorization: `Bearer ${token}` } }
      ).then(r => r.json());

      // Test replies
      result.repliesTest = await fetch(
        `https://slack.com/api/conversations.replies?channel=${rec.slack_channel_id}&ts=${rec.slack_message_ts}&limit=20`,
        { headers: { authorization: `Bearer ${token}` } }
      ).then(r => r.json());
    }
  }

  return Response.json(result);
}
