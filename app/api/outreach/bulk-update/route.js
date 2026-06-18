import { requireUser, unauthorized } from "@/lib/session";
import { db, logEvent } from "@/lib/supabase";
import { checkOneRecord } from "@/lib/checker";

export async function POST(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { ids, action, payload } = await req.json();
  if (!Array.isArray(ids) || !ids.length) return Response.json({ error: "Provide ids[]" }, { status: 400 });

  const results = [];

  for (const id of ids) {
    try {
      if (action === "delete") {
        const { data: rec } = await db.from("outreach_records").select("user_id, contact_id").eq("id", id).single();
        if (!rec || (rec.user_id !== user.id && user.role !== "admin")) { results.push({ id, ok: false, error: "not found or forbidden" }); continue; }
        const { error: delErr } = await db.from("outreach_records").delete().eq("id", id);
        if (delErr) throw new Error(delErr.message);
        const { count } = await db.from("outreach_records").select("*", { count: "exact", head: true }).eq("contact_id", rec.contact_id);
        if (count === 0) await db.from("contacts").delete().eq("id", rec.contact_id);
        results.push({ id, ok: true });

      } else {
        const { data: rec } = await db.from("outreach_records")
          .select("*, contacts(*)").eq("id", id).eq("user_id", user.id).single();
        if (!rec) { results.push({ id, ok: false, error: "not found" }); continue; }

        if (action === "check_reply") {
          const r = await checkOneRecord(rec, user);
          if (r.error) { results.push({ id, ok: false, name: rec.contacts?.name, error: r.error }); continue; }
          results.push({ id, ok: true, name: rec.contacts?.name, ...r });

        } else if (action === "resolve") {
          const { error: upErr } = await db.from("outreach_records").update({ status: "resolved", resolved_by: user.id, last_action_at: new Date().toISOString() }).eq("id", id);
          if (upErr) throw new Error(upErr.message);
          await logEvent({ outreachId: id, userId: user.id, action: "resolved", prevStatus: rec.status, newStatus: "resolved" });
          results.push({ id, ok: true });

        } else if (action === "monitor") {
          const note = payload?.note || "";
          const { error: upErr } = await db.from("outreach_records").update({
            status: "monitoring", message_notes: note || rec.message_notes, last_action_at: new Date().toISOString(),
          }).eq("id", id);
          if (upErr) throw new Error(upErr.message);
          await logEvent({ outreachId: id, userId: user.id, action: "status_changed", prevStatus: rec.status, newStatus: "monitoring", payload: { note } });
          results.push({ id, ok: true });

        } else if (action === "escalate") {
          const note = payload?.note || "";
          const escalateTo = payload?.escalateTo || null;
          const { error: upErr } = await db.from("outreach_records").update({
            status: "escalated", message_notes: note, last_action_at: new Date().toISOString(),
          }).eq("id", id);
          if (upErr) throw new Error(upErr.message);
          await logEvent({ outreachId: id, userId: user.id, action: "status_changed", prevStatus: rec.status, newStatus: "escalated", payload: { note, escalateTo } });
          results.push({ id, ok: true });

        } else if (action === "set_status") {
          const newStatus = payload?.status;
          if (!newStatus) { results.push({ id, ok: false, error: "no status" }); continue; }
          const { error: upErr } = await db.from("outreach_records").update({ status: newStatus, last_action_at: new Date().toISOString() }).eq("id", id);
          if (upErr) throw new Error(upErr.message);
          await logEvent({ outreachId: id, userId: user.id, action: "status_changed", prevStatus: rec.status, newStatus, payload });
          results.push({ id, ok: true });
        }
      }
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
  }

  return Response.json({ results });
}
