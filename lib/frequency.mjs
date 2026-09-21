// Frequency numbers computed from the unified ledger (pure, tested). One place for "how often do we chase, who needs it most,
// how long does each category take to clear".

const DAY = 86400000;
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

/**
 * issues:  [{ id, category, state, owner_dms_user_id, nudge_count, false_done_claims, hold_renewals, first_seen_at, cleared_at, last_nudged_at, source }]
 * people:  [{ dms_user_id, name, email, manager_email }]
 * sends:   [{ recipient_dms_user_id, sent_at, id }]                (real emails and DMs sent since the automation began)
 * replies: [{ sender_dms_user_id, received_at, in_reply_to_message_out_id }]
 * outs:    Map messageOutId -> sent_at ISO                         (to time the responses)
 * reassigned: Map dmsUserId -> number of issues handed over to someone else
 */
export function computeFrequency({ issues, people, sends = [], replies = [], outs = new Map(), reassigned = new Map(), now = new Date() }) {
  const nowMs = now.getTime();
  const open = issues.filter((i) => i.state === 'open');
  const cleared = issues.filter((i) => i.state === 'cleared');
  const daysToClear = (i) => (new Date(i.cleared_at) - new Date(i.first_seen_at)) / DAY;

  const cards = {
    open: open.length,
    nudgedOpen: open.filter((i) => (i.nudge_count || 0) > 0).length,
    notYetNudged: open.filter((i) => !(i.nudge_count > 0)).length,
    resolvedLast30: cleared.filter((i) => nowMs - new Date(i.cleared_at) < 30 * DAY).length,
    nudgesLast7: sends.filter((s) => nowMs - new Date(s.sent_at) < 7 * DAY).length,
    falseDone: issues.reduce((a, i) => a + (i.false_done_claims || 0), 0),
    avgDaysToClear: r1(avg(cleared.filter((i) => i.nudge_count > 0 && i.cleared_at).map(daysToClear))),
  };

  const cats = new Map();
  for (const i of issues) {
    const c = cats.get(i.category) || { category: i.category, open: 0, cleared: 0, nudgesTotal: 0, clearNudges: [], clearDays: [], openAges: [] };
    if (i.state === 'open') { c.open++; c.openAges.push((nowMs - new Date(i.first_seen_at)) / DAY); } else if (i.state === 'cleared') { c.cleared++; if (i.nudge_count > 0) c.clearNudges.push(i.nudge_count); if (i.cleared_at) c.clearDays.push(daysToClear(i)); }
    c.nudgesTotal += i.nudge_count || 0;
    cats.set(i.category, c);
  }
  const byCategory = [...cats.values()].map((c) => ({ category: c.category, open: c.open, cleared: c.cleared, nudges: c.nudgesTotal, avgNudgesToClear: r1(avg(c.clearNudges)), avgDaysToClear: r1(avg(c.clearDays)), avgOpenAge: r1(avg(c.openAges)) })).sort((a, b) => b.open - a.open);

  const sendCount = new Map(); const lastSend = new Map();
  for (const s of sends) { sendCount.set(s.recipient_dms_user_id, (sendCount.get(s.recipient_dms_user_id) || 0) + 1); if (!lastSend.get(s.recipient_dms_user_id) || s.sent_at > lastSend.get(s.recipient_dms_user_id)) lastSend.set(s.recipient_dms_user_id, s.sent_at); }
  const replyCount = new Map(); const responseHours = new Map();
  for (const r of replies) {
    replyCount.set(r.sender_dms_user_id, (replyCount.get(r.sender_dms_user_id) || 0) + 1);
    const sentAt = outs.get(r.in_reply_to_message_out_id);
    if (sentAt) { const h = (new Date(r.received_at) - new Date(sentAt)) / 3600000; if (h > 0) responseHours.set(r.sender_dms_user_id, [...(responseHours.get(r.sender_dms_user_id) || []), h]); }
  }
  const byOwner = new Map();
  for (const i of issues) if (i.owner_dms_user_id) byOwner.set(i.owner_dms_user_id, [...(byOwner.get(i.owner_dms_user_id) || []), i]);
  const byPerson = [];
  for (const p of people) {
    const mine = byOwner.get(p.dms_user_id) || []; const nudges = sendCount.get(p.dms_user_id) || 0;
    if (!mine.length && !nudges) continue;
    const mineOpen = mine.filter((i) => i.state === 'open'); const mineCleared = mine.filter((i) => i.state === 'cleared');
    byPerson.push({
      id: p.dms_user_id, name: p.name, email: p.email, manager: p.manager_email || null,
      open: mineOpen.length, total: mine.length, resolved: mineCleared.length, nudges,
      openAfter3: mineOpen.filter((i) => i.nudge_count >= 3).length,
      falseDone: mine.reduce((a, i) => a + (i.false_done_claims || 0), 0), holds: mine.reduce((a, i) => a + (i.hold_renewals || 0), 0), reassignedAway: reassigned.get(p.dms_user_id) || 0,
      replyRate: nudges ? Math.min(100, Math.round(((replyCount.get(p.dms_user_id) || 0) / nudges) * 100)) : null,
      avgResponseHours: r1(avg(responseHours.get(p.dms_user_id) || [])), avgDaysToClear: r1(avg(mineCleared.filter((i) => i.nudge_count > 0 && i.cleared_at).map(daysToClear))),
      lastContacted: lastSend.get(p.dms_user_id) || null,
    });
  }
  byPerson.sort((a, b) => b.openAfter3 - a.openAfter3 || b.falseDone - a.falseDone || b.open - a.open || b.nudges - a.nudges);
  return { cards, byCategory, byPerson };
}
