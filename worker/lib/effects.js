// Pure: turns interpreted replies into the changes we make. Replies never resolve an issue (only Mongo
// does); they can pause nudging (holds, capped), add or move owners, or ask for a human to look.

import { addDays } from './time.js';
import { CATEGORY } from './planner.js';

export const DEFAULT_HOLD_CAPS = { invoice_approvals: 5, creator_submissions: 21, screenshot_approvals: 21, pending_closings: 21, pending_proposals: 35 };
// Benefit of the doubt: for a proposal, whatever timeline the lead gives we wait a week longer before reminding them again
// (deals often take longer than estimated, and pestering during talks does harm).
export const HOLD_GRACE_DAYS = { pending_proposals: 7 };
const MIN_CONFIDENCE = 0.6;
const DEFAULT_HOLD_DAYS = 7;
// Owner decision, 2026-09-27/28: once a lead names who actually did a zero-cost service, inventory is
// notified immediately (replies.js) to map it, and the item is held 14 days instead of nudging the
// lead about something they've already answered. If it is still unmapped after that, the follow-up
// goes on with inventory copied - it is their job from the moment they were told. hold_reason carries
// this exact marker so templates.js and executor.js can recognise those items later.
export const VENDOR_HOLD_DAYS = 14;
export const VENDOR_IDENTIFIED_PREFIX = 'vendor_identified: ';

// Owner decision, 2026-09-28: a blocked/question/dispute reply is someone asking the owner for
// help, not for another nudge - it stops ALL automated follow-up on the item (email, Slack, the
// 3rd-nudge ping, manager cc) until the owner has actually looked at the review item or this hold
// runs out, whichever comes first. Found via a real case: a lead asked "how do I proceed?", it sat
// unanswered in review, and the automation escalated to a Slack ping on schedule regardless - which
// reads as pestering someone who is waiting on a reply, not ignoring the automation.
export const REVIEW_HOLD_DAYS = 14;

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/**
 * interp: one entry from the model { item_no, intent, promised_date, target_person, evidence, confidence }
 * ctx: { todayIst, items:[{n,issueId,category,ownerId,holdRenewals}], fromOwner, senderId, holdCaps, resolvePerson(text)->{id}|{ambiguous}|null }
 * Returns { effects:[...], review:[{kind,issueId,note}], needsReview:boolean, issueIds:[...] }
 */
