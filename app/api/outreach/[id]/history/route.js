import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";

export async function GET(req, { params }) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { data: rec } = await db.from("outreach_records").select("user_id").eq("id", params.id).single();
  if (!rec) return Response.json({ error: "Not found" }, { status: 404 });
  if (rec.user_id !== user.id && user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });
  const { data } = await db.from("outreach_history").select("*").eq("outreach_id", params.id).order("created_at", { ascending: true });
  return Response.json({ events: data });
}
