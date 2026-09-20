// The nudge planner: pure functions, no I/O. Given the issues that the latest Mongo sync says
// are still open, decide who gets a message on a given run and what it covers.
//
// Design rules (see outreach-automation-spec.md):
//  - The queue is derived on every run, never stored. If an issue was cleared in Mongo it is
//    simply not passed in, so it uses no slot.
//  - Lane A = people not yet messaged by the new system. Capped per run during the ramp only.
//  - Lane B = people already in the system. Never capped (bounded by the ladder).
//  - Nothing is ever dropped because of the cap: whoever is not selected stays due and keeps
//    (and gains) priority.

import {
  istDate, workingDaysAfter, isNudgeDay, inMonthEndWindow, isFinalNoticeDay, weeklySlot,
} from './time.js';

export const CATEGORY = {
  INVOICE: 'invoice_approvals',
  CREATOR: 'creator_submissions',
  SCREENSHOT: 'screenshot_approvals',
  CLOSING: 'pending_closings',
  PROPOSAL: 'pending_proposals',
};

/** Lower tier = more urgent. */
export const TIER = {
  [CATEGORY.INVOICE]: 1,
  [CATEGORY.CREATOR]: 2,
  [CATEGORY.SCREENSHOT]: 2,
  [CATEGORY.CLOSING]: 3,
  [CATEGORY.PROPOSAL]: 3,
};

export const WEEKLY_CATEGORIES = new Set([CATEGORY.CLOSING, CATEGORY.PROPOSAL]);

export const DEFAULT_SETTINGS = {
  laneACap: 40,
  rampActive: true,
  spacingWorkingDays: 2,
  ladderMax: 5,            // after the 5th nudge an item goes to the review queue
  managerFromNudge: 4,     // manager is copied from the 4th nudge
  monthEndFromLastN: 6,    // invoice approvals go daily from the 6th-last working day
  finalNoticeLastN: 2,     // "approve or reject today" on the last 2 working days
  promoteAfterSkips: 2,    // skipped this many runs => front of the entry queue
  breakerFloor: 150,
  breakerMultiple: 2,
};

const NOT_ELIGIBLE = (reason) => ({ eligible: false, reason });

/**
 * Is this issue due today, and if so what nudge number would this be?
 * issue: { id, category, ownerIds[], needsOwner, nudgeCount, lastNudgedAt|null, holdUntil|null }
 * ctx:   { today, holidays, nudgeDay, monthEnd, slot, settings }
 */
export function evaluateIssue(issue, ctx) {
  const { today, monthEnd, nudgeDay, slot, settings } = ctx;
  if (issue.needsOwner || !issue.ownerIds?.length) return NOT_ELIGIBLE('needs_owner');

  const invoicePush = issue.category === CATEGORY.INVOICE && monthEnd;
  const nextN = (issue.nudgeCount || 0) + 1;

  // The ladder ends after the 5th nudge (except the month-end invoice push, which keeps going daily).
  if (!invoicePush && nextN > settings.ladderMax) return NOT_ELIGIBLE('ladder_exhausted');

  // A hold lasts through its date; nudging resumes strictly after it. Never honoured during the
  // month-end invoice push.
  if (!invoicePush && issue.holdUntil && today <= issue.holdUntil) return NOT_ELIGIBLE('on_hold');

  const lastDate = issue.lastNudgedAt ? istDate(issue.lastNudgedAt) : null;

  if (invoicePush) {
    if (lastDate === today) return NOT_ELIGIBLE('already_nudged_today');
    return { eligible: true, nextN };
  }

  if (!nudgeDay) return NOT_ELIGIBLE('not_a_nudge_day');

  if (WEEKLY_CATEGORIES.has(issue.category)) {
    // Due once per weekly slot (Wednesday), and stays due until it is actually sent.
    // An issue that first appeared after this week's slot waits for the next one, so a
    // brand-new closing/proposal is never followed up a day or two after its first notice.
    if (lastDate && lastDate >= slot) return NOT_ELIGIBLE('weekly_already_sent');
    if (today < slot) return NOT_ELIGIBLE('before_weekly_slot');
    if (issue.firstSeenAt && istDate(issue.firstSeenAt) > slot) return NOT_ELIGIBLE('waiting_for_weekly_slot');
    return { eligible: true, nextN };
  }

  if (lastDate && workingDaysAfter(lastDate, today, ctx.holidays) < settings.spacingWorkingDays) {
    return NOT_ELIGIBLE('spacing');
  }
  return { eligible: true, nextN };
}

/**
 * Plan one run.
 * people: Map or plain object of dmsUserId -> { enteredAt|null, skippedCount }
 * Returns the messages to send plus the bookkeeping the runner needs.
 */
