// Sends through the website's own server (POST /api/nudge/send), which already holds the Gmail and
// Slack access. The worker only needs the Supabase service key it already has, used to sign each
// request. See lib/nudgeSend.mjs in the website for the receiving side.
import { signRequest } from '../../lib/nudgeSend.mjs';

export function makeAppSender({ baseUrl, key, fetchImpl = fetch, now = () => Date.now() }) {
  async function call(payload) {
    const raw = JSON.stringify(payload);
    const ts = String(now());
    const res = await fetchImpl(`${baseUrl}/api/nudge/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nudge-timestamp': ts, 'x-nudge-signature': signRequest(key, ts, raw) },
      body: raw,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`send API ${res.status}: ${data.error || 'error'}`);
    return data;
  }
  return {
    email: (a) => call({ type: 'email', idempotencyKey: a.idempotencyKey, to: a.to, cc: a.cc || [], subject: a.subject, body: a.body, threadId: a.threadId, inReplyTo: a.inReplyTo, references: a.references }),
    slack: ({ person, text, idempotencyKey }) => call({ type: 'slack', idempotencyKey, email: person.email, slackUserId: person.slack_user_id, dmChannelId: person.slack_dm_channel_id, text }),
  };
}
