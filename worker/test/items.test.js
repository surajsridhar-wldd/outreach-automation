import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planItemSync, planItemNudge } from '../lib/items.js';

const NOW = '2026-09-21T08:00:00.000Z';
const issue = (o = {}) => ({ id: 'i1', nudge_count: 0, last_nudged_at: null, hold_until: null, ...o });

test('first time an issue is tracked per item: items that already existed inherit its history, newer ones start at 0', () => {
  const p = planItemSync({
    issue: issue({ nudge_count: 3, last_nudged_at: '2026-09-11T05:00:00.000Z' }),
    wanted: [{ key: 'inv-old', at: '2026-08-12T00:00:00.000Z' }, { key: 'inv-new', at: '2026-09-15T00:00:00.000Z' }, { key: 'inv-unknown', at: null }],
    existing: [], nowIso: NOW,
  });
  const by = Object.fromEntries(p.insert.map((r) => [r.item_key, r.nudge_count]));
  assert.deepEqual(by, { 'inv-old': 3, 'inv-new': 0, 'inv-unknown': 3 });
  assert.equal(p.issueUpdate, null, 'the issue keeps the max (3): nothing to change');
  assert.equal(p.releaseHold, false, 'introducing items never touches a snooze');
});

test('a brand-new item on an already-chased issue starts at 0, does not reset the old ones, and ends a snooze', () => {
  const p = planItemSync({
    issue: issue({ nudge_count: 3, last_nudged_at: '2026-09-19T05:00:00.000Z', hold_until: '2026-09-30' }),
    wanted: [{ key: 'a', at: null }, { key: 'b', at: '2026-09-21T01:00:00.000Z' }],
    existing: [{ id: 'x1', item_key: 'a', nudge_count: 3, last_nudged_at: '2026-09-19T05:00:00.000Z' }], nowIso: NOW,
  });
  assert.deepEqual(p.insert.map((r) => [r.item_key, r.nudge_count]), [['b', 0]]);
  assert.equal(p.issueUpdate, null); assert.equal(p.releaseHold, true);
});

test('when the chased items are approved and only a new one remains, the count falls back to the new item (no unfair escalation)', () => {
  const p = planItemSync({
    issue: issue({ nudge_count: 3, last_nudged_at: '2026-09-19T05:00:00.000Z' }),
    wanted: [{ key: 'new-upload', at: '2026-09-21T01:00:00.000Z' }],
    existing: [{ id: 'x1', item_key: 'old-upload', nudge_count: 3, last_nudged_at: '2026-09-19T05:00:00.000Z' }], nowIso: NOW,
  });
  assert.deepEqual(p.clear, ['x1']);
  assert.deepEqual(p.issueUpdate, { nudge_count: 0, last_nudged_at: null });
});

test('the issue follows its most-chased open item; approving that one lowers it to the next', () => {
  const p = planItemSync({
    issue: issue({ nudge_count: 4, last_nudged_at: '2026-09-19T05:00:00.000Z' }),
    wanted: [{ key: 'b', at: null }],
    existing: [{ id: 'x1', item_key: 'a', nudge_count: 4, last_nudged_at: '2026-09-19T05:00:00.000Z' }, { id: 'x2', item_key: 'b', nudge_count: 1, last_nudged_at: '2026-09-15T05:00:00.000Z' }], nowIso: NOW,
  });
  assert.deepEqual(p.clear, ['x1']);
  assert.deepEqual(p.issueUpdate, { nudge_count: 1, last_nudged_at: '2026-09-15T05:00:00.000Z' });
});

test('an untouched issue produces no writes', () => {
  const p = planItemSync({ issue: issue({ nudge_count: 1, last_nudged_at: '2026-09-15T05:00:00.000Z' }), wanted: [{ key: 'a', at: null }], existing: [{ id: 'x1', item_key: 'a', nudge_count: 1, last_nudged_at: '2026-09-15T05:00:00.000Z' }], nowIso: NOW });
  assert.deepEqual([p.insert.length, p.clear.length, p.issueUpdate, p.releaseHold], [0, 0, null, false]);
});

test('a send gives every open item one more nudge; a hand-added issue gets its single item created', () => {
  const s = planItemNudge({ issue: { nudge_count: 3 }, items: [{ id: 'x1', item_key: 'a', nudge_count: 3 }, { id: 'x2', item_key: 'b', nudge_count: 0 }], nowIso: NOW });
  assert.deepEqual(s.items.map((i) => i.nudge_count), [4, 1]);
  assert.deepEqual(s.issueUpdate, { nudge_count: 4, last_nudged_at: NOW });
  const m = planItemNudge({ issue: { nudge_count: 0 }, items: [], nowIso: NOW });
  assert.equal(m.createMain, true); assert.equal(m.issueUpdate.nudge_count, 1);
});

test('scenario: a screenshot is chased three times and approved; the campaign gets a new upload weeks later: it is treated as brand new', () => {
  let it = { id: 'x1', item_key: 'sub1:shotA', nudge_count: 0, last_nudged_at: null };
  for (let n = 0; n < 3; n++) it = { ...it, nudge_count: planItemNudge({ issue: { nudge_count: it.nudge_count }, items: [it], nowIso: NOW }).items[0].nudge_count };
  assert.equal(it.nudge_count, 3);
  // shotA approved (gone), the DMS later flags shotB for the same submission: same issue row is cleared and a new one opens, or the same row continues:
  const p = planItemSync({ issue: issue({ nudge_count: 3, last_nudged_at: NOW }), wanted: [{ key: 'sub1:shotB', at: '2026-10-05T00:00:00.000Z' }], existing: [it], nowIso: '2026-10-05T08:00:00.000Z' });
  assert.deepEqual(p.issueUpdate, { nudge_count: 0, last_nudged_at: null });
  assert.equal(p.insert[0].nudge_count, 0);
});
