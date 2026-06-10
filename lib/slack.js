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

export async function openDm(user, slackUserId) {
  const r = await slackApi(userToken(user), "conversations.open", { users: slackUserId });
  return r.ok ? r.channel.id : null;
}

export async function sendDm(user, channelId, text) {
  return slackApi(userToken(user), "chat.postMessage", { channel: channelId, text });
}

// Layer 1: thread replies to our exact message
export async function threadReplies(user, channelId, ts) {
  const r = await slackGet(userToken(user), "conversations.replies", { channel: channelId, ts, limit: "50" });
  if (!r.ok) {
    console.error("conversations.replies error:", r.error);
    return [];
  }
  // Filter out the original message (same ts) and any bot messages
  return (r.messages || []).filter((m) => m.ts !== ts && m.subtype !== "bot_message");
}

// Layer 2: any message in the DM channel after our send timestamp
export async function dmHistorySince(user, channelId, oldestTs) {
  const r = await slackGet(userToken(user), "conversations.history", {
    channel: channelId,
    oldest: oldestTs,  // string ts
    inclusive: "false",
    limit: "50",
  });
  if (!r.ok) {
    console.error("conversations.history error:", r.error, "channel:", channelId);
    return [];
  }
  // Return all messages, only exclude clear bot/system messages
  return (r.messages || []).filter((m) => m.subtype !== "bot_message" && m.type === "message");
}
