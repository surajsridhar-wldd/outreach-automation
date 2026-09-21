// Per-item nudge tracking (pure). An "issue" is a campaign x category; its "items" are the individual invoices, creator
// links or screenshot uploads inside it. The ladder counts nudges PER ITEM:
//   - a new item that appears later (a new invoice after month-end rejection, a new screenshot upload) starts at 0
//   - an item that is approved stops counting; if only new items remain, the issue's count falls back to theirs
//   - the issue's own nudge_count / last_nudged_at are always the MAX over its open items, so the planner, the manager
//     copy (from the 4th nudge) and the ladder end all follow the most-chased item that is still pending
// One-per-campaign categories (closings, proposals, zero-cost services, hand-added issues) have a single item 'main'.

export const MAIN = 'main';

const ms = (t) => (t ? new Date(t).getTime() : null);

/**
 * issue:    { id, nudge_count, last_nudged_at, hold_until }
 * wanted:   [{ key, at }] what DMS says is pending now (at = when DMS created/uploaded it, or null)
 * existing: open item rows for this issue [{ id, item_key, nudge_count, last_nudged_at }]
 * Returns { insert:[row], clear:[itemId], issueUpdate:{...}|null, releaseHold:boolean }
 */
export function planItemSync({ issue, wanted, existing, nowIso }) {
  const wantedKeys = new Set(wanted.map((w) => w.key));
  const existingKeys = new Set(existing.map((e) => e.item_key));
  const clear = existing.filter((e) => !wantedKeys.has(e.item_key)).map((e) => e.id);
  const introducing = existing.length === 0;            // first time this issue is tracked per item (migration or brand-new issue)
  const insert = [];
  for (const w of wanted) {
    if (existingKeys.has(w.key)) continue;
    let count = 0; let last = null;
    if (introducing && (issue.nudge_count || 0) > 0) {
      // Items that already existed when the issue was last nudged inherit its history; items created after do not.
      const createdAfterLastNudge = w.at && issue.last_nudged_at && ms(w.at) > ms(issue.last_nudged_at);
      if (!createdAfterLastNudge) { count = issue.nudge_count; last = issue.last_nudged_at; }
    }
    insert.push({ issue_id: issue.id, item_key: w.key, item_created_at: w.at || null, first_seen_at: nowIso, nudge_count: count, last_nudged_at: last });
  }
  const remaining = [...existing.filter((e) => wantedKeys.has(e.item_key)), ...insert.map((i) => ({ nudge_count: i.nudge_count, last_nudged_at: i.last_nudged_at }))];
  const nudge_count = remaining.reduce((m, r) => Math.max(m, r.nudge_count || 0), 0);
  const lastMs = remaining.map((r) => ms(r.last_nudged_at)).filter((x) => x != null);
  const last_nudged_at = lastMs.length ? new Date(Math.max(...lastMs)).toISOString() : null;
  const changed = nudge_count !== (issue.nudge_count || 0) || ms(last_nudged_at) !== ms(issue.last_nudged_at);
  // A snooze is about the items you knew of: a brand-new item on a snoozed issue ends the snooze.
  const releaseHold = !introducing && insert.length > 0;
  return { insert, clear, issueUpdate: changed ? { nudge_count, last_nudged_at } : null, releaseHold };
}

/** After a send: every open item of the issue gets one more nudge; the issue follows the max. */
export function planItemNudge({ issue, items, nowIso }) {
  const open = items.length ? items : [{ id: null, item_key: MAIN, nudge_count: issue.nudge_count || 0 }];
  const updated = open.map((i) => ({ ...i, nudge_count: (i.nudge_count || 0) + 1, last_nudged_at: nowIso }));
  return { createMain: items.length === 0, items: updated, issueUpdate: { nudge_count: Math.max(...updated.map((i) => i.nudge_count)), last_nudged_at: nowIso } };
}
