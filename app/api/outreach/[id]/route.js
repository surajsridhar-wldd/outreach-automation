import { requireUser, unauthorized } from "@/lib/session";
import { db, logEvent } from "@/lib/supabase";

export async function PATCH(req, { params }) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { status, notes } = await req.json();

  const { data: rec } = await db.from("outreach_records").select("*").eq("id", params.id).single();
  if (!rec) return Response.json({ error: "Not found" }, { status: 404 });
  if (rec.user_id !== user.id && user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

  const patch = { last_action_at: new Date().toISOString() };
  if (status) {
    patch.status = status;
    if (status === "resolved") patch.resolved_by = user.id;
  }
  if (notes !== undefined) patch.message_notes = notes;

  await db.from("outreach_records").update(patch).eq("id", rec.id);
  await logEvent({
    outreachId: rec.id, userId: user.id,
    action: status === "resolved" ? "resolved" : notes !== undefined ? "note_added" : "status_changed",
    prevStatus: rec.status, newStatus: status || rec.status,
  });
  return Response.json({ ok: true });
}

export async function DELETE(req, { params }) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { data: rec } = await db.from("outreach_records")
    .select("user_id, contact_id").eq("id", params.id).single();
  if (!rec) return Response.json({ error: "Not found" }, { status: 404 });
  if (rec.user_id !== user.id && user.role !== "admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  await db.from("outreach_records").delete().eq("id", params.id);

  const { count } = await db.from("outreach_records")
    .select("*", { count: "exact", head: true })
    .eq("contact_id", rec.contact_id);
  if (count === 0) await db.from("contacts").delete().eq("id", rec.contact_id);

  return Response.json({ ok: true });
}
