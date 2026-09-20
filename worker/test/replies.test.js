import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanReply, isAutoReply, addressOf } from '../lib/cleanText.js';
import { effectsFor } from '../lib/effects.js';
import { interpretReply, buildPrompt } from '../lib/llm.js';
import { readReplies, makePersonResolver } from '../lib/replies.js';
import { executePlan } from '../lib/executor.js';
import { extractBodyText } from '../../lib/nudgeSend.mjs';

// ---------- cleaning ----------
test('cleanReply drops quoted history, signatures and wrapped "On ... wrote:" lines', () => {
  const raw = 'Done for 1. Need till Friday for 2.\n\nThanks\nPriya\n\nOn Mon, 21 Sep 2026 at 11:02, Suraj Sridhar\n<surajsridhar@wldd.in> wrote:\n> Hi Priya,\n> 1. Alpha';
  assert.equal(cleanReply(raw), 'Done for 1. Need till Friday for 2.\n\nThanks\nPriya');
  assert.equal(cleanReply('ok\n-- \nPriya S\nManager'), 'ok');
  assert.equal(cleanReply('x'.repeat(3000)).length, 1501);
});

test('auto replies and delivery notices are recognised', () => {
  assert.equal(isAutoReply({ subject: 'Automatic reply: Pending items', from: 'a@wldd.in' }), true);
  assert.equal(isAutoReply({ from: 'Mail Delivery <mailer-daemon@googlemail.com>' }), true);
  assert.equal(isAutoReply({ autoSubmitted: 'auto-replied', from: 'a@wldd.in' }), true);
  assert.equal(isAutoReply({ autoSubmitted: 'no', subject: 'Re: hi', from: 'a@wldd.in', text: 'done' }), false);
  assert.equal(addressOf('Priya <Priya@WLDD.in>'), 'priya@wldd.in');
});

test('gmail body extraction prefers plain text and strips html otherwise', () => {
  const b64 = (s) => Buffer.from(s).toString('base64url');
  assert.equal(extractBodyText({ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64('<p>hi</p>') } }, { mimeType: 'text/plain', body: { data: b64('plain') } }] }), 'plain');
  assert.match(extractBodyText({ mimeType: 'text/html', body: { data: b64('<p>Done&nbsp;&amp; dusted</p>') } }), /Done & dusted/);
});

// ---------- effects ----------
const items = [
  { n: 1, issueId: 'i1', category: 'invoice_approvals', ownerId: 'u1' },
  { n: 2, issueId: 'i2', category: 'pending_closings', ownerId: 'u1' },
];
const ctx = (o = {}) => ({ todayIst: '2026-09-21', items, fromOwner: true, senderId: 'u1', resolvePerson: (t) => (t === 'Ravi Kumar' ? { id: 'u9' } : t === 'Sam' ? { ambiguous: true } : null), ...o });

test('done claim is recorded for the named item only, and only from the owner', () => {
  const e = effectsFor({ item_no: 1, intent: 'done_claimed', evidence: 'done', confidence: 0.9 }, ctx());
  assert.deepEqual(e.effects, [{ type: 'claimed_done', issueId: 'i1' }]);
  assert.deepEqual(effectsFor({ item_no: 1, intent: 'done_claimed', evidence: 'done', confidence: 0.9 }, ctx({ fromOwner: false })).effects, []);
});

test('holds follow the promised date but are capped per category', () => {
  const a = effectsFor({ item_no: 2, intent: 'promise_with_date', promised_date: '2026-09-25', evidence: 'by Friday', confidence: 0.9 }, ctx());
  assert.deepEqual(a.effects[0], { type: 'hold', issueId: 'i2', until: '2026-09-25', reason: 'promise_with_date: by Friday', capped: false });
  const far = effectsFor({ item_no: 2, intent: 'hold', promised_date: '2027-03-01', evidence: 'later', confidence: 0.9 }, ctx());
  assert.equal(far.effects[0].until, '2026-10-12'); assert.equal(far.effects[0].capped, true);
  const inv = effectsFor({ item_no: 1, intent: 'hold', promised_date: '2026-10-30', evidence: 'x', confidence: 0.9 }, ctx());
  assert.equal(inv.effects[0].until, '2026-09-26');
  const noDate = effectsFor({ item_no: null, intent: 'hold', evidence: 'need time', confidence: 0.9 }, ctx());
  assert.equal(noDate.effects.length, 2); assert.equal(noDate.effects[1].until, '2026-09-28');
  const past = effectsFor({ item_no: 2, intent: 'hold', promised_date: '2026-01-01', evidence: 'x', confidence: 0.9 }, ctx());
  assert.equal(past.effects[0].until, '2026-09-28');
});

