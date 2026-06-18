import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";

// Editing is allowed at any stage now. The only caveat: changing the issue text
// after outreach has been sent won't retroactively change the message already sent —
// the UI surfaces a note about this. Email/campaign/name can always be corrected
// (e.g. adding an email after a Slack-only import so follow-ups/email become possible).
export async function PATCH(req, { params }) {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { data: contact } = await db.from("contacts").select("id").eq("id", params.id).eq("user_id", user.id).single();
  if (!contact) return Response.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const allowed = ["name", "email", "campaign", "issue"];
  const patch = {};
  for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k] || null;
  patch.updated_at = new Date().toISOString();

  await db.from("contacts").update(patch).eq("id", params.id).eq("user_id", user.id);
  return Response.json({ ok: true });
}