export function planRun({ now, issues, people = {}, holidays = new Set(), settings: overrides = {} }) {
  const settings = { ...DEFAULT_SETTINGS, ...overrides };
  const today = istDate(now);
  const nudgeDay = isNudgeDay(today, holidays);
  const monthEnd = inMonthEndWindow(today, holidays, settings.monthEndFromLastN);
  const finalNoticeDay = isFinalNoticeDay(today, holidays, settings.finalNoticeLastN);
  const slot = weeklySlot(today, holidays);
  const ctx = { today, holidays, nudgeDay, monthEnd, slot, settings };

  const personOf = (id) => (people instanceof Map ? people.get(id) : people[id]) || { enteredAt: null, skippedCount: 0 };
  const excluded = {};
  const exhaustedIssueIds = [];
  const needsOwnerIssueIds = [];
  const byRecipient = new Map();

  for (const issue of issues) {
    const ev = evaluateIssue(issue, ctx);
    if (!ev.eligible) {
      excluded[ev.reason] = (excluded[ev.reason] || 0) + 1;
      if (ev.reason === 'ladder_exhausted') exhaustedIssueIds.push(issue.id);
      if (ev.reason === 'needs_owner') needsOwnerIssueIds.push(issue.id);
      continue;
    }
    const item = {
      issueId: issue.id,
      category: issue.category,
      nextN: ev.nextN,
      firstSeenAt: issue.firstSeenAt,
      final: ev.nextN === settings.ladderMax || (issue.category === CATEGORY.INVOICE && finalNoticeDay),
    };
    for (const rid of issue.ownerIds) {
      if (!byRecipient.has(rid)) byRecipient.set(rid, []);
      byRecipient.get(rid).push(item);
    }
  }

  const buildMessage = (recipientId, items, lane) => {
    const sorted = [...items].sort((a, b) => TIER[a.category] - TIER[b.category] || a.issueId.localeCompare(b.issueId));
    return {
      recipientId,
      lane,
      kind: sorted.every((i) => i.nextN === 1) ? 'first' : 'followup',
      ccManager: sorted.some((i) => i.nextN >= settings.managerFromNudge),
      final: sorted.some((i) => i.final),
      items: sorted,
    };
  };

  const laneA = [];
  const laneB = [];
  for (const [rid, items] of byRecipient) {
    const person = personOf(rid);
    (person.enteredAt ? laneB : laneA).push({ rid, items, person });
  }

  // Entry queue order: promoted (skipped too often) first, then most urgent tier, then the
  // longest-waiting item, then id for a fully deterministic order.
  const rankA = ({ rid, items, person }) => [
    (person.skippedCount || 0) >= settings.promoteAfterSkips ? 0 : 1,
    Math.min(...items.map((i) => TIER[i.category])),
    items.map((i) => i.firstSeenAt || '').sort()[0],
    rid,
  ];
  laneA.sort((x, y) => {
    const a = rankA(x), b = rankA(y);
    for (let i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return 0;
  });

  const selectedA = settings.rampActive ? laneA.slice(0, settings.laneACap) : laneA;
  const deferredA = settings.rampActive ? laneA.slice(settings.laneACap) : [];

  const messages = [
    ...selectedA.map((e) => buildMessage(e.rid, e.items, 'A')),
    ...laneB.map((e) => buildMessage(e.rid, e.items, 'B')).sort((a, b) => a.recipientId.localeCompare(b.recipientId)),
  ];

  return {
    today,
    nudgeDay,
    monthEnd,
    finalNoticeDay,
    weeklySlot: slot,
    messages,
    deferredRecipientIds: deferredA.map((e) => e.rid),
    // The ramp is over once nobody had to be deferred.
    rampDone: settings.rampActive && deferredA.length === 0,
    exhaustedIssueIds,
    needsOwnerIssueIds,
    excluded,
    counts: { laneA: selectedA.length, laneADeferred: deferredA.length, laneB: laneB.length, total: messages.length },
  };
}

/** Safety net against a bad query flagging everything: refuse to send an abnormal batch. */
export function breakerCheck(plannedCount, recentRunCounts = [], overrides = {}) {
  const s = { ...DEFAULT_SETTINGS, ...overrides };
  const avg = recentRunCounts.length ? recentRunCounts.reduce((a, b) => a + b, 0) / recentRunCounts.length : 0;
  const limit = Math.max(s.breakerFloor, Math.ceil(s.breakerMultiple * avg));
  return { ok: plannedCount <= limit, limit };
}

/**
 * State after a plan has been sent. Pure, so the runner and the tests share the same rules:
 * every issue in a sent message gets one more nudge (once, even if two owners received it),
 * recipients are marked as entered, and deferred entry-queue people gain a skip.
 */
export function applySent({ nowIso, issues, people, plan }) {
  const sentIssueIds = new Set(plan.messages.flatMap((m) => m.items.map((i) => i.issueId)));
  const nextIssues = issues.map((i) =>
    sentIssueIds.has(i.id) ? { ...i, nudgeCount: (i.nudgeCount || 0) + 1, lastNudgedAt: nowIso } : i);
  const nextPeople = { ...(people instanceof Map ? Object.fromEntries(people) : people) };
  for (const m of plan.messages) {
    const p = nextPeople[m.recipientId] || { enteredAt: null, skippedCount: 0 };
    nextPeople[m.recipientId] = { ...p, enteredAt: p.enteredAt || nowIso, skippedCount: 0 };
  }
  for (const rid of plan.deferredRecipientIds) {
    const p = nextPeople[rid] || { enteredAt: null, skippedCount: 0 };
    nextPeople[rid] = { ...p, skippedCount: (p.skippedCount || 0) + 1 };
  }
  return { issues: nextIssues, people: nextPeople };
}

/**
 * The entry cap is per DAY. People already brought in today (by an earlier run, a retry, or a second
 * dispatch) use it up, so the first-week volume can never be doubled by running twice.
 */
export function entryCapRemaining(cap, peopleRows, todayIst) {
  const enteredToday = peopleRows.filter((p) => p.entered_at && istDate(p.entered_at) === todayIst).length;
  return Math.max(0, cap - enteredToday);
}
