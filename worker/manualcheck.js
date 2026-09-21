// End-to-end check of the tracker's "Send now" on the real system, to the owner only.
// Creates a throwaway manual issue for the owner, sends it twice through the website's real send code, checks the
// ledger (draft -> open, nudge counts, thread, no once-a-day block), and removes everything it created.
import * as S from './lib/store.js';
import { makeAppSender } from './lib/appSender.js';
import { planRun } from './lib/planner.js';

const db = S.makeDb(process.env);
const settings = await S.loadSettings(db);
const ok = ({ data, error }, what) => { if (error) throw new Error(`${what}: ${error.message}`); return data; };
const results = [];
const check = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };

const sender = makeAppSender({ baseUrl: settings.app_base_url, key: process.env.SUPABASE_SERVICE_ROLE_KEY });
const ownerEmail = settings.sender_user_email;
const existing = ok(await db.from('dms_people').select('*').eq('email', ownerEmail).limit(1), 'find owner person')[0];
const tempPerson = !existing;
const pid = existing?.dms_user_id || `contact:${ownerEmail}`;
const original = existing ? { entered_at: existing.entered_at, skipped_count: existing.skipped_count, email_thread_id: existing.email_thread_id, email_rfc_message_id: existing.email_rfc_message_id, email_subject: existing.email_subject, slack_user_id: existing.slack_user_id, slack_dm_channel_id: existing.slack_dm_channel_id } : null;
if (tempPerson) ok(await db.from('dms_people').insert({ dms_user_id: pid, name: 'Manual check', email: ownerEmail, is_deleted: false }), 'temp person');
let issueId = null;
try {
  issueId = ok(await db.from('issues').insert({
    source: 'manual', category: 'revenue_mismatch', campaign_id: `manual:zz-check-${Date.now()}`, campaign_name: 'ZZ-MANUALCHECK campaign', title: 'ZZ-MANUALCHECK campaign',
    issue_text: 'This is an automated check of the tracker "Send now". Nothing to do; please ignore.', owner_dms_user_id: pid, owner_state: 'active', item_count: 1, detail: {}, state: 'draft', auto_followups: true,
  }).select('id').single(), 'create draft').id;

  const r1 = await sender.sendIssues([issueId]);
  check('first manual send goes out', r1.sent === 1 && !r1.failed, JSON.stringify(r1));
  let iss = ok(await db.from('issues').select('*').eq('id', issueId).single(), 'reload');
  check('draft became open with nudge 1', iss.state === 'open' && iss.nudge_count === 1 && !!iss.last_nudged_at, `${iss.state}/${iss.nudge_count}`);
  const outs1 = ok(await db.from('messages_out').select('*').eq('recipient_dms_user_id', pid).eq('mode', 'live').gte('created_at', new Date(Date.now() - 10 * 60_000).toISOString()).order('created_at'), 'messages');
  const first = outs1.find((m) => m.channel === 'email');
  check('message stored as a live, sent email with a thread', first?.status === 'sent' && !!first.gmail_thread_id && first.kind === 'first', `${first?.status}/${first?.kind}`);
  const items1 = ok(await db.from('message_items').select('*').eq('issue_id', issueId), 'items');
  check('message is linked to the issue with its item number', items1.length === 1 && items1[0].item_no === 1);

  const r2 = await sender.sendIssues([issueId]);        // a second manual send the same day
  check('second manual send the same day is NOT blocked', r2.sent === 1, JSON.stringify(r2));
  iss = ok(await db.from('issues').select('*').eq('id', issueId).single(), 'reload 2');
  check('nudge count is now 2', iss.nudge_count === 2, String(iss.nudge_count));
  const outs2 = ok(await db.from('messages_out').select('*').eq('recipient_dms_user_id', pid).eq('mode', 'live').eq('channel', 'email').gte('created_at', new Date(Date.now() - 10 * 60_000).toISOString()).order('created_at'), 'messages 2');
  check('the follow-up stayed in the same email thread', outs2.length >= 2 && outs2.at(-1).gmail_thread_id === outs2[0].gmail_thread_id, `${outs2.length} emails`);

  // The automation must now treat it like any other item: two working days apart, then follow-ups.
  const person = ok(await db.from('dms_people').select('*').eq('dms_user_id', pid).single(), 'person');
  const planFor = (date) => planRun({
    now: new Date(`${date}T05:30:00Z`), issues: [{ id: issueId, category: iss.category, ownerIds: [pid], needsOwner: false, nudgeCount: iss.nudge_count, lastNudgedAt: iss.last_nudged_at, holdUntil: null, firstSeenAt: iss.first_seen_at }],
    people: new Map([[pid, { enteredAt: person.entered_at, skippedCount: 0 }]]),
  });
  const sent = new Date(iss.last_nudged_at).toISOString().slice(0, 10);
  const nextNudgeDay = (() => { for (let i = 1; i < 12; i++) { const d = new Date(new Date(`${sent}T00:00:00Z`).getTime() + i * 86400e3).toISOString().slice(0, 10); const p = planFor(d); if (p.messages.length) return { d, kind: p.messages[0].kind, n: p.messages[0].items[0].nextN }; } return null; })();
  check('the automation picks it up later as follow-up #3', nextNudgeDay?.kind === 'followup' && nextNudgeDay.n === 3, JSON.stringify(nextNudgeDay));

  // "Said done" is remembered and counted once the next nudge goes out while it is still pending.
  ok(await db.from('issues').update({ claimed_done_at: new Date().toISOString() }).eq('id', issueId), 'claim');
  const r3 = await sender.sendIssues([issueId]);
  iss = ok(await db.from('issues').select('*').eq('id', issueId).single(), 'reload 3');
  check('a "done" claim that is still pending is counted as a false claim', r3.sent === 1 && iss.false_done_claims === 1 && !iss.claimed_done_at, `${iss.false_done_claims}`);
} finally {
  if (issueId) {
    const mi = await db.from('message_items').select('message_out_id').eq('issue_id', issueId);
    const outIds = (mi.data || []).map((x) => x.message_out_id);
    await db.from('message_items').delete().eq('issue_id', issueId);
    if (outIds.length) { await db.from('send_log').delete().in('idempotency_key', outIds); await db.from('messages_out').delete().in('id', outIds); }
    await db.from('review_items').delete().eq('issue_id', issueId);
    await db.from('issues').delete().eq('id', issueId);
  }
  if (tempPerson) await db.from('dms_people').delete().eq('dms_user_id', pid);
  else await db.from('dms_people').update(original).eq('dms_user_id', pid);
  const left = (await db.from('issues').select('id').like('campaign_name', 'ZZ-MANUALCHECK%')).data || [];
  check('cleanup left nothing behind', left.length === 0, `${left.length} leftover`);
}
console.log(`MANUALCHECK ${results.every(Boolean) ? 'ALL PASS' : 'FAILED'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(results.every(Boolean) ? 0 : 1);