test('loop-in adds a co-owner; owner redirect reassigns; unmatched or ambiguous goes to review', () => {
  const co = effectsFor({ item_no: 1, intent: 'loop_in', target_person: 'Ravi Kumar', evidence: 'add Ravi', confidence: 0.9 }, ctx());
  assert.deepEqual(co.effects, [{ type: 'owner', issueId: 'i1', dmsUserId: 'u9', role: 'co_owner', replaces: null, leadAtCreation: 'u1' }]);
  const re = effectsFor({ item_no: 1, intent: 'redirect', target_person: 'Ravi Kumar', evidence: 'Ravi handles this', confidence: 0.9 }, ctx());
  assert.equal(re.effects[0].role, 'reassigned_to'); assert.equal(re.effects[0].replaces, 'u1');
  const third = effectsFor({ item_no: 1, intent: 'redirect', target_person: 'Ravi Kumar', evidence: 'x', confidence: 0.9 }, ctx({ fromOwner: false, senderId: 'm1' }));
  assert.equal(third.effects[0].role, 'co_owner');
  for (const who of ['Sam', 'Nobody Here', null]) {
    const r = effectsFor({ item_no: 1, intent: 'redirect', target_person: who, evidence: 'x', confidence: 0.9 }, ctx());
    assert.equal(r.effects.length, 0); assert.equal(r.review[0].kind, 'ambiguous_redirect');
  }
});

test('questions, blocks, disputes and low-confidence answers go to review; nothing else changes', () => {
  for (const intent of ['question', 'blocked', 'dispute']) {
    const r = effectsFor({ item_no: 1, intent, evidence: 'why', confidence: 0.9 }, ctx());
    assert.equal(r.review[0].kind, intent); assert.deepEqual(r.effects, []);
  }
  const low = effectsFor({ item_no: 1, intent: 'done_claimed', evidence: 'maybe', confidence: 0.4 }, ctx());
  assert.deepEqual(low.effects, []); assert.equal(low.review[0].kind, 'low_confidence');
  const bad = effectsFor({ item_no: 7, intent: 'done_claimed', evidence: 'x', confidence: 0.9 }, ctx());
  assert.deepEqual(bad.effects, []); assert.equal(bad.needsReview, true);
  assert.deepEqual(effectsFor({ item_no: 1, intent: 'noise', evidence: 'thanks', confidence: 0.2 }, ctx()).review, []);
});

// ---------- model call ----------
test('interpretReply forces a tool call, parses it and prices the tokens', async () => {
  let sent;
  const fetchImpl = async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ content: [{ type: 'tool_use', input: { items: [{ item_no: 1, intent: 'done_claimed', evidence: 'done', confidence: 0.95 }] } }], usage: { input_tokens: 1000, output_tokens: 100 } }) };
  };
  const r = await interpretReply({ apiKey: 'k', prompt: 'p', fetchImpl });
  assert.deepEqual(sent.tool_choice, { type: 'tool', name: 'record_interpretation' });
  assert.equal(r.items[0].intent, 'done_claimed');
  assert.ok(Math.abs(r.costUsd - 0.0015) < 1e-9);
  await assert.rejects(interpretReply({ apiKey: 'k', prompt: 'p', fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'slow down' } }) }) }), /429/);
  await assert.rejects(interpretReply({ apiKey: 'k', prompt: 'p', fetchImpl: async () => ({ ok: true, json: async () => ({ content: [] }) }) }), /no structured/);
  assert.match(buildPrompt({ todayIst: '2026-09-21', items: [{ n: 1, campaign_name: 'Alpha', category: 'pending_closings' }], replyText: 'done', fromOwner: false, senderName: 'X' }), /NOT the owner/);
});

test('person resolver: exact email or name, unique loose match, ambiguity refused, outsiders ignored', () => {
  const r = makePersonResolver([
    { dms_user_id: 'a', name: 'Ravi Kumar', email: 'ravi@wldd.in' }, { dms_user_id: 'b', name: 'Ravi Shah', email: 'ravis@wldd.in' },
    { dms_user_id: 'c', name: 'Priya Sharma', email: 'priya@wldd.in' }, { dms_user_id: 'd', name: 'Gone Person', email: 'g@wldd.in', is_deleted: true },
    { dms_user_id: 'e', name: 'Ext Person', email: 'e@gmail.com' },
  ]);
  assert.deepEqual(r('ravi@wldd.in'), { id: 'a' });
  assert.deepEqual(r('Priya Sharma'), { id: 'c' });
  assert.deepEqual(r('sharma priya'), { id: 'c' });
  assert.deepEqual(r('Ravi'), { ambiguous: true });
  assert.equal(r('Gone Person'), null); assert.equal(r('Ext Person'), null); assert.equal(r(''), null);
});

