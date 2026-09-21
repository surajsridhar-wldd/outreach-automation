import { db } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";
import { makeDirectSender } from "@/lib/directSender.mjs";
import { sendNow } from "@/worker/lib/manualSend.js";
import { executorStore, loadIssuesByIds, loadRedirects } from "@/worker/lib/store.js";

// Sends the given issues right now (the tracker's "Send now" / "Nudge now"). Shared by the tracker API and by the signed
// worker route that the end-to-end check uses, so both run exactly the same code.
export async function sendIssues(ids, { channel = 'email' } = {}) {
  const { data: cfg } = await db.from("settings").select("key,value").in("key", ["sender_user_email", "paused"]);
  const c = Object.fromEntries((cfg || []).map((r) => [r.key, r.value]));
  if (c.paused === true) return { status: 409, error: "Sending is paused. Press Resume first." };
  const issues = await loadIssuesByIds(db, ids);
  if (!issues.length) return { status: 400, error: "Nothing to send (already resolved?)" };
  const { data: sender } = await db.from("users").select("name,email,gmail_address,gmail_refresh_token,slack_access_token").eq("email", c.sender_user_email).single();
  if (!sender) return { status: 500, error: "Sender account not found" };
  const issueIds = issues.map((i) => i.id);
  const { data: overrides } = await db.from("issue_owners").select("*").in("issue_id", issueIds).eq("active", true);
  const redirects = await loadRedirects(db);
  const ownerIds = [...new Set([...issues.map((i) => i.owner_dms_user_id), ...(overrides || []).map((o) => o.dms_user_id), ...redirects.values()].filter(Boolean))];
  const { data: people } = await db.from("dms_people").select("*").in("dms_user_id", ownerIds);
  const senders = makeDirectSender({ db, decrypt, google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET }, sender });
  const r = await sendNow({
    issues, overrides: overrides || [], redirects, people: people || [], store: executorStore(db), senders, channel: channel === 'slack' ? 'slack' : 'email',
    settings: { senderName: sender.name, senderEmail: sender.gmail_address },
  });
  return { status: 200, sent: r.sent, failed: r.failed, skippedNoEmail: r.skippedNoEmail, skippedUnreachable: r.skippedUnreachable || 0, slackPings: r.slackPings, notSent: r.skippedNoOwner };
}
