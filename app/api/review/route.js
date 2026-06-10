import { requireUser, unauthorized } from "@/lib/session";
import { db, logEvent } from "@/lib/supabase";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { data } = await db.from("outreach_records")
    .select("*, contacts(name, email, campaign, issue)")
    .eq("user_id", user.id)
    .in("status", ["needs_review", "resolved_auto"])
    .order("last_action_at", { ascending: false });
  return Response.json({ records: data || [] });
}

export async function POST(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { id, decision } = await req.json(); // decision: replied | resolved | awaiting_reply (= not a real reply)
  const { data: rec } = await db.from("outreach_records").select("*").eq("id", id).eq("user_id", user.id).single();
  if (!rec) return Response.json({ error: "Not found" }, { status: 404 });
  const patch = { status: decision, last_action_at: new Date().toISOString() };
  if (decision === "resolved") patch.resolved_by = user.id;
  if (decision === "replied") patch.replied_at = rec.replied_at || new Date().toISOString();
  if (decision === "awaiting_reply") { patch.reply_classification = null; patch.reply_confidence = null; patch.message_notes = null; }
  await db.from("outreach_records").update(patch).eq("id", id);
  await logEvent({ outreachId: id, userId: user.id, action: "status_changed", prevStatus: rec.status, newStatus: decision, payload: { via: "review" } });
  return Response.json({ ok: true });
}
