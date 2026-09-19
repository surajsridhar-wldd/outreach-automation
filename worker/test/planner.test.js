import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRun, applySent, breakerCheck, CATEGORY } from '../lib/planner.js';

// 11:00 IST == 05:30 UTC
const at = (date) => new Date(`${date}T05:30:00Z`);
const none = new Set();

function makeIssue(n, category, extra = {}) {
  return {
    id: `issue-${String(n).padStart(3, '0')}`,
    category,
    ownerIds: [`p${String(n).padStart(3, '0')}`],
    needsOwner: false,
    nudgeCount: 0,
    lastNudgedAt: null,
    holdUntil: null,
    firstSeenAt: `2026-10-01T05:30:00Z`,
    ...extra,
  };
}

/** 30 people with invoice approvals, 40 with creator/screenshot items, 40 with closings/proposals. */
function scenario110() {
  const issues = [];
  let n = 0;
  for (let i = 0; i < 30; i++) issues.push(makeIssue(++n, CATEGORY.INVOICE));
  for (let i = 0; i < 40; i++) issues.push(makeIssue(++n, i % 2 ? CATEGORY.CREATOR : CATEGORY.SCREENSHOT));
  for (let i = 0; i < 40; i++) issues.push(makeIssue(++n, i % 2 ? CATEGORY.CLOSING : CATEGORY.PROPOSAL));
  return issues;
}

test('ramp: 110 people, cap 40, nobody ever replies. Everybody is reached in week one and nobody is starved', () => {
  let issues = scenario110();
  let people = {};
  const contacted = new Set();
  const perRun = [];

  for (const day of ['2026-10-05', '2026-10-07', '2026-10-09']) {   // Mon, Wed, Fri
    const plan = planRun({ now: at(day), issues, people, holidays: none });
    plan.messages.forEach((m) => contacted.add(m.recipientId));
    perRun.push({ day, ...plan.counts });
    ({ issues, people } = applySent({ nowIso: at(day).toISOString(), issues, people, plan }));
  }

  // Monday: 70 people are eligible (the 40 closing/proposal people first appeared after last Wednesday's
  // weekly slot, so they wait for this Wednesday). The first 40 enter, most urgent first:
  // all 30 invoice people + 10 creator/screenshot people. 30 are deferred, not dropped.
  assert.deepEqual(perRun[0], { day: '2026-10-05', laneA: 40, laneADeferred: 30, laneB: 0, total: 40 });
  // Wednesday: the next 40 enter (lane A) and Monday's 40 get their follow-up (lane B, not capped)
  assert.deepEqual(perRun[1], { day: '2026-10-07', laneA: 40, laneADeferred: 30, laneB: 40, total: 80 });
  // Friday: the last 30 enter and everyone who is due again gets a follow-up
  assert.equal(perRun[2].laneA, 30);
  assert.equal(perRun[2].laneADeferred, 0);

  assert.equal(contacted.size, 110, 'every one of the 110 people was reached by Friday');
  const monday = planRun({ now: at('2026-10-05'), issues: scenario110(), people: {} });
  const mondayTiers = monday.messages.map((m) => m.items[0].category);
  assert.equal(mondayTiers.filter((c) => c === CATEGORY.INVOICE).length, 30, 'invoice approvals go first');
});

test('a person who is cleared in Mongo before their turn is simply absent; the next person moves up', () => {
  const issues = scenario110();
  const monday = planRun({ now: at('2026-10-05'), issues, people: {} });
  const monPeople = new Set(monday.messages.map((m) => m.recipientId));
  const state = applySent({ nowIso: at('2026-10-05').toISOString(), issues, people: {}, plan: monday });

  // Between Monday and Wednesday, 10 of the people who were waiting get sorted in Mongo.
  const waiting = state.issues.filter((i) => !monPeople.has(i.ownerIds[0]));
  const clearedIds = new Set(waiting.slice(0, 10).map((i) => i.id));
  const remaining = state.issues.filter((i) => !clearedIds.has(i.id));

  const wed = planRun({ now: at('2026-10-07'), issues: remaining, people: state.people });
  assert.equal(wed.counts.laneA, 40, 'the freed slots were used by the next people in line');
  for (const m of wed.messages) for (const it of m.items) assert.ok(!clearedIds.has(it.issueId));
});

