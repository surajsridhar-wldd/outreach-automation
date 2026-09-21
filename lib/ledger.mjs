// Pure helpers for the unified tracker (used by the API routes, the page and the tests).

export const CATEGORY_LABELS = {
  invoice_approvals: 'Invoice approvals',
  creator_submissions: 'Creator submissions',
  screenshot_approvals: 'Screenshot approvals',
  pending_closings: 'Pending closings',
  pending_proposals: 'Pending proposals',
  zero_cost_services: 'Zero-cost services',
  revenue_mismatch: 'Revenue mismatch',
  wrong_margins: 'Wrong margins',
  missing_dms_entry: 'Missing DMS entry',
  other: 'Other',
};

/** Categories the owner can add by hand (the first six are found by the DMS check instead). */
export const MANUAL_CATEGORIES = ['revenue_mismatch', 'wrong_margins', 'missing_dms_entry', 'other'];

const LEGACY_TAGS = { PENDING_CLOSURE: 'pending_closings', PENDING_VENDOR_APPROVAL: 'invoice_approvals', PENDING_PROPOSAL: 'pending_proposals', NO_SERVOCE_COST: 'zero_cost_services', WRONG_MARGINS__COMPLETED_: 'wrong_margins', REVENUE_MISMATCH: 'revenue_mismatch', MISSING_DMS_ENTRY: 'missing_dms_entry' };

/** Old tracker tag ("WRONG_MARGINS__COMPLETED_") or any free text -> ledger category key. Empty -> 'other'. */
export function catKey(tagOrText) {
  const raw = String(tagOrText || '').trim();
  if (!raw) return 'other';
  if (LEGACY_TAGS[raw]) return LEGACY_TAGS[raw];
  const k = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  for (const key of Object.keys(CATEGORY_LABELS)) if (k === key || k === key.replace(/_/g, '')) return key;
  for (const [key, label] of Object.entries(CATEGORY_LABELS)) if (raw.toLowerCase() === label.toLowerCase()) return key;
  return k || 'other';
}

export const labelOf = (key) => CATEGORY_LABELS[key] || String(key || 'other').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Parses pasted CSV / TSV (quotes, embedded newlines). */
export function parseTable(text) {
  const t = String(text || '');
  const sep = (t.split('\n')[0] || '').includes('\t') ? '\t' : ',';
  const rows = []; let row = []; let field = ''; let inQuotes = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]; const next = t[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; } else if (ch === '"') inQuotes = false; else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === sep) { row.push(field.trim()); field = ''; }
    else if (ch === '\n') { row.push(field.trim()); if (row.some((f) => f)) rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field.trim() || row.length) { row.push(field.trim()); if (row.some((f) => f)) rows.push(row); }
  return rows;
}

/** Header row -> [{ name, email, campaign, issue, category }] (column names are matched loosely, like the old importer). */
export function normalizeRows(values) {
  if (!values || values.length < 2) return [];
  const headers = values[0].map((h) => String(h).trim().toLowerCase().replace(/[^a-z0-9]/g, '_'));
  const idx = (re) => headers.findIndex((h) => re.test(h));
  const ni = idx(/name|poc|lead/); const ei = idx(/email|mail/); const ci = idx(/campaign/); const ki = idx(/categ|type/);
  let ii = idx(/issue|error|problem|desc|note|message|text/);
  if (ii < 0) ii = headers.length - 1;
  return values.slice(1).filter((r) => r.some((f) => f && String(f).trim())).map((r) => ({
    name: String(r[ni >= 0 ? ni : 0] || '').trim(),
    email: ei >= 0 ? String(r[ei] || '').trim().toLowerCase() : '',
    campaign: ci >= 0 ? String(r[ci] || '').trim() : '',
    issue: String(r[ii] || '').trim(),
    category: ki >= 0 ? String(r[ki] || '').trim() : '',
  })).filter((r) => r.name || r.email);
}

/** Which tab an issue lives in. today = 'YYYY-MM-DD' (IST). */
export function tabOf(issue, today) {
  if (issue.state === 'draft') return 'outreach';
  if (issue.state === 'cleared') return 'resolved';
  if (issue.hold_until && issue.hold_until >= today) return 'snoozed';
  return 'inflight';
}

/** Small status chips shown on a row. */
export function chipsOf(issue, today) {
  const c = [];
  if (issue.source === 'manual') c.push('Manual');
  if (issue.owner_state && issue.owner_state !== 'active') c.push('Needs owner');
  if (issue.claimed_done_at && issue.state === 'open') c.push('Said done, still pending');
  if (issue.hold_until && issue.hold_until >= today && issue.state === 'open') c.push(`Snoozed to ${issue.hold_until}`);
  if (issue.auto_followups === false && issue.state === 'open') c.push('No automatic follow-ups');
  if ((issue.nudge_count || 0) >= 5 && issue.state === 'open') c.push('Ladder finished');
  return c;
}

