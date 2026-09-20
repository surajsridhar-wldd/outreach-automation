// Carries the manual outreach history (the legacy tracker) over to the automated ledger, so a person who
// was already chased by hand is followed up, not greeted like a stranger, and their old email threads are
// read for replies ("need till end of Sep") exactly like the new ones.
//
// Pure planning here; the caller does the I/O. Only the automated categories carry over, and only when the
// legacy record is for the SAME person on the SAME campaign as a currently open issue.

export const LEGACY_TO_CATEGORY = {
  PENDING_CLOSURE: 'pending_closings',
  PENDING_VENDOR_APPROVAL: 'invoice_approvals',
  PENDING_PROPOSAL: 'pending_proposals',
  NO_SERVOCE_COST: 'zero_cost_services',
};

/** Zero-cost issues are per campaign AND service; the old records name the service inside the issue text. */
export const serviceCode = (text) => {
  const t = String(text || '');
  if (/twitter/i.test(t)) return 'tw';
  if (/\bORM\b/.test(t)) return 'orm';
  if (/content creation|illustration/i.test(t)) return 'cc';
  if (/offline/i.test(t)) return 'off';
  return '';
};
const keyOf = (category, campaign, email, svcText) => `${category}|${norm(campaign)}|${String(email || '').toLowerCase()}${category === 'zero_cost_services' ? `|${serviceCode(svcText)}` : ''}`;

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * records: [{ id, category, email, campaign, gmail_thread_id, gmail_message_id, contactEmail }]
 * history: Map recordId -> [{ action, created_at }]
 * issues:  open issues [{ id, category, campaign_name, owner_dms_user_id, nudge_count, last_nudged_at }]
 * people:  Map dmsUserId -> { email }
 * Returns { threads:[{ threadId, gmailMessageId, recipientId, to, sentAt, kind, issueIds }], issueUpdates:[{ id, nudge_count, last_nudged_at }], skipped:[...] }
 */
export function planCarryOver({ records, history, issues, people }) {
  const byKey = new Map();
  for (const i of issues) {
    const owner = people.get(i.owner_dms_user_id);
    if (!owner?.email) continue;
    byKey.set(keyOf(i.category, i.campaign_name, owner.email, i.detail?.service), i);
  }
  const skipped = [];
  const perIssue = new Map();      // issueId -> { nudges, last }
  const threads = new Map();       // threadId|recipient -> thread

  for (const r of records) {
    const category = LEGACY_TO_CATEGORY[r.category];
    if (!category) continue;
    const issue = byKey.get(keyOf(category, r.campaign, r.contactEmail, r.issueText));
    if (!issue) { skipped.push({ id: r.id, why: 'no open issue for the same person and campaign' }); continue; }
    const sends = (history.get(r.id) || []).filter((h) => h.action === 'sent' || h.action === 'followup_sent').map((h) => new Date(h.created_at)).sort((a, b) => a - b);
    if (!sends.length) { skipped.push({ id: r.id, why: 'no send recorded' }); continue; }
    const cur = perIssue.get(issue.id) || { nudges: 0, last: null };
    cur.nudges = Math.max(cur.nudges, sends.length);
    const last = sends.at(-1);
    if (!cur.last || last > cur.last) cur.last = last;
    perIssue.set(issue.id, cur);

    if (r.gmail_thread_id) {
      const key = `${r.gmail_thread_id}|${issue.owner_dms_user_id}`;
      const t = threads.get(key) || { threadId: r.gmail_thread_id, gmailMessageId: r.gmail_message_id, recipientId: issue.owner_dms_user_id, to: r.contactEmail.toLowerCase(), sentAt: sends[0], nudges: 0, issueIds: [] };
      if (sends[0] < t.sentAt) t.sentAt = sends[0];
      t.nudges = Math.max(t.nudges, sends.length);
      if (!t.issueIds.includes(issue.id)) t.issueIds.push(issue.id);
      threads.set(key, t);
    }
  }

  const issueUpdates = [];
  for (const [id, v] of perIssue) {
    const issue = issues.find((i) => i.id === id);
    const newCount = Math.max(issue.nudge_count || 0, v.nudges);
    const newLast = !issue.last_nudged_at || new Date(issue.last_nudged_at) < v.last ? v.last : new Date(issue.last_nudged_at);
    if (newCount !== (issue.nudge_count || 0) || newLast.getTime() !== new Date(issue.last_nudged_at || 0).getTime()) {
      issueUpdates.push({ id, nudge_count: newCount, last_nudged_at: newLast.toISOString() });
    }
  }
  return {
    threads: [...threads.values()].map((t) => ({ ...t, sentAt: t.sentAt.toISOString(), kind: t.nudges > 1 ? 'followup' : 'first' })),
    issueUpdates, skipped,
  };
}
