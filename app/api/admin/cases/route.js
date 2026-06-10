import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  if (user.role !== "admin") return Response.json({ error: "Admin only" }, { status: 403 });
  const { data } = await db.from("outreach_records")
    .select("*, contacts(name, email, campaign, issue), users:user_id(name)")
    .order("created_at", { ascending: false })
    .limit(500);
  return Response.json({ records: data || [] });
}
