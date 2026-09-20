import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executePlan } from '../lib/executor.js';
import { planRun, CATEGORY } from '../lib/planner.js';

// Monday 2026-10-05, 11:00 IST
const NOW = new Date('2026-10-05T05:30:00Z');
const SETTINGS = { senderName: 'Suraj Sridhar', senderEmail: 'suraj@wldd.in', redirectTo: 'suraj@wldd.in', allowlist: [] };

function world({ count = 3, invoiceNudgeCount = 0, extraPerson = {} } = {}) {
  const issues = [];
  const people = new Map();
  for (let i = 1; i <= count; i++) {
    const id = `i${i}`;
    issues.push({
      id, category: CATEGORY.INVOICE, ownerIds: [`p${i}`], needsOwner: false,
      nudgeCount: invoiceNudgeCount, lastNudgedAt: null, holdUntil: null, firstSeenAt: '2026-10-01T00:00:00Z',
    });
    people.set(`p${i}`, { dms_user_id: `p${i}`, name: `Person ${i}`, email: `p${i}@wldd.in`, ...extraPerson });
  }
  const issuesById = new Map(issues.map((i) => [i.id, { id: i.id, category: i.category, campaign_name: `Camp ${i.id}`, item_count: 1, detail: {}, nudge_count: i.nudgeCount }]));
  return { issues, people, issuesById };
}

function fakeStore() {
  const s = { messages: [], items: [], reviews: [], applied: null, threads: {}, sentToday: new Set() };
  return {
    s,
    hasMessageToday: async (rid) => s.sentToday.has(rid),
    insertMessage: async (row) => { const id = `m${s.messages.length + 1}`; s.messages.push({ id, ...row }); return id; },
    insertItems: async (rows) => { s.items.push(...rows); },
    updateMessage: async (id, patch) => Object.assign(s.messages.find((m) => m.id === id), patch),
    savePersonThread: async (id, patch) => { s.threads[id] = { ...(s.threads[id] || {}), ...patch }; },
    addReviewItem: async (r) => { s.reviews.push(r); },
    applySent: async (a) => { s.applied = a; },
  };
}

function fakeSenders({ failFor } = {}) {
  const sent = { emails: [], slacks: [] };
  return {
    sent,
    email: async (args) => {
      if (failFor && args.to === failFor) throw new Error('smtp down');
      sent.emails.push(args);
      return { gmailMessageId: `g${sent.emails.length}`, threadId: `t${sent.emails.length}`, rfcMessageId: `<m${sent.emails.length}@mail>` };
    },
    slack: async ({ person, text }) => { sent.slacks.push({ person, text }); return { ok: true, ts: '1.1', channel: 'D1', slackUserId: 'U1' }; },
  };
}

const run = (over) => {
  const w = world(over.world);
  const plan = planRun({ now: NOW, issues: w.issues, people: over.peopleState || {} });
  const store = fakeStore();
  const senders = fakeSenders(over.senders);
  return { w, plan, store, senders, exec: (mode, extra = {}) => executePlan({
    plan, mode, now: over.now || NOW, runId: 'run1', store, senders, issuesById: w.issuesById, people: w.people,
    settings: { ...SETTINGS, ...(over.settings || {}) }, ...extra,
  }) };
};

test('shadow: drafts only, nothing sent, no state change', async () => {
  const r = run({});
  const stats = await r.exec('shadow');
  assert.equal(stats.drafted, 3);
  assert.equal(stats.sent, 0);
  assert.equal(r.senders.sent.emails.length, 0);
  assert.equal(r.store.s.applied, null);
  assert.ok(r.store.s.messages.every((m) => m.status === 'draft' && m.mode === 'shadow'));
  assert.equal(r.store.s.items.length, 3);
});

test('rehearsal: real emails go ONLY to the owner, with a banner, and no state change', async () => {
  const r = run({});
  const stats = await r.exec('rehearsal');
  assert.equal(stats.sent, 3);
  assert.ok(r.senders.sent.emails.every((e) => e.to === 'suraj@wldd.in'));
  assert.ok(r.senders.sent.emails.every((e) => e.subject.startsWith('[REHEARSAL]')));
  assert.match(r.senders.sent.emails[0].body, /would have gone to p1@wldd.in/);
  assert.equal(r.store.s.applied, null);
  assert.deepEqual(r.store.s.threads, {});
  assert.ok(r.store.s.messages.every((m) => m.intended_to?.endsWith('@wldd.in')));
});

test('canary: only allow-listed people get a real email; the rest stay drafts; state only for those sent', async () => {
  const r = run({ settings: { allowlist: ['p2@wldd.in'] } });
  const stats = await r.exec('canary');
  assert.equal(stats.sent, 1);
  assert.equal(stats.drafted, 2);
  assert.deepEqual(r.senders.sent.emails.map((e) => e.to), ['p2@wldd.in']);
  assert.deepEqual(r.store.s.applied.recipientIds, ['p2']);
  assert.deepEqual(r.store.s.applied.issues, [{ id: 'i2', nudgeCount: 0 }]);
  assert.deepEqual(r.store.s.applied.deferredIds, [], 'a canary never ages the real waiting queue');
});

