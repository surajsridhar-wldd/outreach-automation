import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManualPlan, sendNow } from '../lib/manualSend.js';
import { buildEmail } from '../lib/templates.js';
import { planRun, CATEGORY } from '../lib/planner.js';
import { classifyZeroCost, ZERO_COST_SERVICES } from '../lib/zeroCost.js';

const P = new Map([['u1', { dms_user_id: 'u1', name: 'Priya Sharma', email: 'priya@wldd.in', manager_email: 'boss@wldd.in' }]]);
const mkStore = () => {
  const log = { msgs: [], items: [], updates: [], sent: [], applied: [], falseDone: [], review: [], today: 0 };
  return {
    log,
    hasMessageToday: async () => { log.today++; return true; },       // would block an automated send
    insertMessage: async (r) => { log.msgs.push(r); return `m${log.msgs.length}`; },
    insertItems: async (r) => log.items.push(...r), updateMessage: async (id, p) => log.updates.push([id, p]),
    savePersonThread: async () => {}, addReviewItem: async (i) => log.review.push(i),
    applySent: async (a) => log.applied.push(a), recordFalseDone: async (id) => { log.falseDone.push(id); return 1; },
  };
};
const draft = (o = {}) => ({ id: 'i1', category: 'revenue_mismatch', source: 'manual', state: 'draft', campaign_name: 'Ultraviolette x WLDD', item_count: 1, detail: {}, nudge_count: 0, owner_dms_user_id: 'u1', owner_state: 'active', issue_text: 'The value on DMS does not match Finance (498,000).\nPlease check and edit.', ...o });

test('a manual send goes out on a Tuesday night, even if the person was already messaged today, with the owner\'s own text', async () => {
  const store = mkStore(); const emails = [];
  const senders = { email: async (a) => { emails.push(a); return { threadId: 'T1', rfcMessageId: '<m@x>', gmailMessageId: 'g1' }; } };
  const now = new Date('2026-09-22T17:30:00Z');            // Tuesday, 23:00 IST: outside the window, not a nudge day
  const r = await sendNow({ issues: [draft()], people: [...P.values()], store, senders, now, settings: { senderName: 'Suraj', senderEmail: 's@wldd.in' } });
  assert.equal(r.sent, 1); assert.equal(r.skipped, null); assert.equal(store.log.today, 0, 'the once-a-day rule is not consulted');
  assert.match(emails[0].body, /1\. Ultraviolette x WLDD\n   - The value on DMS does not match Finance \(498,000\)\. Please check and edit\./);
  assert.equal(store.log.msgs[0].kind, 'first');
  assert.deepEqual(store.log.applied[0].issues, [{ id: 'i1', nudgeCount: 0 }]);   // becomes nudge 1, draft -> open in the store
});

test('a manual nudge counts as a nudge: the automation then waits two working days and continues the ladder from it', () => {
  const now = (d) => new Date(`${d}T05:30:00Z`);
  const issue = { id: 'i1', category: 'revenue_mismatch', ownerIds: ['u1'], needsOwner: false, nudgeCount: 1, lastNudgedAt: '2026-09-22T17:30:00Z', holdUntil: null, firstSeenAt: '2026-09-22T10:00:00Z' };
  const people = new Map([['u1', { enteredAt: '2026-09-22T17:30:00Z', skippedCount: 0 }]]);
  const wed = planRun({ now: now('2026-09-23'), issues: [issue], people });   // 1 working day after: waits
  assert.equal(wed.messages.length, 0); assert.equal(wed.excluded.spacing, 1);
  const fri = planRun({ now: now('2026-09-25'), issues: [issue], people });
  assert.equal(fri.messages.length, 1); assert.equal(fri.messages[0].items[0].nextN, 2); assert.equal(fri.messages[0].kind, 'followup');
});

test('manual issues in a brand-new category are ordinary citizens of the planner', () => {
  const issue = { id: 'i9', category: 'some_new_category', ownerIds: ['u1'], needsOwner: false, nudgeCount: 1, lastNudgedAt: '2026-09-14T05:00:00Z', holdUntil: null };
  const p = planRun({ now: new Date('2026-09-21T05:30:00Z'), issues: [issue], people: new Map([['u1', { enteredAt: 'x', skippedCount: 0 }]]) });
  assert.equal(p.messages.length, 1);
});

test('issues with no owner are reported, not sent; co-owners receive the manual send too', () => {
  const b = buildManualPlan({
    issues: [draft(), draft({ id: 'i2', owner_dms_user_id: null, owner_state: 'missing' })],
    overridesByIssue: new Map([['i1', [{ role: 'co_owner', dms_user_id: 'u2', lead_at_creation: 'u1', active: true }]]]), now: new Date('2026-09-22T06:00:00Z'),
  });
  assert.deepEqual(b.plan.messages.map((m) => m.recipientId).sort(), ['u1', 'u2']);
  assert.deepEqual(b.skipped, [{ issueId: 'i2', why: 'no owner to send to' }]);
});

test('manual bullets: a multi-line text collapses to one tidy line under the campaign', () => {
  const { body } = buildEmail([{ issueId: 'a', category: 'revenue_mismatch', campaign_name: 'C', item_count: 1, detail: {}, nextN: 1, issue_text: 'line one\n  line two' }], { name: 'X', senderName: 'S', kind: 'first' });
  assert.match(body, /1\. C\n   - line one line two/);
});

test('an excluded zero-cost case whose DMS note changed goes back to review; an unchanged note stays excluded', () => {
  const svc = Object.keys(ZERO_COST_SERVICES)[1];
  const campaigns = new Map([['a', { campaign_id: 'a', name: 'A', campaign_status: 'Complete', client_id: '1' }]]);
  const clients = new Map([['1', 'Real']]);
  const rows = (note) => [{ campaign_id: 'a', service_id: svc, notes: [note] }];
  const dec = new Map([[`a|${svc}`, { decision: 'exclude', note: 'Vendor Das did it' }]]);
  const same = classifyZeroCost(rows('Vendor  DAS did it '), campaigns, clients, dec);
  assert.deepEqual([same.issues.length, same.review.length, same.excluded.length], [0, 0, 1]);
  const changed = classifyZeroCost(rows('Now planned for next month'), campaigns, clients, dec);
  assert.deepEqual([changed.issues.length, changed.review.length, changed.excluded.length], [0, 1, 0]);
  assert.equal(changed.review[0].reason, 'note changed');
  assert.match(changed.review[0].key, /^a\|.+\|now planned/);
  const truncated = classifyZeroCost(rows('x'.repeat(400)), campaigns, clients, new Map([[`a|${svc}`, { decision: 'exclude', note: 'x'.repeat(200) }]]));
  assert.equal(truncated.excluded.length, 1, 'a stored 200-character copy still matches the full note');
});
