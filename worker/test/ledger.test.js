import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catKey, labelOf, parseTable, normalizeRows, tabOf, chipsOf, dedupeKey } from '../../lib/ledger.mjs';

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
