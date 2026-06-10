import { decrypt } from "./crypto";

const SCOPES = "users:read,users:read.email,chat:write,im:write,im:read";

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

export async function getSlackUser(token, slackUserId) {
  return slackGet(token, "users.info", { user: slackUserId });
}

export async function lookupByEmail(user, email) {
  const r = await slackGet(userToken(user), "users.lookupByEmail", { email });
  return r.ok ? r.user.id : null;
}

// Open (or fetch) the DM channel with a slack user
export async function openDm(user, slackUserId) {
  const r = await slackApi(userToken(user), "conversations.open", { users: slackUserId });
  return r.ok ? r.channel.id : null;
}

export async function sendDm(user, channelId, text) {
  return slackApi(userToken(user), "chat.postMessage", { channel: channelId, text });
}

// Layer 1: replies threaded to our message
export async function threadReplies(user, channelId, ts) {
  const r = await slackGet(userToken(user), "conversations.replies", { channel: channelId, ts });
  if (!r.ok) return [];
  return (r.messages || []).filter((m) => m.ts !== ts && !m.bot_id);
}

// Layer 2: loose messages in the DM after our send
export async function dmHistorySince(user, channelId, oldestTs) {
  const r = await slackGet(userToken(user), "conversations.history", {
    channel: channelId,
    oldest: oldestTs,
    inclusive: "false",
    limit: "50",
  });
  if (!r.ok) return [];
  return (r.messages || []).filter((m) => !m.bot_id);
}