// ---------- orchestration ----------
function fake({ threads, msgs, llm, spent = 0, people, issues }) {
  const log = { min: [], interp: [], effects: [], review: [], processed: [], unreachable: [] };
  let seq = 0;
  const stored = new Map();
  const store = {
    replyThreads: async () => threads, slackConversations: async () => [],
    getMessageIn: async (c, e) => stored.get(`${c}:${e}`) || null,
    insertMessageIn: async (row) => { const id = `m${++seq}`; stored.set(`${row.channel}:${row.external_id}`, { id, clean_text: row.clean_text, from_owner: row.from_owner, processed_at: row.processed_at }); log.min.push(row); return id; },
    insertInterpretations: async (rows) => log.interp.push(...rows),
    markProcessed: async (id) => { log.processed.push(id); for (const v of stored.values()) if (v.id === id) v.processed_at = 'x'; },
    monthLlmSpend: async () => spent, markUnreachable: async (id, why) => log.unreachable.push([id, why]),
    addReviewItem: async (i) => log.review.push(i), applyEffect: async (e) => log.effects.push(e),
  };
  const senders = { readThread: async () => ({ messages: msgs }), bounces: async () => ({ bounces: [] }) };
  const run = () => readReplies({ store, senders, interpret: llm, apiKey: 'k', now: new Date('2026-09-22T06:00:00Z'), settings: { llm_monthly_cap_usd: 3 }, people, issuesById: new Map(issues.map((i) => [i.id, i])), senderEmail: 'suraj@wldd.in' });
  return { store, senders, run, log };
}
const P = [{ dms_user_id: 'u1', name: 'Priya Sharma', email: 'priya@wldd.in' }, { dms_user_id: 'u9', name: 'Ravi Kumar', email: 'ravi@wldd.in' }];
const ISS = [{ id: 'i1', category: 'invoice_approvals', campaign_name: 'Alpha', owner_dms_user_id: 'u1' }, { id: 'i2', category: 'pending_closings', campaign_name: 'Zeta', owner_dms_user_id: 'u1' }];
const THREADS = [{ threadId: 'T1', recipientId: 'u1', outs: [{ id: 'o1', sent_at: '2026-09-21T05:30:00Z', items: [{ issue_id: 'i1', item_no: 1 }, { issue_id: 'i2', item_no: 2 }] }] }];
const ms = (o) => ({ id: 'g1', internalDate: Date.parse('2026-09-21T09:00:00Z'), from: 'Priya <priya@wldd.in>', subject: 'Re: x', text: '1. done\n2. need till Friday\n\nOn Mon wrote:\n> old', ...o });
const llmOk = async () => ({ model: 'm', tokensIn: 500, tokensOut: 50, costUsd: 0.00075, items: [{ item_no: 1, intent: 'done_claimed', evidence: 'done', confidence: 0.9 }, { item_no: 2, intent: 'promise_with_date', promised_date: '2026-09-25', evidence: 'till Friday', confidence: 0.9 }] });

test('a reply is stored once, read once, and its effects applied per item', async () => {
  const f = fake({ threads: THREADS, msgs: [ms(), ms({ id: 'own', from: 'suraj@wldd.in' }), ms({ id: 'old', internalDate: Date.parse('2026-09-20T00:00:00Z') })], llm: llmOk, people: P, issues: ISS });
  const s = await f.run();
  assert.equal(s.newMessages, 1); assert.equal(s.interpreted, 1);
  assert.deepEqual(f.log.effects.map((e) => e.type), ['claimed_done', 'hold']);
  assert.equal(f.log.min[0].clean_text, '1. done\n2. need till Friday');
  assert.equal(f.log.min[0].from_owner, true);
  assert.equal(f.log.interp.length, 2);
  assert.ok(Math.abs(f.log.interp.reduce((a, r) => a + r.cost_usd, 0) - 0.00075) < 1e-9);
  const again = await f.run();                                    // same message again: nothing new, nothing repeated
  assert.equal(again.newMessages, 0); assert.equal(again.interpreted, 0); assert.equal(f.log.effects.length, 2);
});