test('live: everyone selected gets a real email, state advances, thread saved for follow-ups', async () => {
  const r = run({});
  const stats = await r.exec('live');
  assert.equal(stats.sent, 3);
  assert.deepEqual(r.senders.sent.emails.map((e) => e.to).sort(), ['p1@wldd.in', 'p2@wldd.in', 'p3@wldd.in']);
  assert.equal(r.store.s.applied.recipientIds.length, 3);
  assert.equal(r.store.s.threads.p1.email_thread_id, 't1');
  assert.equal(r.store.s.threads.p1.email_subject, '[Action Required] Pending items on DMS');
});

test('a follow-up is sent INSIDE the existing thread with In-Reply-To', async () => {
  const r = run({ world: { extraPerson: { email_thread_id: 'T9', email_rfc_message_id: '<prev@mail>', email_subject: '[Action Required] Pending items on DMS' } }, peopleState: { p1: { enteredAt: 'x' }, p2: { enteredAt: 'x' }, p3: { enteredAt: 'x' } } });
  // put the items in follow-up territory
  r.w.issues.forEach((i) => { i.nudgeCount = 1; i.lastNudgedAt = '2026-10-01T05:30:00Z'; });
  const plan = planRun({ now: NOW, issues: r.w.issues, people: { p1: { enteredAt: 'x' }, p2: { enteredAt: 'x' }, p3: { enteredAt: 'x' } } });
  const store = fakeStore(); const senders = fakeSenders();
  await executePlan({ plan, mode: 'live', now: NOW, runId: 'r', store, senders, issuesById: r.w.issuesById, people: r.w.people, settings: SETTINGS });
  const e = senders.sent.emails[0];
  assert.equal(e.threadId, 'T9');
  assert.equal(e.inReplyTo, '<prev@mail>');
  assert.equal(e.subject, 'Re: [Action Required] Pending items on DMS');
});

test('real sends refuse to run outside 11:00-19:00 IST or on weekends, and shadow does not care', async () => {
  const early = run({ now: new Date('2026-10-05T04:00:00Z') });        // 09:30 IST
  assert.equal((await early.exec('live')).skipped, 'outside_send_window');
  assert.equal(early.senders.sent.emails.length, 0);
  assert.equal((await early.exec('shadow')).drafted, 3);
});

test('circuit breaker blocks an abnormal batch and raises a review item', async () => {
  const r = run({ world: { count: 160 } });
  const stats = await r.exec('live', { recentRunCounts: [] });
  // 160 issues -> lane A cap 40 (ramp) so only 40 planned: below the limit; disable the ramp to trigger it
  assert.equal(stats.skipped, null);
  const plan2 = planRun({ now: NOW, issues: r.w.issues, people: {}, settings: { rampActive: false } });
  const store = fakeStore(); const senders = fakeSenders();
  const s2 = await executePlan({ plan: plan2, mode: 'live', now: NOW, runId: 'r2', store, senders, issuesById: r.w.issuesById, people: r.w.people, settings: SETTINGS });
  assert.equal(s2.skipped, 'circuit_breaker');
  assert.equal(senders.sent.emails.length, 0);
  assert.equal(store.s.reviews[0].kind, 'send_failed');
});

test('at most one message per person per day', async () => {
  const r = run({});
  r.store.s.sentToday.add('p1');
  const stats = await r.exec('live');
  assert.equal(stats.skippedAlreadyToday, 1);
  assert.equal(stats.sent, 2);
});

test('one failed send is recorded and reviewed but does not stop the others or advance its issue', async () => {
  const r = run({ senders: { failFor: 'p2@wldd.in' } });
  const stats = await r.exec('live');
  assert.equal(stats.failed, 1);
  assert.equal(stats.sent, 2);
  assert.deepEqual(r.store.s.applied.recipientIds.sort(), ['p1', 'p3']);
  assert.equal(r.store.s.messages.find((m) => m.to_address === 'p2@wldd.in').status, 'failed');
  assert.equal(r.store.s.reviews.at(-1).kind, 'send_failed');
});

test('a person without an email is skipped and reviewed, not crashed on', async () => {
  const r = run({});
  r.w.people.get('p1').email = null;
  const stats = await r.exec('live');
  assert.equal(stats.skippedNoEmail, 1);
  assert.equal(r.store.s.reviews[0].kind, 'needs_owner');
});

test('3rd nudge adds ONE short Slack ping; 4th nudge copies the manager, or reports a missing manager', async () => {
  const day = new Date('2026-10-09T05:30:00Z'); // Friday
  const mkRun = (count, person) => {
    const w = world({ count: 1, invoiceNudgeCount: count, extraPerson: person });
    w.issues[0].lastNudgedAt = '2026-10-05T05:30:00Z';
    const plan = planRun({ now: day, issues: w.issues, people: { p1: { enteredAt: 'x' } } });
    const store = fakeStore(); const senders = fakeSenders();
    return { plan, store, senders, exec: () => executePlan({ plan, mode: 'live', now: day, runId: 'r', store, senders, issuesById: w.issuesById, people: w.people, settings: SETTINGS }) };
  };
  const third = mkRun(2, {}); await third.exec();
  assert.equal(third.senders.sent.emails.length, 1);
  assert.equal(third.senders.sent.slacks.length, 1);

  const fourth = mkRun(3, { manager_email: 'boss@wldd.in' }); await fourth.exec();
  assert.deepEqual(fourth.senders.sent.emails[0].cc, ['boss@wldd.in']);
  assert.equal(fourth.senders.sent.slacks.length, 0);

  const noBoss = mkRun(3, {}); const st = await noBoss.exec();
  assert.equal(st.managerMissing, 1);
  assert.equal(noBoss.store.s.reviews[0].kind, 'manager_missing');
});