test('someone skipped twice is promoted to the front of the entry queue', () => {
  const issues = [makeIssue(1, CATEGORY.CLOSING, { firstSeenAt: '2026-09-01T00:00:00Z' }), makeIssue(2, CATEGORY.INVOICE)];
  const people = { p001: { enteredAt: null, skippedCount: 2 } };
  const plan = planRun({ now: at('2026-10-07'), issues, people, settings: { laneACap: 1 } });
  assert.equal(plan.messages.length, 1);
  assert.equal(plan.messages[0].recipientId, 'p001');
  assert.deepEqual(plan.deferredRecipientIds, ['p002']);
});

test('holds: a hold lasts through its date, then nudging resumes', () => {
  const issue = makeIssue(1, CATEGORY.CREATOR, { holdUntil: '2026-10-07' });
  assert.equal(planRun({ now: at('2026-10-07'), issues: [issue] }).messages.length, 0);   // still held that day
  assert.equal(planRun({ now: at('2026-10-09'), issues: [issue] }).messages.length, 1);   // after the promised date
});

test('follow-up spacing: due 2 working days later (Mon -> Wed), not on the next day, not Fri -> Mon', () => {
  const base = makeIssue(1, CATEGORY.CREATOR, { nudgeCount: 1 });
  const sentMon = { ...base, lastNudgedAt: at('2026-10-05').toISOString() };
  assert.equal(planRun({ now: at('2026-10-07'), issues: [sentMon], people: { p001: { enteredAt: 'x' } } }).messages.length, 1);
  const sentFri = { ...base, lastNudgedAt: at('2026-10-09').toISOString() };
  assert.equal(planRun({ now: at('2026-10-12'), issues: [sentFri], people: { p001: { enteredAt: 'x' } } }).messages.length, 0);
  assert.equal(planRun({ now: at('2026-10-14'), issues: [sentFri], people: { p001: { enteredAt: 'x' } } }).messages.length, 1);
});

test('weekly items: once per Wednesday slot, stay due until sent, new items wait for the next slot', () => {
  const people = { p001: { enteredAt: 'x' } };
  const sentWed = makeIssue(1, CATEGORY.CLOSING, { nudgeCount: 1, lastNudgedAt: at('2026-10-07').toISOString(), firstSeenAt: '2026-09-01T00:00:00Z' });
  assert.equal(planRun({ now: at('2026-10-09'), issues: [sentWed], people }).messages.length, 0, 'not again on Friday');
  assert.equal(planRun({ now: at('2026-10-14'), issues: [sentWed], people }).messages.length, 1, 'due again next Wednesday');

  // Missed the Wednesday (e.g. capacity or a failed run): still due on Friday, not pushed a week.
  const missed = makeIssue(2, CATEGORY.PROPOSAL, { nudgeCount: 1, lastNudgedAt: at('2026-09-30').toISOString(), firstSeenAt: '2026-09-01T00:00:00Z', ownerIds: ['p001'] });
  assert.equal(planRun({ now: at('2026-10-09'), issues: [missed], people }).messages.length, 1);

  // First seen on Thursday: waits for next Wednesday's slot.
  const fresh = makeIssue(3, CATEGORY.CLOSING, { firstSeenAt: '2026-10-08T06:00:00Z', ownerIds: ['p001'] });
  assert.equal(planRun({ now: at('2026-10-09'), issues: [fresh], people }).messages.length, 0);
  assert.equal(planRun({ now: at('2026-10-14'), issues: [fresh], people }).messages.length, 1);
});

test('weekly items join the same message as Mon/Wed/Fri items for the same person on Wednesday', () => {
  const a = makeIssue(1, CATEGORY.SCREENSHOT, { ownerIds: ['p001'] });
  const b = makeIssue(2, CATEGORY.CLOSING, { ownerIds: ['p001'], firstSeenAt: '2026-09-01T00:00:00Z' });
  const plan = planRun({ now: at('2026-10-07'), issues: [a, b], people: {} });
  assert.equal(plan.messages.length, 1);
  assert.equal(plan.messages[0].items.length, 2);
});

