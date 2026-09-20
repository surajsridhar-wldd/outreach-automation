import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signRequest, verifyRequest, assertInternal, processSendRequest, SIGNATURE_WINDOW_MS } from '../../lib/nudgeSend.mjs';
import { makeAppSender } from '../lib/appSender.js';

const KEY = 'service-key-for-tests';

// ---------- signing ----------
test('a correctly signed, fresh request verifies; tampering, staleness and wrong keys do not', () => {
  const ts = String(Date.now());
  const body = '{"type":"email"}';
  const sig = signRequest(KEY, ts, body);
  assert.equal(verifyRequest({ key: KEY, ts, rawBody: body, signature: sig }), true);
  assert.equal(verifyRequest({ key: KEY, ts, rawBody: body + ' ', signature: sig }), false, 'body changed');
  assert.equal(verifyRequest({ key: 'other', ts, rawBody: body, signature: sig }), false, 'wrong key');
  assert.equal(verifyRequest({ key: KEY, ts, rawBody: body, signature: 'zz' }), false, 'garbage signature');
  assert.equal(verifyRequest({ key: KEY, ts: '', rawBody: body, signature: sig }), false, 'no timestamp');
  const old = String(Date.now() - SIGNATURE_WINDOW_MS - 1000);
  assert.equal(verifyRequest({ key: KEY, ts: old, rawBody: body, signature: signRequest(KEY, old, body) }), false, 'replay of an old request');
});

test('only company addresses are accepted', () => {
  assert.doesNotThrow(() => assertInternal(['a@wldd.in', 'Boss <boss@WLDD.in>']));
  assert.throws(() => assertInternal(['a@gmail.com']), /non-wldd.in/);
  assert.throws(() => assertInternal(['a@wldd.in', 'x@wldd.in.evil.com']), /non-wldd.in/);
  assert.throws(() => assertInternal(['wldd.in']), /non-wldd.in/);
});

// ---------- one send request end to end, with a fake network ----------
function fakeNetwork() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const reply = (obj, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => obj });
    if (String(url).includes('oauth2.googleapis.com')) return reply({ access_token: 'AT' });
    if (String(url).endsWith('/messages/send')) return reply({ id: 'gm1', threadId: 'th1' });
    if (String(url).includes('/messages/gm1?')) return reply({ payload: { headers: [{ name: 'Message-ID', value: '<abc@mail.gmail.com>' }] } });
    if (String(url).includes('users.lookupByEmail')) return reply({ ok: true, user: { id: 'U9' } });
    if (String(url).includes('conversations.open')) return reply({ ok: true, channel: { id: 'D9' } });
    if (String(url).includes('chat.postMessage')) return reply({ ok: true, ts: '1.2' });
    throw new Error(`unexpected url ${url}`);
  };
  return { calls, fetchImpl };
}
const sender = { gmail_address: 'suraj@wldd.in', gmail_refresh_token: 'enc-g', slack_access_token: 'enc-s' };
const deps = (net) => ({ decrypt: (x) => `dec(${x})`, google: { clientId: 'cid', clientSecret: 'sec' }, fetchImpl: net.fetchImpl });

test('email request: refreshes the token, sends inside the thread, returns ids for the next follow-up', async () => {
  const net = fakeNetwork();
  const r = await processSendRequest({ type: 'email', to: 'p@wldd.in', cc: ['m@wldd.in'], subject: 'Re: x', body: 'hello', threadId: 'T1', inReplyTo: '<prev>', references: '<prev>' }, sender, deps(net));
  assert.deepEqual(r, { gmailMessageId: 'gm1', threadId: 'th1', rfcMessageId: '<abc@mail.gmail.com>' });
  const tokenCall = net.calls[0].init.body.toString();
  assert.match(tokenCall, /refresh_token=dec%28enc-g%29/);
  const sendBody = JSON.parse(net.calls.find((c) => c.url.endsWith('/messages/send')).init.body);
  assert.equal(sendBody.threadId, 'T1');
  const raw = Buffer.from(sendBody.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
  assert.match(raw, /From: suraj@wldd.in\r\nTo: p@wldd.in\r\nCc: m@wldd.in/);
  assert.match(raw, /In-Reply-To: <prev>/);
});

test('email request to an outside address is refused before anything is sent', async () => {
  const net = fakeNetwork();
  await assert.rejects(processSendRequest({ type: 'email', to: 'client@gmail.com', subject: 's', body: 'b' }, sender, deps(net)), /non-wldd.in/);
  assert.equal(net.calls.length, 0);
});

test('slack request: looks the person up by email, opens a DM, posts, and reports the ids', async () => {
  const net = fakeNetwork();
  const r = await processSendRequest({ type: 'slack', email: 'p@wldd.in', text: 'hi' }, sender, deps(net));
  assert.deepEqual(r, { ok: true, ts: '1.2', channel: 'D9', slackUserId: 'U9', error: null });
  const post = net.calls.find((c) => c.url.includes('chat.postMessage'));
  assert.equal(post.init.headers.authorization, 'Bearer dec(enc-s)');
});

test('bad requests are rejected', async () => {
  const net = fakeNetwork();
  await assert.rejects(processSendRequest({ type: 'email', to: 'p@wldd.in' }, sender, deps(net)), /needs to, subject and body/);
  await assert.rejects(processSendRequest({ type: 'pigeon' }, sender, deps(net)), /Unknown request type/);
});

// ---------- the worker's side ----------
test('the worker signs requests so the website accepts exactly what it sends', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ gmailMessageId: 'g', threadId: 't', rfcMessageId: '<m>' }) }; };
  const s = makeAppSender({ baseUrl: 'https://app.example', key: KEY, fetchImpl });
  const r = await s.email({ to: 'p@wldd.in', cc: [], subject: 's', body: 'b' });
  assert.equal(r.threadId, 't');
  assert.equal(seen.url, 'https://app.example/api/nudge/send');
  const h = seen.init.headers;
  assert.equal(verifyRequest({ key: KEY, ts: h['x-nudge-timestamp'], rawBody: seen.init.body, signature: h['x-nudge-signature'] }), true);
  assert.equal(JSON.parse(seen.init.body).type, 'email');
});

test('a failed send surfaces as an error the executor can record', async () => {
  const fetchImpl = async () => ({ ok: false, status: 502, json: async () => ({ error: 'Gmail messages/send failed: quota' }) });
  const s = makeAppSender({ baseUrl: 'https://app.example', key: KEY, fetchImpl });
  await assert.rejects(s.email({ to: 'p@wldd.in', subject: 's', body: 'b' }), /send API 502: Gmail messages\/send failed: quota/);
});
