import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";

export async function GET(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const scope = new URL(req.url).searchParams.get("scope");
  let q = db.from("poc_stats").select("*").order("total_outreaches", { ascending: false });
  if (!(scope === "all" && user.role === "admin")) q = q.eq("user_id", user.id);
  const { data, error } = await q;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  // For admin global view, attach user names
  let userMap = {};
  if (scope === "all" && user.role === "admin") {
    const { data: users } = await db.from("users").select("id, name");
    userMap = Object.fromEntries((users || []).map((u) => [u.id, u.name]));
  }
  return Response.json({ stats: data || [], userMap });
}
