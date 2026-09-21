// Senders for a manual "send now" that runs inside the website's own server (no HTTP hop): the same Gmail / Slack
// code as the worker's route, with the same duplicate protection (the idempotency key is claimed BEFORE sending,
// released if the send fails, and a repeat of a finished send returns the earlier result).

import { processSendRequest } from './nudgeSend.mjs';

export function makeDirectSender({ db, decrypt, google, sender, fetchImpl }) {
  async function guarded(key, fn) {
    if (!key) return fn();
    const { error } = await db.from('send_log').insert({ idempotency_key: key, status: 'pending' });
    if (error) {
      const { data: prev } = await db.from('send_log').select('status,result').eq('idempotency_key', key).single();
      if (prev?.status === 'done') return { ...prev.result, duplicate: true };
      throw new Error('this send was already started and could not be confirmed; check the Sent folder');
    }
    let result;
    try {
      result = await fn();
    } catch (e) {
      await db.from('send_log').delete().eq('idempotency_key', key);   // nothing went out: allow a retry
      throw e;
    }
    await db.from('send_log').update({ status: 'done', result }).eq('idempotency_key', key);
    return result;
  }
  const deps = { decrypt, google, tokenCache: {}, ...(fetchImpl ? { fetchImpl } : {}) };
  return {
    email: (a) => guarded(a.idempotencyKey, () => processSendRequest({
      type: 'email', to: a.to, cc: a.cc || [], subject: a.subject, body: a.body, threadId: a.threadId, inReplyTo: a.inReplyTo, references: a.references,
    }, sender, deps)),
    slack: ({ person, text, idempotencyKey }) => guarded(idempotencyKey, () => processSendRequest({
      type: 'slack', email: person.email, slackUserId: person.slack_user_id, dmChannelId: person.slack_dm_channel_id, text,
    }, sender, deps)),
  };
}