test('ladder: manager copied from the 4th nudge, 5th is final, then the item leaves the automatic flow', () => {
  const people = { p001: { enteredAt: 'x' } };
  const mk = (count) => makeIssue(1, CATEGORY.CREATOR, { nudgeCount: count, lastNudgedAt: at('2026-10-05').toISOString() });
  const day = at('2026-10-09');
  assert.equal(planRun({ now: day, issues: [mk(2)], people }).messages[0].ccManager, false);
  assert.equal(planRun({ now: day, issues: [mk(3)], people }).messages[0].ccManager, true);
  assert.equal(planRun({ now: day, issues: [mk(4)], people }).messages[0].final, true);
  const done = planRun({ now: day, issues: [mk(5)], people });
  assert.equal(done.messages.length, 0);
  assert.deepEqual(done.exhaustedIssueIds, ['issue-001']);
});

test('month-end invoice push: daily, holds ignored, no ladder cap; other categories stay on Mon/Wed/Fri', () => {
  const people = { p001: { enteredAt: 'x' }, p002: { enteredAt: 'x' } };
  const inv = makeIssue(1, CATEGORY.INVOICE, { nudgeCount: 6, holdUntil: '2026-10-30', lastNudgedAt: at('2026-10-23').toISOString() });
  const cre = makeIssue(2, CATEGORY.CREATOR);
  // Tuesday 27 Oct is inside the window (starts 23rd) but is not a Mon/Wed/Fri
  const tue = planRun({ now: at('2026-10-27'), issues: [inv, cre], people });
  assert.equal(tue.monthEnd, true);
  assert.deepEqual(tue.messages.map((m) => m.recipientId), ['p001']);
  // Already nudged today: not twice
  const again = planRun({ now: at('2026-10-27'), issues: [{ ...inv, lastNudgedAt: at('2026-10-27').toISOString() }], people });
  assert.equal(again.messages.length, 0);
  // Last two working days are "final notice"
  const last = planRun({ now: at('2026-10-30'), issues: [inv], people });
  assert.equal(last.messages[0].final, true);
});

test('needs-owner issues are never sent, only reported', () => {
  const issue = makeIssue(1, CATEGORY.INVOICE, { needsOwner: true, ownerIds: [] });
  const plan = planRun({ now: at('2026-10-05'), issues: [issue] });
  assert.equal(plan.messages.length, 0);
  assert.deepEqual(plan.needsOwnerIssueIds, ['issue-001']);
});

test('a co-owner receives the item too, and the item is only counted as nudged once', () => {
  const issue = makeIssue(1, CATEGORY.INVOICE, { ownerIds: ['lead', 'coowner'] });
  const plan = planRun({ now: at('2026-10-05'), issues: [issue] });
  assert.deepEqual(plan.messages.map((m) => m.recipientId).sort(), ['coowner', 'lead']);
  const next = applySent({ nowIso: at('2026-10-05').toISOString(), issues: [issue], people: {}, plan });
  assert.equal(next.issues[0].nudgeCount, 1);
});

test('on a non-nudge day nothing is planned', () => {
  const plan = planRun({ now: at('2026-10-06'), issues: scenario110() });
  assert.equal(plan.nudgeDay, false);
  assert.equal(plan.messages.length, 0);
});

test('circuit breaker refuses an abnormal batch', () => {
  assert.equal(breakerCheck(100, []).ok, true);
  assert.equal(breakerCheck(151, []).ok, false);
  assert.equal(breakerCheck(200, [60, 70, 80]).ok, false);  // limit = max(150, 2*70) = 150
  assert.equal(breakerCheck(200, [100, 110, 120]).ok, true); // limit = max(150, 2*110) = 220
  assert.equal(breakerCheck(400, [100, 110, 120]).ok, false);
});
