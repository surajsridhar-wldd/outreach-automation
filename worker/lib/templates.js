// Message templates. Pure functions: no I/O, no model. The wording for closings, proposals and
// vendor invoices is carried over from the messages the owner was already sending; creator
// submissions and screenshot approvals are new. Edit the text here.

import { CATEGORY, TIER } from './planner.js';

export const FIRST_SUBJECT = '[Action Required] Pending items on DMS';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** One line of detail per item, by category. */
export function itemText(item) {
  const n = item.item_count || 1;
  switch (item.category) {
    case CATEGORY.INVOICE:
      return `${plural(n, 'vendor invoice is', 'vendor invoices are')} pending your approval. Please review the proof of work submitted by the vendor and approve or reject on DMS. Invoices that are not actioned by the end of the month are auto-rejected and the vendor has to raise them again.`;
    case CATEGORY.CREATOR:
      return `${plural(n, 'submitted creator link is', 'submitted creator links are')} awaiting your approval. Please approve or reject each one on DMS.`;
    case CATEGORY.SCREENSHOT:
      return `${plural(n, 'screenshot is', 'screenshots are')} awaiting your approval. Please approve or reject each one on DMS.`;
    case CATEGORY.CLOSING:
      return `the posting end date passed ${item.detail?.overdue_days ?? 'several'} days ago and the campaign is still open. If it is still live or posting is in progress, please extend the posting end date on DMS. If posting is complete and only the final report is pending, please close the campaign on DMS soon.`;
    case CATEGORY.PROPOSAL:
      return `it has been in Proposal stage for ${item.detail?.pending_days ?? 'more than 14'} days. Please make sure the status on DMS is accurate: if the client is inactive or it is not moving forward, mark it Cancelled; if approved or underway, update it to Approved or Active. If discussions are still ongoing, no immediate action is needed, but please follow up with the relevant teams and update DMS once confirmed.`;
    default:
      return 'this needs your attention on DMS.';
  }
}

const firstName = (name) => (name || '').trim().split(/\s+/)[0] || 'there';

/**
 * items: [{ category, campaign_name, item_count, detail, nextN, final, claimedDone }]
 * ctx:   { name, senderName, kind: 'first'|'followup', final, monthEnd, finalNoticeDay, hasInvoice }
 */
export function buildEmail(items, ctx) {
  const sorted = [...items].sort((a, b) => TIER[a.category] - TIER[b.category] || (a.campaign_name || '').localeCompare(b.campaign_name || ''));
  const intro =
    ctx.kind === 'first' ? 'We found the following items on DMS that need your action:'
    : ctx.final ? 'This is a final reminder. These items are still pending on DMS:'
    : 'Following up on my earlier email. These items are still showing as pending on DMS:';

  const lines = sorted.map((it, i) => {
    const note = it.claimedDone ? ' (You mentioned this was done, but DMS still shows it as pending. Please double-check.)' : '';
    return `${i + 1}. ${it.campaign_name}: ${itemText(it)}${note}`;
  });

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
    lines.join('\n\n'),
    ...(extras.length ? ['', ...extras] : []),
    '',
    'Please reply to this email once done. If something is not yours to handle, tell me who should look at it. If you need a few days on any item, tell me the item number and the date you expect to close it.',
    '',
    'Thanks,',
    ctx.senderName,
  ].join('\n');

  return { body, itemOrder: sorted.map((s) => s.issueId).filter(Boolean) };
}

/** Short Slack nudge that points back to the email thread. Used once, at the 3rd nudge. */
export function buildSlackPing({ name, count, emailDate }) {
  return `Hi ${firstName(name)}, following up on my email of ${emailDate}: ${plural(count, 'item', 'items')} on DMS ${count === 1 ? 'is' : 'are'} still pending. The details are in that email thread. A quick reply there (or here) with a date works.`;
}

export function rehearsalBanner({ intendedTo, cc }) {
  return `[REHEARSAL. This would have gone to ${intendedTo}${cc?.length ? `, cc ${cc.join(', ')}` : ''}. Nothing was sent to them.]`;
}
