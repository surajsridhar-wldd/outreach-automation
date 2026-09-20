// Minimal Gmail REST client (no googleapis dependency).
import { buildRawEmail } from './mime.js';

export async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(`Google token refresh failed: ${data.error_description || data.error || res.status}`);
  return data.access_token;
}

async function gmail(accessToken, path, init = {}) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gmail ${path.split('?')[0]} failed: ${data.error?.message || res.status}`);
  return data;
}

/** Sends an email; when threadId + inReplyTo are given it is added to that thread. */
export async function sendEmail(accessToken, { from, to, cc, subject, body, threadId, inReplyTo, references }) {
  const raw = buildRawEmail({ from, to, cc, subject, body, inReplyTo, references });
  const sent = await gmail(accessToken, 'messages/send', { method: 'POST', body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }) });
  // The RFC 822 Message-ID is needed so the NEXT follow-up can reference this message.
  const meta = await gmail(accessToken, `messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`);
  const rfcMessageId = meta.payload?.headers?.find((h) => h.name.toLowerCase() === 'message-id')?.value || null;
  return { gmailMessageId: sent.id, threadId: sent.threadId, rfcMessageId };
}
