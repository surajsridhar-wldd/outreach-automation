import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  if (user.role !== "admin") return Response.json({ error: "Admin only" }, { status: 403 });
  const { data } = await db.from("users").select("id, name, email, role, avatar_url, created_at").order("created_at");
  return Response.json({ users: data || [] });
}

// Toggle any user's role. Safety: can't demote the last remaining admin.
export async function PATCH(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  if (user.role !== "admin") return Response.json({ error: "Admin only" }, { status: 403 });
  const { userId, role } = await req.json();
  if (!["admin", "member"].includes(role)) return Response.json({ error: "Invalid role" }, { status: 400 });

  if (role === "member") {
    const { count } = await db.from("users").select("*", { count: "exact", head: true }).eq("role", "admin");
    const { data: target } = await db.from("users").select("role").eq("id", userId).single();
    if (target?.role === "admin" && count <= 1) {
      return Response.json({ error: "Cannot demote the last admin. Promote someone else first." }, { status: 400 });
    }
  }
  await db.from("users").update({ role }).eq("id", userId);
  return Response.json({ ok: true });
}