test('a model failure leaves the reply unprocessed and it is retried, not lost', async () => {
  let fail = true;
  const f = fake({ threads: THREADS, msgs: [ms()], llm: async (a) => { if (fail) throw new Error('boom'); return llmOk(a); }, people: P, issues: ISS });
  assert.equal((await f.run()).llmErrors, 1); assert.equal(f.log.effects.length, 0);
  fail = false;
  const s = await f.run();
  assert.equal(s.newMessages, 0); assert.equal(s.interpreted, 1); assert.equal(f.log.effects.length, 2);
});

test('auto-replies are stored but never sent to the model; the spend cap stops model calls', async () => {
  let calls = 0;
  const f = fake({ threads: THREADS, msgs: [ms({ id: 'a', subject: 'Automatic reply: x', text: 'I am out of office' })], llm: async (a) => { calls++; return llmOk(a); }, people: P, issues: ISS });
  await f.run(); assert.equal(calls, 0); assert.equal(f.log.min.length, 1);
  const g = fake({ threads: THREADS, msgs: [ms()], llm: async (a) => { calls++; return llmOk(a); }, people: P, issues: ISS, spent: 3.01 });
  const s = await g.run(); assert.equal(calls, 0); assert.equal(s.skippedCap, 1); assert.match(g.log.review[0].note, /budget/);
});

test('a reply from someone else on the thread cannot claim done or set holds', async () => {
  const f = fake({ threads: THREADS, msgs: [ms({ from: 'Ravi <ravi@wldd.in>' })], llm: llmOk, people: P, issues: ISS });
  await f.run(); assert.deepEqual(f.log.effects, []);
});

test('replies about items Mongo already cleared are dropped without a model call', async () => {
  let calls = 0;
  const f = fake({ threads: THREADS, msgs: [ms()], llm: async (a) => { calls++; return llmOk(a); }, people: P, issues: [] });
  await f.run(); assert.equal(calls, 0); assert.equal(f.log.processed.length, 1);
});

test('bounces mark the person unreachable once and raise a review item', async () => {
  const f = fake({ threads: [], msgs: [], llm: llmOk, people: P, issues: ISS });
  f.senders.bounces = async () => ({ bounces: [{ subject: 'Undelivered', recipients: ['priya@wldd.in', 'stranger@wldd.in'] }] });
  const s = await f.run(); assert.equal(s.bounces, 1); assert.equal(f.log.unreachable[0][0], 'u1'); assert.match(f.log.review[0].note, /bounced/);
});

// ---------- executor: false done + unreachable ----------
test('executor skips unreachable people and counts a "done" claim Mongo did not confirm', async () => {
  const calls = { fd: [], review: [], sent: 0 };
  const store = {
    hasMessageToday: async () => false, insertMessage: async () => 'msg', insertItems: async () => {}, updateMessage: async () => {},
    savePersonThread: async () => {}, addReviewItem: async (i) => calls.review.push(i), applySent: async () => {},
    recordFalseDone: async (id) => { calls.fd.push(id); return 2; },
  };
  const plan = { today: '2026-09-21', monthEnd: false, finalNoticeDay: false, deferredRecipientIds: [], rampDone: false, messages: [
    { recipientId: 'u1', lane: 'B', kind: 'followup', final: false, ccManager: false, items: [{ issueId: 'i1', nextN: 2 }] },
    { recipientId: 'u2', lane: 'B', kind: 'followup', final: false, ccManager: false, items: [{ issueId: 'i2', nextN: 2 }] },
  ] };
  const people = new Map([['u1', { dms_user_id: 'u1', name: 'A', email: 'a@wldd.in' }], ['u2', { dms_user_id: 'u2', name: 'B', email: 'b@wldd.in', unreachable_at: 'x' }]]);
  const issuesById = new Map([['i1', { campaign_name: 'Alpha', category: 'invoice_approvals', item_count: 1, detail: {}, claimed_done_at: '2026-09-20T00:00:00Z', nudge_count: 1 }], ['i2', { campaign_name: 'Z', category: 'pending_closings', item_count: 1, detail: {}, nudge_count: 1 }]]);
  const r = await executePlan({ plan, mode: 'live', now: new Date('2026-09-21T06:30:00Z'), runId: 'r', store, senders: { email: async () => { calls.sent++; return { threadId: 'T', rfcMessageId: '<m>', gmailMessageId: 'g' }; } }, issuesById, people, settings: { senderName: 'S' } });
  assert.equal(calls.sent, 1); assert.equal(r.skippedUnreachable, 1);
  assert.deepEqual(calls.fd, ['i1']); assert.equal(calls.review[0].kind, 'false_done_twice');
});
