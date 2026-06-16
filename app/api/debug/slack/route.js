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
  const result = { owner_slack_id: user.slack_user_id, has_token: !!token };

  const { data: rec } = await db.from("outreach_records").select("*, contacts(*)").eq("id", outreachId).single();
  if (!rec) return Response.json({ error: "Record not found" });

  result.record = {
    status: rec.status,
    slack_channel_id: rec.slack_channel_id,
    slack_message_ts: rec.slack_message_ts,
    poc_slack_user_id: rec.contacts?.slack_user_id,
    poc_name: rec.contacts?.name,
  };

  if (rec.slack_channel_id) {
    const histRes = await fetch(
      `https://slack.com/api/conversations.history?channel=${rec.slack_channel_id}&limit=50`,
      { headers: { authorization: `Bearer ${token}` } }
    ).then(r => r.json());

    result.allMessagesInChannel = (histRes.messages || []).map(m => ({
      user: m.user,
      is_poc: m.user === rec.contacts?.slack_user_id,
      is_owner: m.user === user.slack_user_id,
      ts: m.ts,
      text: m.text?.slice(0, 100),
      subtype: m.subtype,
    }));

    result.diagnosis = result.allMessagesInChannel.some(m => m.is_poc)
      ? "✅ POC messages found — should classify as active"
      : rec.contacts?.slack_user_id
        ? "⚠ No messages match the POC's stored Slack ID — they may have a different account, or slack_user_id is wrong"
        : "❌ POC has no slack_user_id on file — reply detection cannot work until this is fixed (try re-sending or editing contact)";
  }

  return Response.json(result);
}
