// Sends one nudge (email or Slack DM) on behalf of the connected owner, for the GitHub Actions
// worker. Not a user-facing endpoint: every request must carry a fresh HMAC signature made with the
// Supabase service key, and only company addresses are accepted.
import { db } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";
import { verifyRequest, processSendRequest } from "@/lib/nudgeSend.mjs";

export const maxDuration = 30;

export async function POST(req) {
  const raw = await req.text();
  const authorised = verifyRequest({
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
    ts: req.headers.get("x-nudge-timestamp"),
    rawBody: raw,
    signature: req.headers.get("x-nudge-signature"),
  });
  if (!authorised) return Response.json({ error: "unauthorized" }, { status: 401 });

  let body;
  try { body = JSON.parse(raw); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }

  try {
    const { data: setting, error: sErr } = await db.from("settings").select("value").eq("key", "sender_user_email").single();
    if (sErr) throw new Error(`settings: ${sErr.message}`);
    const { data: sender, error: uErr } = await db.from("users")
      .select("gmail_address,gmail_refresh_token,slack_access_token").eq("email", setting.value).single();
    if (uErr) throw new Error(`sender: ${uErr.message}`);

    const result = await processSendRequest(body, sender, {
      decrypt,
      google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET },
    });
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 502 });
  }
}
