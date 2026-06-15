import { requireUser, unauthorized } from "@/lib/session";
import { db, logEvent } from "@/lib/supabase";
import { checkOneRecord } from "@/lib/checker";

export async function POST(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { ids, action } = await req.json();
  if (!Array.isArray(ids) || !ids.length) return Response.json({ error: "Provide ids[]" }, { status: 400 });

  const results = [];

  if (action === "delete") {
    for (const id of ids) {
      const { data: rec } = await db.from("outreach_records")
        .select("user_id, contact_id").eq("id", id).single();
      if (!rec) { results.push({ id, ok: false }); continue; }
      if (rec.user_id !== user.id && user.role !== "admin") { results.push({ id, ok: false }); continue; }
      await db.from("outreach_records").delete().eq("id", id);
      const { count } = await db.from("outreach_records")
        .select("*", { count: "exact", head: true }).eq("contact_id", rec.contact_id);
      if (count === 0) await db.from("contacts").delete().eq("id", rec.contact_id);
      results.push({ id, ok: true });
    }
    return Response.json({ results });
  }

  for (const id of ids) {
    const { data: rec } = await db.from("outreach_records")
      .select("*, contacts(*)").eq("id", id).eq("user_id", user.id).single();
    if (!rec) { results.push({ id, ok: false }); continue; }
    if (action === "check_reply") {
      const r = await checkOneRecord(rec, user);
      results.push({ id, ok: true, ...r });
    } else if (action === "resolve") {
      await db.from("outreach_records").update({ status: "resolved", resolved_by: user.id, last_action_at: new Date().toISOString() }).eq("id", id);
      await logEvent({ outreachId: id, userId: user.id, action: "resolved", prevStatus: rec.status, newStatus: "resolved" });
      results.push({ id, ok: true });
    }
  }
  return Response.json({ results });
}