/** A stable key for "is this the same manual issue?" (same person, campaign and category). */
export const dedupeKey = (ownerId, campaign, category) => `${ownerId}|${normName(campaign)}|${category}`;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-09-21' -> '21 Sep' */
export const fmtDay = (iso) => (iso ? `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}` : '');
const nextDay = (iso) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + 86400e3).toISOString().slice(0, 10);

/**
 * Why an issue is snoozed, in plain words. Automatic snoozes store "promise_with_date: <quote>", "hold: <quote>" or
 * "waiting on <who>"; a snooze you set stores your note (or "snoozed by you").
 * Returns { by: 'you'|'their reply'|'the system', why, resumes }  (resumes = the first day nudging can continue)
 */
export function holdInfo(i) {
  if (!i.hold_until) return null;
  const r = String(i.hold_reason || '').trim();
  let by = 'you'; let why = r && r !== 'snoozed by you' ? r : 'Snoozed by you';
  let m;
  if ((m = r.match(/^promise_with_date:\s*(.*)$/s))) { by = 'their reply'; why = `They promised a date${m[1] ? `: “${m[1]}”` : ''}`; }
  else if ((m = r.match(/^hold:\s*(.*)$/s))) { by = 'their reply'; why = `They asked for time${m[1] ? `: “${m[1]}”` : ''}`; }
  else if ((m = r.match(/^waiting on\s*(.*)$/s))) { by = 'their reply'; why = `They are waiting on ${m[1] || 'someone else'}`; }
  else if (/^released/.test(r)) { by = 'the system'; why = 'A snooze that ended because a new item appeared'; }
  return { by, why, until: i.hold_until, resumes: nextDay(i.hold_until) };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** One short line saying what is pending (DMS-found issues have no free text of their own). */
export function describeIssue(i) {
  if (i.issue_text) return i.issue_text;
  const n = i.item_count || 1;
  switch (i.category) {
    case 'invoice_approvals': return `${plural(n, 'vendor invoice', 'vendor invoices')} awaiting approval`;
    case 'creator_submissions': return `${plural(n, 'submitted creator link', 'submitted creator links')} awaiting approval`;
    case 'screenshot_approvals': return `${plural(n, 'screenshot', 'screenshots')} awaiting approval`;
    case 'pending_closings': return `Posting ended ${i.detail?.overdue_days ?? '?'} days ago and the campaign is still open`;
    case 'pending_proposals': return `In Proposal stage for ${i.detail?.pending_days ?? '?'} days`;
    case 'zero_cost_services': return `${i.detail?.service || 'A service'} has zero deliverables and zero internal cost${i.detail?.internal_note ? ` (note: ${String(i.detail.internal_note).slice(0, 90)})` : ''}`;
    default: return labelOf(i.category);
  }
}

/**
 * The status shown on a row, in the old tracker's colour language.
 * palette = a key of the old tracker's status colours (pending, sent, active, no_reply, followup, stalled, needs_review, snoozed, resolved).
 */
export function statusOf(i, today, lastReply) {
  if (i.state === 'draft') return { key: 'draft', label: 'Not sent yet', palette: 'pending' };
  if (i.state === 'cleared') return { key: 'resolved', label: i.resolved_by ? 'Resolved by you' : 'Resolved (DMS)', palette: 'resolved' };
  if (i.owner_state && i.owner_state !== 'active') return { key: 'noowner', label: 'No owner', palette: 'no_reply' };
  if (i.hold_until && i.hold_until >= today) return { key: 'snoozed', label: `Snoozed till ${fmtDay(i.hold_until)}`, palette: 'snoozed' };
  if (i.claimed_done_at) return { key: 'saiddone', label: 'Said done, still pending', palette: 'needs_review' };
  const repliedAfter = lastReply && (!i.last_nudged_at || new Date(lastReply.at) > new Date(i.last_nudged_at));
  if (repliedAfter && ['acknowledged', 'promise_with_date', 'hold', 'waiting_on', 'loop_in', 'redirect', 'blocked', 'question'].includes(lastReply.intent)) return { key: 'replied', label: 'Replied', palette: 'active' };
  const n = i.nudge_count || 0;
  if (n === 0) return { key: 'new', label: 'Not nudged yet', palette: 'pending' };
  if (n === 1) return { key: 'nudged', label: 'Nudged', palette: 'sent' };
  if (n <= 3) return { key: 'followup', label: `Follow-up ${n - 1} sent`, palette: 'followup' };
  if (n === 4) return { key: 'escalated', label: 'Manager copied', palette: 'stalled' };
  return { key: 'exhausted', label: 'Ladder finished', palette: 'stalled' };
}
