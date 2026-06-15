import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";

export async function PATCH(req, { params }) {
  const user = await requireUser();
  if (!user) return unauthorized();

  // Only allow editing if outreach is still pending
  const { data: outreach } = await db.from("outreach_records")
    .select("status, user_id").eq("contact_id", params.id).eq("user_id", user.id).single();

  if (!outreach) return Response.json({ error: "Not found" }, { status: 404 });
  if (outreach.status !== "pending") {
    return Response.json({ error: "Cannot edit after outreach has been sent" }, { status: 400 });
  }

  const body = await req.json();
  const allowed = ["name", "email", "campaign", "issue"];
  const patch = {};
  for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k] || null;
  patch.updated_at = new Date().toISOString();

  await db.from("contacts").update(patch).eq("id", params.id).eq("user_id", user.id);
  return Response.json({ ok: true });
}
