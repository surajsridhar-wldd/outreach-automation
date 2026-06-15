import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";

export async function DELETE(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { id } = await req.json();
  if (!id) return Response.json({ error: "Provide id" }, { status: 400 });

  // Only allow delete if user owns it (or admin)
  const { data: rec } = await db.from("outreach_records").select("user_id, contact_id").eq("id", id).single();
  if (!rec) return Response.json({ error: "Not found" }, { status: 404 });
  if (rec.user_id !== user.id && user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

  // Delete outreach record (history cascades)
  await db.from("outreach_records").delete().eq("id", id);
  // Also delete the contact if it has no other outreach records
  const { count } = await db.from("outreach_records").select("*", { count: "exact", head: true }).eq("contact_id", rec.contact_id);
  if (count === 0) await db.from("contacts").delete().eq("id", rec.contact_id);

  return Response.json({ ok: true });
}
