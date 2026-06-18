import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";

export async function GET(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const campaign = new URL(req.url).searchParams.get("name");
  if (!campaign) return Response.json({ error: "Provide campaign name" }, { status: 400 });

  // All outreach records for this campaign belonging to this user
  const { data: records } = await db.from("outreach_records")
    .select("*, contacts(id, name, email, campaign, issue)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  const filtered = (records || []).filter(r => r.contacts?.campaign === campaign);

  // Get history for all these records
  const ids = filtered.map(r => r.id);
  const { data: history } = ids.length
    ? await db.from("outreach_history").select("*").in("outreach_id", ids).order("created_at", { ascending: true })
    : { data: [] };

  // Get latest reply messages from history
  const replyMessages = {};
  for (const h of (history || [])) {
    if (h.action === "reply_classified" && h.payload?.messages?.length) {
      replyMessages[h.outreach_id] = h.payload.messages;
    }
  }

  return Response.json({
    campaign,
    records: filtered.map(r => ({ ...r, reply_messages: replyMessages[r.id] || [] })),
    history: history || [],
    stats: {
      total: filtered.length,
      sent: filtered.filter(r => r.status !== "pending").length,
      active: filtered.filter(r => r.status === "active").length,
      resolved: filtered.filter(r => r.status === "resolved").length,
      escalated: filtered.filter(r => r.status === "escalated").length,
      no_reply: filtered.filter(r => r.status === "no_reply" || r.status === "stalled").length,
    }
  });
}