export function effectsFor(interp, ctx) {
  const out = { effects: [], review: [], needsReview: false, issueIds: [], notifyInventory: [] };
  const targets = interp.item_no == null ? ctx.items : ctx.items.filter((i) => i.n === interp.item_no);
  out.issueIds = targets.map((t) => t.issueId);
  if (interp.item_no != null && !targets.length) {
    out.needsReview = true;
    out.review.push({ kind: 'low_confidence', issueId: null, note: `Reply refers to item ${interp.item_no}, which is not in the reminder. "${interp.evidence}"` });
    return out;
  }
  if (!(interp.confidence >= MIN_CONFIDENCE) && interp.intent !== 'noise') {
    out.needsReview = true;
    for (const t of targets.slice(0, 1)) out.review.push({ kind: 'low_confidence', issueId: t.issueId, note: `Unsure how to read this reply (${interp.intent}, confidence ${interp.confidence}): "${interp.evidence}"` });
    return out;
  }
  const caps = { ...DEFAULT_HOLD_CAPS, ...(ctx.holdCaps || {}) };

  switch (interp.intent) {
    case 'done_claimed':
      // Only the owner can claim their own items done. Anything else is ignored for state.
      if (ctx.fromOwner) for (const t of targets) out.effects.push({ type: 'claimed_done', issueId: t.issueId });
      break;
    case 'promise_with_date':
    case 'hold': {
      if (!ctx.fromOwner) break;
      for (const t of targets) {
        const cap = caps[t.category] ?? 21;
        const latest = addDays(ctx.todayIst, cap);
        let until = isDate(interp.promised_date) && interp.promised_date >= ctx.todayIst ? interp.promised_date : addDays(ctx.todayIst, DEFAULT_HOLD_DAYS);
        until = addDays(until, HOLD_GRACE_DAYS[t.category] || 0);
        const capped = until > latest;
        if (capped) until = latest;
        out.effects.push({ type: 'hold', issueId: t.issueId, until, reason: `${interp.intent}: ${interp.evidence}`.slice(0, 200), capped });
      }
      break;
    }
    case 'waiting_on': {
      if (!ctx.fromOwner) break;
      // Waiting on someone else earns the default hold, and is worth a look if it is an internal person.
      for (const t of targets) out.effects.push({ type: 'hold', issueId: t.issueId, until: addDays(ctx.todayIst, Math.min(DEFAULT_HOLD_DAYS + (HOLD_GRACE_DAYS[t.category] || 0), caps[t.category] ?? 21)), reason: `waiting on ${interp.target_person || 'someone'}`, capped: false });
      break;
    }
    case 'loop_in':
    case 'redirect': {
      const who = interp.target_person ? ctx.resolvePerson(interp.target_person) : null;
      if (!who || who.ambiguous) {
        out.needsReview = true;
        for (const t of targets.slice(0, 1)) out.review.push({ kind: 'ambiguous_redirect', issueId: t.issueId, note: `${interp.intent} to "${interp.target_person || '?'}" could not be matched to exactly one active person. "${interp.evidence}"` });
        break;
      }
      // A redirect only replaces the lead when the OWNER hands it over; a loop-in adds the person.
      const role = interp.intent === 'redirect' && ctx.fromOwner ? 'reassigned_to' : 'co_owner';
      for (const t of targets) {
        if (who.id === t.ownerId) continue;
        out.effects.push({ type: 'owner', issueId: t.issueId, dmsUserId: who.id, role, replaces: role === 'reassigned_to' ? ctx.senderId : null, leadAtCreation: t.ownerId, createPerson: who.create || null });
      }
      break;
    }
    case 'blocked':
    case 'question':
    case 'dispute':
      out.needsReview = true;
      for (const t of targets.slice(0, 1)) out.review.push({ kind: interp.intent, issueId: t.issueId, note: `"${interp.evidence}"` });
      // Pause every item this reply touches, not just the one named in the review item - a person
      // asking for help on item 2 should not keep getting chased on item 2 while only item 1 shows
      // up in the queue.
      for (const t of targets) out.effects.push({ type: 'hold', issueId: t.issueId, until: addDays(ctx.todayIst, REVIEW_HOLD_DAYS), reason: `${interp.intent}: ${interp.evidence}`.slice(0, 200), capped: false });
      break;
    default: break; // acknowledged, noise, other: recorded only
  }

  // Vendor identified for a zero-cost item: on top of whatever intent above, (1) inventory is
  // notified RIGHT AWAY - mapping it is now their job, not something to sit on for 14 days - and
  // (2) the lead's own item goes on a 14-day hold instead of being nudged again about something
  // already answered. Only the owner's own account can supply this (same rule as done_claimed/
  // hold/etc above); the hold is pushed after the switch so its hold_reason - which carries the
  // actual vendor text - wins over a plain "hold"/"waiting_on" reason recorded above.
  if (ctx.fromOwner && interp.vendor_info) {
    for (const t of targets) {
      if (t.category !== CATEGORY.ZERO_COST) continue;
      out.notifyInventory.push({ issueId: t.issueId, vendorInfo: interp.vendor_info });
      out.effects.push({
        type: 'hold', issueId: t.issueId, until: addDays(ctx.todayIst, VENDOR_HOLD_DAYS),
        reason: `${VENDOR_IDENTIFIED_PREFIX}${interp.vendor_info}`.slice(0, 300), capped: false,
      });
    }
  }
  return out;
}
