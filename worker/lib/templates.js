// Message templates. Pure functions: no I/O, no model. The wording for closings, proposals and
// vendor invoices is carried over from the messages the owner was already sending; creator
// submissions and screenshot approvals are new. Edit the text here.
//
// One numbered line per CAMPAIGN (a campaign with both creator links and screenshots pending is one
// line with two bullets), and the "what to do" guidance is written once per category present, so
// replies like "1. done, 3. need till Friday" map to campaigns.

import { CATEGORY, TIER } from './planner.js';

export const FIRST_SUBJECT = '[Action Required] Pending items on DMS';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The bullet under a campaign for one pending item. */
export function itemLine(item) {
  const n = item.item_count || 1;
  switch (item.category) {
    case CATEGORY.INVOICE: return `${plural(n, 'vendor invoice', 'vendor invoices')} awaiting your approval`;
    case CATEGORY.CREATOR: return `${plural(n, 'submitted creator link', 'submitted creator links')} awaiting your approval`;
    case CATEGORY.SCREENSHOT: return `${plural(n, 'screenshot', 'screenshots')} awaiting your approval`;
    case CATEGORY.CLOSING: return `posting ended ${item.detail?.overdue_days ?? 'several'} days ago and the campaign is still open`;
    case CATEGORY.PROPOSAL: return `in Proposal stage for ${item.detail?.pending_days ?? 'more than 14'} days`;
    default: return 'needs your attention';
  }
}

const GUIDANCE = {
  approvals: 'Approvals (invoices, creator links, screenshots): please open DMS and approve or reject each item.',
  [CATEGORY.INVOICE]: 'Invoices: please review the proof of work submitted by the vendor. Invoices that are not actioned by the end of the month are auto-rejected, and the vendor has to raise them again.',
  [CATEGORY.CLOSING]: 'Closings: if the campaign is still live or posting is in progress, please extend the posting end date on DMS. If posting is complete and only the final report is pending, please close the campaign on DMS soon.',
  [CATEGORY.PROPOSAL]: 'Proposals: please make sure the status on DMS is accurate. If the client is inactive or it is not moving forward, mark it Cancelled. If approved or underway, update it to Approved or Active. If discussions are still ongoing, no immediate action is needed, but please follow up with the relevant teams and update DMS once confirmed.',
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
    .map((g) => ({ ...g, items: [...g.items].sort((a, b) => TIER[a.category] - TIER[b.category] || a.category.localeCompare(b.category)), tier: Math.min(...g.items.map((i) => TIER[i.category])) }))
    .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));

  const itemNumbers = {};
  const blocks = ordered.map((g, idx) => {
    g.items.forEach((it) => { if (it.issueId) itemNumbers[it.issueId] = idx + 1; });
    const bullets = g.items.map((it) => `   - ${itemLine(it)}${it.claimedDone ? ' (You mentioned this was done, but DMS still shows it as pending. Please double-check.)' : ''}`);
    return `${idx + 1}. ${g.name}\n${bullets.join('\n')}`;
  });

  const intro =
    ctx.kind === 'first' ? 'We found the following items on DMS that need your action:'
    : ctx.final ? 'This is a final reminder. These items are still pending on DMS:'
    : 'Following up on my earlier email. These items are still showing as pending on DMS:';

  const cats = new Set(items.map((i) => i.category));
  const guidance = [];
  if ([CATEGORY.INVOICE, CATEGORY.CREATOR, CATEGORY.SCREENSHOT].some((c) => cats.has(c))) guidance.push(GUIDANCE.approvals);
  for (const c of [CATEGORY.INVOICE, CATEGORY.CLOSING, CATEGORY.PROPOSAL]) if (cats.has(c)) guidance.push(GUIDANCE[c]);

  const extras = [];
  if (ctx.hasInvoice && ctx.monthEnd) {
    extras.push(ctx.finalNoticeDay
      ? 'Because this is one of the last working days of the month, please approve or reject the pending invoices today.'
      : 'Reminder: invoices that are not approved or rejected by the end of this month are auto-rejected.');
  }

  const body = [
    `Hi ${firstName(ctx.name)},`,
    '',
    intro,
    '',
    blocks.join('\n\n'),
    ...(extras.length ? ['', ...extras] : []),
    '',
    'What to do:',
    ...guidance.map((g) => `- ${g}`),
    '',
    'Please reply to this email once done. If something is not yours to handle, tell me who should look at it. If you need a few days on any item, tell me the item number and the date you expect to close it.',
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
