import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catKey, labelOf, parseTable, normalizeRows, tabOf, chipsOf, dedupeKey, describeIssue, statusOf, holdInfo, fmtDay } from '../../lib/ledger.mjs';

test('old tracker tags and free text map to ledger categories', () => {
  assert.equal(catKey('WRONG_MARGINS__COMPLETED_'), 'wrong_margins');
  assert.equal(catKey('NO_SERVOCE_COST'), 'zero_cost_services');
  assert.equal(catKey('Revenue mismatch'), 'revenue_mismatch');
  assert.equal(catKey('missing dms entry'), 'missing_dms_entry');
  assert.equal(catKey(''), 'other');
  assert.equal(catKey('Brand New Thing'), 'brand_new_thing');
  assert.equal(labelOf('brand_new_thing'), 'Brand new thing');
});

test('pasted tables: commas or tabs, quotes and newlines inside quotes, loose column names', () => {
  const rows = normalizeRows(parseTable('POC Name,Email,Campaign,Issue,Category\n"Priya Sharma",Priya@wldd.in,Alpha,"Value differs,\nplease check",Revenue mismatch\n,,,,\nRavi,ravi@wldd.in,Beta,Fix margin,Wrong margins'));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { name: 'Priya Sharma', email: 'priya@wldd.in', campaign: 'Alpha', issue: 'Value differs,\nplease check', category: 'Revenue mismatch' });
  const tsv = normalizeRows(parseTable('name\temail\tissue\nA\ta@wldd.in\tx'));
  assert.equal(tsv[0].issue, 'x'); assert.equal(tsv[0].campaign, '');
});

test('tabs and chips follow the same rules everywhere', () => {
  const today = '2026-09-21';
  assert.equal(tabOf({ state: 'draft' }, today), 'outreach');
  assert.equal(tabOf({ state: 'cleared' }, today), 'resolved');
  assert.equal(tabOf({ state: 'open', hold_until: '2026-09-30' }, today), 'snoozed');
  assert.equal(tabOf({ state: 'open', hold_until: '2026-09-20' }, today), 'inflight');
  assert.equal(tabOf({ state: 'open' }, today), 'inflight');
  assert.deepEqual(chipsOf({ state: 'open', source: 'manual', owner_state: 'deleted', claimed_done_at: 'x', auto_followups: false, nudge_count: 5 }, today),
    ['Manual', 'Needs owner', 'Said done, still pending', 'No automatic follow-ups', 'Ladder finished']);
  assert.equal(dedupeKey('u1', ' Alpha  Campaign ', 'wrong_margins'), 'u1|alpha campaign|wrong_margins');
});

test('rows describe themselves and carry a status in the old tracker colours', () => {
  assert.equal(describeIssue({ category: 'screenshot_approvals', item_count: 3 }), '3 screenshots awaiting approval');
  assert.equal(describeIssue({ category: 'pending_closings', detail: { overdue_days: 12 } }), 'Posting ended 12 days ago and the campaign is still open');
  assert.match(describeIssue({ category: 'zero_cost_services', detail: { service: 'ORM', internal_note: 'Das' } }), /ORM has zero deliverables.*note: Das/);
  assert.equal(describeIssue({ category: 'wrong_margins', issue_text: 'Margin is 100%' }), 'Margin is 100%');
  const t = '2026-09-21';
  const s = (o, r) => statusOf({ state: 'open', nudge_count: 0, ...o }, t, r);
  assert.deepEqual([s({ state: 'draft' }).palette, s({ state: 'cleared' }).palette, s({}).label], ['pending', 'resolved', 'Not nudged yet']);
  assert.equal(s({ nudge_count: 1 }).palette, 'sent'); assert.equal(s({ nudge_count: 3 }).palette, 'followup');
  assert.equal(s({ nudge_count: 4 }).label, 'Manager copied'); assert.equal(s({ nudge_count: 5 }).label, 'Ladder finished');
  assert.equal(s({ nudge_count: 2, hold_until: '2026-09-30' }).key, 'snoozed');
  assert.equal(s({ nudge_count: 2, claimed_done_at: 'x' }).key, 'saiddone');
  assert.equal(s({ owner_state: 'deleted' }).key, 'noowner');
  assert.equal(s({ nudge_count: 1, last_nudged_at: '2026-09-21T05:00:00Z' }, { intent: 'promise_with_date', at: '2026-09-21T07:00:00Z' }).key, 'replied');
  assert.equal(s({ nudge_count: 1, last_nudged_at: '2026-09-21T05:00:00Z' }, { intent: 'acknowledged', at: '2026-09-20T07:00:00Z' }).key, 'nudged', 'an old reply does not count as an answer to a newer nudge');
});

test('snoozes explain themselves in plain words', () => {
  assert.equal(fmtDay('2026-09-21'), '21 Sep');
  const a = holdInfo({ hold_until: '2026-09-21', hold_reason: "promise_with_date: I'll check these on the DMS and get them sorted today" });
  assert.deepEqual(a, { by: 'their reply', why: "They promised a date: “I'll check these on the DMS and get them sorted today”", until: '2026-09-21', resumes: '2026-09-22' });
  assert.equal(holdInfo({ hold_until: '2026-09-30', hold_reason: 'hold: need a week' }).why, 'They asked for time: “need a week”');
  assert.equal(holdInfo({ hold_until: '2026-09-30', hold_reason: 'waiting on the client' }).why, 'They are waiting on the client');
  assert.deepEqual(holdInfo({ hold_until: '2026-09-30', hold_reason: 'snoozed by you' }), { by: 'you', why: 'Snoozed by you', until: '2026-09-30', resumes: '2026-10-01' });
  assert.equal(holdInfo({ hold_until: '2026-09-30', hold_reason: 'Client on leave' }).why, 'Client on leave');
  assert.equal(holdInfo({}), null);
  assert.equal(statusOf({ state: 'open', nudge_count: 1, hold_until: '2026-09-30' }, '2026-09-21').label, 'Snoozed till 30 Sep');
});
