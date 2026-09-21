// Sending helpers for the nudge worker. They live in the website's codebase because the website's
// server already holds the Gmail and Slack access (and the key that unlocks it), so the worker
// never needs those secrets: it asks this server to send, signing each request with a key both
// sides already have (the Supabase service key).
//
// Written as .mjs so the Next.js route and the worker's tests can import the same file.

import crypto from 'node:crypto';

// ---------- request signing ----------
export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

export function signRequest(key, ts, rawBody) {
  return crypto.createHmac('sha256', key).update(`${ts}.${rawBody}`).digest('hex');
}

export function verifyRequest({ key, ts, rawBody, signature, nowMs = Date.now() }) {
  if (!key || !ts || !signature) return false;
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(nowMs - t) > SIGNATURE_WINDOW_MS) return false;
  const expected = Buffer.from(signRequest(key, ts, rawBody), 'hex');
  const got = Buffer.from(String(signature), 'hex');
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

// ---------- internal-only guard ----------
/** Nudges are internal. Refuse any address outside the company domain. */
export function assertInternal(addresses, domain = 'wldd.in') {
  for (const a of addresses.filter(Boolean)) {
    const email = (a.match(/<([^>]+)>/)?.[1] || a).trim().toLowerCase();
    if (!new RegExp(`^[^@\\s]+@${domain.replace('.', '\\.')}$`).test(email)) {
      throw new Error(`Refusing to send to a non-${domain} address`);
    }
  }
}

// ---------- email ----------
const b64 = (buf) => Buffer.from(buf).toString('base64');
const wrap76 = (s) => s.replace(/(.{76})/g, '$1\r\n');

export function encodeHeader(value) {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${b64(value)}?=`;
}

/** RFC 2822 message for the Gmail API. The body is properly base64-encoded. */
export function buildRawEmail({ from, to, cc = [], subject, body, inReplyTo, references }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  const message = `${headers.join('\r\n')}\r\n\r\n${wrap76(b64(body))}`;
  return Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function getGoogleAccessToken({ clientId, clientSecret, refreshToken }, fetchImpl = fetch) {
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`Google token refresh failed: ${data.error_description || data.error || res.status}`);
  return data.access_token;
}

async function gmailCall(accessToken, path, init, fetchImpl) {
  const res = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gmail ${path.split('?')[0]} failed: ${data.error?.message || res.status}`);
  return data;
}

/** Sends an email (inside an existing thread when threadId + inReplyTo are given). */
export async function gmailSend(accessToken, mail, fetchImpl = fetch) {
  const raw = buildRawEmail(mail);
  const sent = await gmailCall(accessToken, 'messages/send', { method: 'POST', body: JSON.stringify({ raw, ...(mail.threadId ? { threadId: mail.threadId } : {}) }) }, fetchImpl);
  // The RFC 822 Message-ID is needed so the NEXT follow-up can reference this message.
  const meta = await gmailCall(accessToken, `messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`, { method: 'GET' }, fetchImpl);
  const rfcMessageId = meta.payload?.headers?.find((h) => h.name.toLowerCase() === 'message-id')?.value || null;
  return { gmailMessageId: sent.id, threadId: sent.threadId, rfcMessageId };
}

// ---------- slack (acts as the connected user) ----------
async function slackPostJson(token, method, params, fetchImpl) {
  const res = await fetchImpl(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(params),
  });
  return res.json();
}

export async function slackSendDm({ token, slackUserId, dmChannelId, email, text }, fetchImpl = fetch) {
  let userId = slackUserId;
  if (!userId && email) {
    const res = await fetchImpl(`https://slack.com/api/users.lookupByEmail?${new URLSearchParams({ email })}`, { headers: { authorization: `Bearer ${token}` } });
    const data = await res.json();
    userId = data.ok ? data.user.id : null;
  }
  if (!userId && !dmChannelId) return { ok: false, error: 'no_slack_user' };
  let channel = dmChannelId;
  if (!channel) {
    const o = await slackPostJson(token, 'conversations.open', { users: userId }, fetchImpl);
    if (!o.ok) return { ok: false, error: o.error || 'open_failed' };
    channel = o.channel.id;
  }
  const r = await slackPostJson(token, 'chat.postMessage', { channel, text }, fetchImpl);
  return { ok: !!r.ok, ts: r.ts ? String(r.ts) : null, channel, slackUserId: userId || null, error: r.error || null };
}

// ---------- one request, end to end (used by the API route; testable without Next.js) ----------
/**
 * body:   { type: 'email'|'slack', ... }
 * sender: { gmail_address, gmail_refresh_token, slack_access_token } (tokens still encrypted)
 * deps:   { decrypt, google: {clientId, clientSecret}, fetchImpl }
 */
export async function processSendRequest(body, sender, { decrypt, google, fetchImpl = fetch, tokenCache }) {
  if (body.type === 'email') {
    if (!body.to || !body.subject || !body.body) throw new Error('email needs to, subject and body');
    assertInternal([body.to, ...(body.cc || [])]);
    // One access token serves a whole batch (it lasts an hour), which keeps a multi-person send within the request limit.
    const token = tokenCache?.token || await getGoogleAccessToken({ ...google, refreshToken: decrypt(sender.gmail_refresh_token) }, fetchImpl);
    if (tokenCache) tokenCache.token = token;
    return gmailSend(token, {
      from: sender.gmail_address, to: body.to, cc: body.cc || [], subject: body.subject, body: body.body,
      threadId: body.threadId, inReplyTo: body.inReplyTo, references: body.references,
    }, fetchImpl);
  }
  if (body.type === 'slack') {
    if (!body.text) throw new Error('slack needs text');
    if (body.email) assertInternal([body.email]);
    return slackSendDm({ token: decrypt(sender.slack_access_token), slackUserId: body.slackUserId, dmChannelId: body.dmChannelId, email: body.email, text: body.text }, fetchImpl);
  }
  throw new Error(`Unknown request type "${body.type}"`);
}


