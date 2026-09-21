// Message templates. Pure functions: no I/O, no model. Wording follows the messages the owner used to send
// by hand, shortened: each item carries its own instruction on one line, and a short "why" per category
// sits below the list. Edit the text here.
//
// One numbered line per CAMPAIGN, so replies like "1. done, 3. need till Friday" map to campaigns.

import { CATEGORY, tierOf } from './planner.js';

export const FIRST_SUBJECT = '[Action Required] Pending items on DMS';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The bullet under a campaign for one pending item: what it is and what to do. */
export function itemLine(item) {
  const n = item.item_count || 1;
  switch (item.category) {
    case CATEGORY.INVOICE: return `${plural(n, 'vendor invoice', 'vendor invoices')}: please review the proof of work and approve or reject`;
    case CATEGORY.CREATOR: return `${plural(n, 'submitted creator link', 'submitted creator links')}: please approve or reject`;
    case CATEGORY.SCREENSHOT: return `${plural(n, 'screenshot', 'screenshots')}: please approve or reject`;
    case CATEGORY.CLOSING: return `Posting ended ${item.detail?.overdue_days ?? 'several'} days ago. If the campaign is still live, please extend the posting end date on DMS. If posting is complete and only the final report is pending, please finish the report and close the campaign on DMS when it is ready, and reply with the date by which you expect to close it`;
    case CATEGORY.PROPOSAL: return `In Proposal stage for ${item.detail?.pending_days ?? 'more than 14'} days. If the campaign is not going ahead, please mark it Cancelled. If it is approved or underway, update the status to Approved or Active. If discussions are still ongoing, no immediate action is needed; reply and update DMS once confirmed`;
    case CATEGORY.ZERO_COST: {
      const note = item.detail?.internal_note ? ` (Internal note: ${String(item.detail.internal_note).slice(0, 160)})` : '';
      return `${item.detail?.service || 'A service'} shows zero deliverables and zero internal cost. If it was executed, please map the right vendors and deliverables: you can reach the inventory team at inventory@wldd.in. If it is planned for later, no action is needed yet. If it will never run, remove it from the campaign services${note}`;
    }
    // Items the owner added by hand carry their own text (the message he used to write himself).
    default: return item.issue_text ? String(item.issue_text).trim().replace(/\s*\n+\s*/g, ' ') : 'needs your attention';
  }
}

// Why it matters, once per category present (short on purpose).
const WHY = {
  approvals: 'Creator links and screenshots: timely approval helps better track metrics and reduce outstanding/pending actions.',
  [CATEGORY.INVOICE]: 'Invoices: vendors are paid only after approval, and invoices not actioned by the end of the month are auto-rejected, so the vendor has to raise them again.',
  [CATEGORY.CLOSING]: 'Closings: an open campaign past its posting date keeps revenue and margin reporting incomplete.',
  [CATEGORY.PROPOSAL]: 'Proposals: stale proposals distort the pipeline numbers.',
  [CATEGORY.ZERO_COST]: 'Services: unmapped services misstate campaign margins, which are reported to management.',
};

const firstName = (name) => (name || '').trim().split(/\s+/)[0] || 'there';

/**
 * items: [{ issueId, category, campaign_name, item_count, detail, nextN, claimedDone }]
 * ctx:   { name, senderName, kind: 'first'|'followup', final, monthEnd, finalNoticeDay, hasInvoice }
 * Returns { body, itemNumbers } where itemNumbers maps issueId -> the number of its campaign line.
 */
export function buildEmail(items, ctx) {
  const groups = new Map();
  for (const it of items) {
    const key = it.campaign_name || '(unnamed campaign)';
    if (!groups.has(key)) groups.set(key, { name: key, items: [] });
    groups.get(key).items.push(it);
  }
  const ordered = [...groups.values()]
    .map((g) => ({ ...g, items: [...g.items].sort((a, b) => tierOf(a.category) - tierOf(b.category) || a.category.localeCompare(b.category)), tier: Math.min(...g.items.map((i) => tierOf(i.category))) }))
    .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));

  const itemNumbers = {};
  const blocks = ordered.map((g, idx) => {
    g.items.forEach((it) => { if (it.issueId) itemNumbers[it.issueId] = idx + 1; });
    const mixed = ctx.kind !== 'first' && items.some((x) => x.nextN === 1) && items.some((x) => x.nextN > 1);
    const bullets = g.items.map((it) => `   - ${itemLine(it)}${mixed && it.nextN === 1 ? ' (new)' : ''}${it.claimedDone ? '. You mentioned this was done, but DMS still shows it as pending, so please double-check' : ''}`);
    return `${idx + 1}. ${g.name}\n${bullets.join('\n')}`;
  });

  const intro =
    ctx.kind === 'first' ? 'These items on DMS need your action:'
    : ctx.final ? 'This is a final reminder. These items are still pending on DMS:'
    : items.some((x) => x.nextN === 1) ? 'Following up on my earlier email, and adding some new items (marked new). These are pending on DMS:'
    : 'Following up on my earlier email. These items are still pending on DMS:';

  const cats = new Set(items.map((i) => i.category));
  const why = [];
  if ([CATEGORY.CREATOR, CATEGORY.SCREENSHOT].some((c) => cats.has(c))) why.push(WHY.approvals);
  for (const c of [CATEGORY.INVOICE, CATEGORY.CLOSING, CATEGORY.PROPOSAL, CATEGORY.ZERO_COST]) if (cats.has(c)) why.push(WHY[c]);

  const extras = [];
  if (ctx.hasInvoice && ctx.monthEnd) {
    extras.push(ctx.finalNoticeDay
      ? 'This is one of the last working days of the month, so please approve or reject the pending invoices today.'
      : 'Reminder: invoices not approved or rejected by the end of this month are auto-rejected.');
  }

  const body = [
    `Hi ${firstName(ctx.name)},`,
    '',
    intro,
    '',
    blocks.join('\n\n'),
    ...(extras.length ? ['', ...extras] : []),
    '',
    'Why this matters:',
    ...why.map((w) => `- ${w}`),
    '',
    'Reply here once done, or send the item number and a date if you need time. If something is not yours, tell me who should look at it.',
    '',
    'Thanks,',
    ctx.senderName,
  ].join('\n');

  return { body, itemNumbers };
}

/** Short Slack nudge that points back to the email thread. Used once, at the 3rd nudge. */
export function buildSlackPing({ name, count, emailDate }) {
  return `Hi ${firstName(name)}, following up on my email of ${emailDate}: ${plural(count, 'item', 'items')} on DMS ${count === 1 ? 'is' : 'are'} still pending. The details are in that email thread. A quick reply there (or here) with a date works.`;
}

export function rehearsalBanner({ intendedTo, cc }) {
  return `[REHEARSAL. This would have gone to ${intendedTo}${cc?.length ? `, cc ${cc.join(', ')}` : ''}. Nothing was sent to them.]`;
}
