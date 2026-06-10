import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";

export async function GET(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const url = new URL(req.url);
  const statusFilter = url.searchParams.get("status"); // comma list
  let q = db.from("outreach_records")
    .select("*, contacts(name, email, campaign, issue)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (statusFilter) q = q.in("status", statusFilter.split(","));
  const { data, error } = await q;
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ records: data });
}
