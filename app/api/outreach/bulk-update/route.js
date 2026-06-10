import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";
import { checkOneRecord } from "@/lib/checker";

export async function POST(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { ids, action } = await req.json(); // action: check_reply | resolve
  if (!Array.isArray(ids) || !ids.length) return Response.json({ error: "Provide ids[]" }, { status: 400 });

  const results = [];
  for (const id of ids) {
    const { data: rec } = await db.from("outreach_records")
      .select("*, contacts(*)").eq("id", id).eq("user_id", user.id).single();
    if (!rec) { results.push({ id, ok: false }); continue; }
    if (action === "check_reply") {
      const r = await checkOneRecord(rec, user);
      results.push({ id, ok: true, ...r });
    } else if (action === "resolve") {
      const { logEvent } = await import("@/lib/supabase");
      await db.from("outreach_records").update({ status: "resolved", resolved_by: user.id, last_action_at: new Date().toISOString() }).eq("id", id);
      await logEvent({ outreachId: id, userId: user.id, action: "resolved", prevStatus: rec.status, newStatus: "resolved" });
      results.push({ id, ok: true });
    }
  }
  return Response.json({ results });
}
