import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { data } = await db.from("outreach_records")
    .select("*, contacts(id, name, email, campaign, issue)")
    .eq("user_id", user.id)
    .eq("status", "no_reply")
    .order("reached_out_at", { ascending: true });
  return Response.json({ records: data || [] });
}