// =====================================================================================================
// Reading replies. These only ever read what the nudge system itself started: the route checks that a
// requested thread / DM channel is one we created before calling them.
// =====================================================================================================

const b64urlToUtf8 = (data) => Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const header = (msg, name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

function htmlToText(html) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

/** Plain-text body of a Gmail message (prefers text/plain, falls back to stripped HTML). */
export function extractBodyText(payload) {
  const found = { plain: '', html: '' };
  const walk = (part) => {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body?.data && !found.plain) found.plain = b64urlToUtf8(part.body.data);
    else if (part.mimeType === 'text/html' && part.body?.data && !found.html) found.html = b64urlToUtf8(part.body.data);
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  return found.plain || (found.html ? htmlToText(found.html) : '');
}

export function summariseMessage(msg) {
  return {
    id: msg.id,
    internalDate: Number(msg.internalDate),
    from: header(msg, 'From'),
    to: header(msg, 'To'),
    cc: header(msg, 'Cc'),
    subject: header(msg, 'Subject'),
    messageIdHeader: header(msg, 'Message-ID'),
    autoSubmitted: header(msg, 'Auto-Submitted') || header(msg, 'X-Autoreply') || '',
    text: extractBodyText(msg.payload),
  };
}

export async function gmailGetThread(accessToken, threadId, fetchImpl = fetch) {
  const t = await gmailCall(accessToken, `threads/${encodeURIComponent(threadId)}?format=full`, { method: 'GET' }, fetchImpl);
  return (t.messages || []).map(summariseMessage);
}

/** Recent delivery-failure notices (bounces). Returns the company addresses mentioned in each. */
export async function gmailBounces(accessToken, ownerEmail, fetchImpl = fetch) {
  const q = encodeURIComponent('from:(mailer-daemon OR postmaster) newer_than:3d');
  const list = await gmailCall(accessToken, `messages?q=${q}&maxResults=20`, { method: 'GET' }, fetchImpl);
  const out = [];
  for (const m of list.messages || []) {
    const full = await gmailCall(accessToken, `messages/${m.id}?format=full`, { method: 'GET' }, fetchImpl);
    const text = `${header(full, 'Subject')}\n${full.snippet || ''}\n${extractBodyText(full.payload)}`;
    const recipients = [...new Set((text.match(/[A-Za-z0-9._%+-]+@wldd\.in/gi) || []).map((x) => x.toLowerCase()))].filter((x) => x !== String(ownerEmail || '').toLowerCase());
    out.push({ id: full.id, internalDate: Number(full.internalDate), subject: header(full, 'Subject'), recipients, snippet: (full.snippet || '').slice(0, 200) });
  }
  return out;
}

export async function slackHistory({ token, dmChannelId, oldest }, fetchImpl = fetch) {
  const params = new URLSearchParams({ channel: dmChannelId, limit: '50', ...(oldest ? { oldest: String(oldest) } : {}) });
  const res = await fetchImpl(`https://slack.com/api/conversations.history?${params}`, { headers: { authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!data.ok) return { ok: false, error: data.error || 'history_failed', messages: [] };
  return { ok: true, messages: (data.messages || []).filter((m) => m.type === 'message' && !m.subtype).map((m) => ({ ts: String(m.ts), user: m.user, text: m.text || '' })) };
}

/**
 * Read requests. `guards` decide whether a thread / channel is one the nudge system created:
 *   { allowThread(threadId) -> bool, allowChannel(channelId) -> bool }
 */
export async function processReadRequest(body, sender, { decrypt, google, fetchImpl = fetch, guards }) {
  if (body.type === 'gmail_thread') {
    if (!body.threadId || !(await guards.allowThread(body.threadId))) throw new Error('thread is not one the nudge system created');
    const token = await getGoogleAccessToken({ ...google, refreshToken: decrypt(sender.gmail_refresh_token) }, fetchImpl);
    return { messages: await gmailGetThread(token, body.threadId, fetchImpl) };
  }
  if (body.type === 'gmail_bounces') {
    const token = await getGoogleAccessToken({ ...google, refreshToken: decrypt(sender.gmail_refresh_token) }, fetchImpl);
    return { bounces: await gmailBounces(token, sender.gmail_address, fetchImpl) };
  }
  if (body.type === 'slack_history') {
    if (!body.dmChannelId || !(await guards.allowChannel(body.dmChannelId))) throw new Error('channel is not one the nudge system created');
    return slackHistory({ token: decrypt(sender.slack_access_token), dmChannelId: body.dmChannelId, oldest: body.oldest }, fetchImpl);
  }
  throw new Error(`Unknown read type "${body.type}"`);
}

export const READ_TYPES = new Set(['gmail_thread', 'gmail_bounces', 'slack_history']);
