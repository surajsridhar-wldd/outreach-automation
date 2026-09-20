import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCarryOver } from '../lib/carryover.js';

const people = new Map([['u1', { email: 'priya@wldd.in' }], ['u2', { email: 'ravi@wldd.in' }]]);
const issues = [
  { id: 'i1', category: 'pending_closings', campaign_name: 'Alpha ', owner_dms_user_id: 'u1', nudge_count: 0, last_nudged_at: null },
  { id: 'i2', category: 'invoice_approvals', campaign_name: 'Beta', owner_dms_user_id: 'u1', nudge_count: 0, last_nudged_at: null },
  { id: 'i3', category: 'pending_closings', campaign_name: 'Gamma', owner_dms_user_id: 'u2', nudge_count: 1, last_nudged_at: '2026-09-15T05:00:00Z' },
];
const h = (...d) => d.map((x, i) => ({ action: i ? 'followup_sent' : 'sent', created_at: x }));

test('same person + same campaign carries the send count, last date and thread', () => {
  const p = planCarryOver({
    records: [
      { id: 'r1', category: 'PENDING_CLOSURE', campaign: 'alpha', contactEmail: 'Priya@wldd.in', gmail_thread_id: 'T1', gmail_message_id: 'g1' },
      { id: 'r2', category: 'PENDING_VENDOR_APPROVAL', campaign: 'Beta', contactEmail: 'priya@wldd.in', gmail_thread_id: 'T1', gmail_message_id: 'g1' },
    ],
    history: new Map([['r1', h('2026-08-20T05:00:00Z', '2026-08-25T05:00:00Z', '2026-09-11T05:00:00Z')], ['r2', h('2026-09-11T05:00:00Z')]]),
    issues, people,
  });
  assert.equal(p.threads.length, 1);
  assert.deepEqual(p.threads[0].issueIds.sort(), ['i1', 'i2']);
  assert.equal(p.threads[0].sentAt, '2026-08-20T05:00:00.000Z');
  assert.equal(p.threads[0].kind, 'followup');
  const u = Object.fromEntries(p.issueUpdates.map((x) => [x.id, x]));
  assert.equal(u.i1.nudge_count, 3); assert.equal(u.i1.last_nudged_at, '2026-09-11T05:00:00.000Z');
  assert.equal(u.i2.nudge_count, 1);
});

test('a different person on the same campaign, an unknown campaign, or no send is not carried', () => {
  const p = planCarryOver({
    records: [
      { id: 'r1', category: 'PENDING_CLOSURE', campaign: 'Alpha', contactEmail: 'ravi@wldd.in', gmail_thread_id: 'T1' },
      { id: 'r2', category: 'PENDING_CLOSURE', campaign: 'Nope', contactEmail: 'priya@wldd.in', gmail_thread_id: 'T2' },
      { id: 'r3', category: 'PENDING_CLOSURE', campaign: 'Gamma', contactEmail: 'ravi@wldd.in', gmail_thread_id: 'T3' },
      { id: 'r4', category: 'NO_SERVOCE_COST', campaign: 'Gamma', contactEmail: 'ravi@wldd.in', gmail_thread_id: 'T4' },
    ],
    history: new Map([['r1', h('2026-09-11T05:00:00Z')], ['r2', h('2026-09-11T05:00:00Z')]]), issues, people,
  });
  assert.equal(p.threads.length, 0); assert.equal(p.issueUpdates.length, 0); assert.equal(p.skipped.length, 3);
});

test('carry-over never lowers what the ledger already has', () => {
  const p = planCarryOver({
    records: [{ id: 'r1', category: 'PENDING_CLOSURE', campaign: 'Gamma', contactEmail: 'ravi@wldd.in', gmail_thread_id: 'T1' }],
    history: new Map([['r1', h('2026-08-01T05:00:00Z')]]), issues, people,
  });
  assert.equal(p.issueUpdates.length, 0);
});

test('zero-cost records match on campaign, person AND service', () => {
  const zi = [
    { id: 'z1', category: 'zero_cost_services', campaign_name: 'Rapido August', owner_dms_user_id: 'u1', detail: { service: 'Twitter Trend' }, nudge_count: 0, last_nudged_at: null },
    { id: 'z2', category: 'zero_cost_services', campaign_name: 'Rapido August', owner_dms_user_id: 'u1', detail: { service: 'Content Creation / Illustration Work' }, nudge_count: 0, last_nudged_at: null },
  ];
  const p = planCarryOver({
    records: [
      { id: 'r1', category: 'NO_SERVOCE_COST', campaign: 'Rapido August', contactEmail: 'priya@wldd.in', gmail_thread_id: 'T9', issueText: 'This campaign has Twitter Trend recorded with zero deliverables' },
      { id: 'r2', category: 'NO_SERVOCE_COST', campaign: 'Rapido August', contactEmail: 'priya@wldd.in', gmail_thread_id: 'T10', issueText: 'This campaign has ORM recorded with zero deliverables' },
    ],
    history: new Map([['r1', h('2026-08-20T05:00:00Z', '2026-08-25T05:00:00Z')], ['r2', h('2026-08-20T05:00:00Z')]]),
    issues: zi, people,
  });
  assert.deepEqual(p.issueUpdates.map((u) => [u.id, u.nudge_count]), [['z1', 2]]);
  assert.equal(p.threads.length, 1); assert.equal(p.threads[0].threadId, 'T9');
  assert.equal(p.skipped.length, 1, 'the ORM record has no matching ORM issue');
});
