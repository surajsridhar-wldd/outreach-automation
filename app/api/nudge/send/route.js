// Sends one nudge (email or Slack DM) on behalf of the connected owner, for the GitHub Actions
// worker. Not a user-facing endpoint: every request must carry a fresh HMAC signature made with the
// Supabase service key, and only company addresses are accepted.
import { db } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";
import { interpretReply } from "@/worker/lib/llm.js";
import { sendIssues } from "@/lib/ledgerSend.mjs";
import { verifyRequest, processSendRequest, processReadRequest, READ_TYPES } from "@/lib/nudgeSend.mjs";

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
    const { data: cfg, error: sErr } = await db.from("settings").select("key,value").in("key", ["sender_user_email", "paused"]);
    if (sErr) throw new Error(`settings: ${sErr.message}`);
    const setting = { value: cfg.find((r) => r.key === "sender_user_email")?.value };
    // The pause switch stops every send immediately, even in the middle of a run.
    if (cfg.find((r) => r.key === "paused")?.value === true) return Response.json({ error: "paused" }, { status: 503 });
    const { data: sender, error: uErr } = await db.from("users")
      .select("gmail_address,gmail_refresh_token,slack_access_token").eq("email", setting.value).single();
    if (uErr) throw new Error(`sender: ${uErr.message}`);

    // The tracker's "send now", callable by the worker for the end-to-end check.
    if (body.type === "send_issues") {
      if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 25) return Response.json({ error: "1 to 25 ids" }, { status: 400 });
      const r = await sendIssues(body.ids);
      return Response.json(r, { status: r.error ? r.status : 200 });
    }

    // Reply interpretation uses the website's own Anthropic key (Claude Haiku), so the worker needs no key.
    if (body.type === "interpret") {
      if (typeof body.prompt !== "string" || body.prompt.length > 8000) return Response.json({ error: "bad prompt" }, { status: 400 });
      return Response.json(await interpretReply({ apiKey: process.env.ANTHROPIC_API_KEY, prompt: body.prompt }));
    }

    // Read requests (replies, bounces). Restricted to threads/channels the nudge system itself created.
    if (READ_TYPES.has(body.type)) {
      const guards = {
        allowThread: async (id) => {
          const { data } = await db.from("messages_out").select("id").eq("gmail_thread_id", id).limit(1);
          return !!data?.length;
        },
        allowChannel: async (id) => {
          const { data } = await db.from("dms_people").select("dms_user_id").eq("slack_dm_channel_id", id).limit(1);
          return !!data?.length;
        },
      };
      const readResult = await processReadRequest(body, sender, {
        decrypt, guards,
        google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET },
      });
      return Response.json(readResult);
    }

    // A retried request with the same key can never send twice: the key is claimed BEFORE sending.
    const key = typeof body.idempotencyKey === "string" ? body.idempotencyKey : null;
    if (key) {
      const { error: claimErr } = await db.from("send_log").insert({ idempotency_key: key, status: "pending" });
      if (claimErr) {
        const { data: prev } = await db.from("send_log").select("status,result").eq("idempotency_key", key).single();
        if (prev?.status === "done") return Response.json({ ...prev.result, duplicate: true });
        return Response.json({ error: "this request was already started and could not be confirmed; check the Sent folder" }, { status: 409 });
      }
    }

    let result;
    try {
      result = await processSendRequest(body, sender, {
        decrypt,
        google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET },
      });
    } catch (sendErr) {
      if (key) await db.from("send_log").delete().eq("idempotency_key", key); // nothing was sent: allow a retry
      throw sendErr;
    }
    if (key) await db.from("send_log").update({ status: "done", result }).eq("idempotency_key", key);
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 502 });
  }
}
