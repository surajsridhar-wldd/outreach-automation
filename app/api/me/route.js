import { requireUser, unauthorized } from "@/lib/session";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  return Response.json({
    id: user.id,
    name: user.name,
    email: user.email,
    avatar_url: user.avatar_url,
    role: user.role,
    gmail_connected: !!user.gmail_refresh_token,
    gmail_address: user.gmail_address,
    settings: user.settings,
  });
}

export async function PATCH(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const body = await req.json();
  const { db } = await import("@/lib/supabase");
  await db.from("users").update({ settings: { ...user.settings, ...body.settings } }).eq("id", user.id);
  return Response.json({ ok: true });
}
