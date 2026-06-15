import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";

// GET all contacts for current user
export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { data } = await db.from("contacts").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
  return Response.json({ contacts: data || [] });
}
