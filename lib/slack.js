import { decrypt } from "./crypto";

const SCOPES = "users:read,users:read.email,chat:write,im:write,im:read,im:history";

export function slackAuthUrl() {
  const params = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    user_scope: SCOPES,
    redirect_uri: `${process.env.NEXT_PUBLIC_BASE_URL}/api/auth/slack/callback`,
  });
  return `https://slack.com/oauth/v2/authorize?${params}`;
}

export async function exchangeSlackCode(code) {
  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: `${process.env.NEXT_PUBLIC_BASE_URL}/api/auth/slack/callback`,
    }),
  });
  return res.json();
}

async function slackApi(token, method, params = {}) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(params),
  });
  return res.json();
}

async function slackGet(token, method, params = {}) {
  const qs = new URLSearchParams(params);
  const res = await fetch(`https://slack.com/api/${method}?${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.json();
}

export function userToken(user) {
  return decrypt(user.slack_access_token);
}

export async function lookupByEmail(user, email) {
  const r = await slackGet(userToken(user), "users.lookupByEmail", { email });
  return r.ok ? r.user.id : null;
}

export async function lookupByName(user, name) {
  const nameLower = name.toLowerCase().trim();
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const params = { limit: "200" };
    if (cursor) params.cursor = cursor;
    const r = await slackGet(userToken(user), "users.list", params);
    if (!r.ok) { console.error("users.list error:", r.error); return null; }
    const members = (r.members || []).filter(m => !m.deleted && !m.is_bot && m.id !== "USLACKBOT");
    for (const m of members) {
      const realName = (m.real_name || "").toLowerCase();
      const dispName = (m.profile?.display_name || "").toLowerCase();
      const fullName = (m.profile?.real_name_normalized || "").toLowerCase();
      if (realName === nameLower || dispName === nameLower || fullName === nameLower) return m.id;
    }
    for (const m of members) {
      const realName = (m.real_name || "").toLowerCase();
      const parts = nameLower.split(" ");
      if (parts.length >= 2 && parts.every(p => realName.includes(p))) return m.id;
    }
    cursor = r.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  return null;
}

export async function openDm(user, slackUserId) {
  const r = await slackApi(userToken(user), "conversations.open", { users: slackUserId });
  return r.ok ? r.channel.id : null;
}

export async function sendDm(user, channelId, text) {
  const r = await slackApi(userToken(user), "chat.postMessage", { channel: channelId, text });
  // Always return ts as a string — Slack ts has 6 decimal digits, must never be parsed as a number
  if (r.ok && r.ts) r.ts = String(r.ts);
  return r;
}

// Layer 1: thread replies to our exact message — excludes our own messages (any of our prior sends in this thread)
export async function threadReplies(user, channelId, ts, ownerSlackId) {
  const r = await slackGet(userToken(user), "conversations.replies", { channel: channelId, ts: String(ts), limit: "100" });
  if (!r.ok) { console.error("conversations.replies error:", r.error); return []; }
  return (r.messages || []).filter(m =>
    m.ts !== String(ts) &&
    m.subtype !== "bot_message" &&
    m.user !== ownerSlackId
  );
}

// Layer 2: any message in the DM channel since the very first message we sent (not the latest follow-up anchor)
// This ensures a reply sent BEFORE a follow-up is never missed.
export async function dmHistorySince(user, channelId, oldestTs, ownerSlackId) {
  const r = await slackGet(userToken(user), "conversations.history", {
    channel: channelId,
    oldest: String(oldestTs),
    inclusive: "false",
    limit: "100",
  });
  if (!r.ok) { console.error("conversations.history error:", r.error, "channel:", channelId); return []; }
  return (r.messages || []).filter(m =>
    m.subtype !== "bot_message" &&
    m.type === "message" &&
    m.user !== ownerSlackId
  );
}
