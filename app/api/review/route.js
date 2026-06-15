import { requireUser, unauthorized } from "@/lib/session";
import { db, logEvent } from "@/lib/supabase";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { data: records } = await db.from("outreach_records")
    .select("*, contacts(name, email, campaign, issue)")
    .eq("user_id", user.id)
    .eq("status", "needs_review")
    .order("last_action_at", { ascending: false });

  const enriched = await Promise.all((records || []).map(async (rec) => {
    const { data: events } = await db.from("outreach_history")
      .select("payload, created_at")
      .eq("outreach_id", rec.id)
      .eq("action", "reply_classified")
      .order("created_at", { ascending: false })
      .limit(1);
    return { ...rec, reply_messages: events?.[0]?.payload?.messages || [] };
  }));

  return Response.json({ records: enriched });
}

export async function POST(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { id, decision } = await req.json();
  // decision: resolved | replied (= active, still ongoing) | declined (= no_reply, back to followup queue)

  const { data: rec } = await db.from("outreach_records").select("*").eq("id", id).eq("user_id", user.id).single();
  if (!rec) return Response.json({ error: "Not found" }, { status: 404 });

  const now = new Date().toISOString();
  const patch = { last_action_at: now };

  const newStatus = decision === "resolved" ? "resolved"
    : decision === "replied" ? "active"
    : "no_reply";

  patch.status = newStatus;
  if (newStatus === "resolved") patch.resolved_by = user.id;
  if (newStatus === "active") patch.replied_at = rec.replied_at || now;
  if (newStatus === "no_reply") { patch.reply_classification = null; patch.reply_confidence = null; patch.message_notes = null; }

  await db.from("outreach_records").update(patch).eq("id", id);
  await logEvent({ outreachId: id, userId: user.id, action: "status_changed", prevStatus: rec.status, newStatus, payload: { via: "review", decision } });
  return Response.json({ ok: true });
}
