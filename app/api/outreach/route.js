import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";

export async function GET(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const url = new URL(req.url);
  const statusFilter = url.searchParams.get("status");

  let q = db.from("outreach_records")
    .select("*, contacts(id, name, email, campaign, issue)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (statusFilter) q = q.in("status", statusFilter.split(","));

  const { data, error } = await q;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  // Enrich active + needs_review records with reply messages from history
  const records = data || [];
  const toEnrich = records.filter(r => ["needs_review", "active"].includes(r.status));
  if (toEnrich.length > 0) {
    const ids = toEnrich.map(r => r.id);
    const { data: events } = await db.from("outreach_history")
      .select("outreach_id, payload")
      .in("outreach_id", ids)
      .eq("action", "reply_classified")
      .order("created_at", { ascending: false });

    const msgMap = {};
    for (const e of (events || [])) {
      if (!msgMap[e.outreach_id] && e.payload?.messages?.length) {
        msgMap[e.outreach_id] = e.payload.messages;
      }
    }
    records.forEach(r => {
      if (["needs_review", "active"].includes(r.status)) r.reply_messages = msgMap[r.id] || [];
    });
  }

  return Response.json({ records });
}
