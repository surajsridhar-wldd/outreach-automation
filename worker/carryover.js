// One-off task: carry manual outreach history over to the automated ledger (see lib/carryover.js).
// Dry run unless APPLY=yes. Writes a report of exactly what changed. Reversible: imported message rows are
// tagged with subject "[legacy manual outreach]" and the previous values of the issue rows are printed.
import * as S from './lib/store.js';
import { planCarryOver } from './lib/carryover.js';

const db = S.makeDb(process.env);
const apply = process.env.APPLY === 'yes';
const ok = ({ data, error }, what) => { if (error) throw new Error(`${what}: ${error.message}`); return data; };

const legacy = ok(await db.from('outreach_records').select('id,category,status,gmail_thread_id,gmail_message_id,contacts(email,campaign)').in('status', ['active', 'no_reply']).in('category', ['PENDING_CLOSURE', 'PENDING_VENDOR_APPROVAL', 'PENDING_PROPOSAL']), 'load legacy');
const records = legacy.map((r) => ({ id: r.id, category: r.category, campaign: r.contacts?.campaign, contactEmail: r.contacts?.email, gmail_thread_id: r.gmail_thread_id, gmail_message_id: r.gmail_message_id }));
const history = new Map();
for (let i = 0; i < records.length; i += 100) {
  const ids = records.slice(i, i + 100).map((r) => r.id);
  for (const h of ok(await db.from('outreach_history').select('outreach_id,action,created_at').in('outreach_id', ids).in('action', ['sent', 'followup_sent']), 'load history')) history.set(h.outreach_id, [...(history.get(h.outreach_id) || []), h]);
}
const issues = await S.loadOpenIssues(db);
const people = new Map((await S.loadPeople(db)).map((p) => [p.dms_user_id, p]));
const plan = planCarryOver({ records, history, issues, people });

console.log(`legacy records read: ${records.length}; threads to import: ${plan.threads.length}; issues to update: ${plan.issueUpdates.length}; records not carried: ${plan.skipped.length}`);
const byWhy = {}; for (const s of plan.skipped) byWhy[s.why] = (byWhy[s.why] || 0) + 1; console.log('not carried:', JSON.stringify(byWhy));
console.log('nudge counts after carry-over:', JSON.stringify(plan.issueUpdates.reduce((a, u) => ({ ...a, [u.nudge_count]: (a[u.nudge_count] || 0) + 1 }), {})));
if (!apply) { console.log('DRY RUN: nothing written. Set APPLY=yes to write.'); process.exit(0); }

const already = new Set(ok(await db.from('messages_out').select('gmail_thread_id,recipient_dms_user_id').eq('subject', '[legacy manual outreach]'), 'existing imports').map((m) => `${m.gmail_thread_id}|${m.recipient_dms_user_id}`));
let imported = 0;
for (const t of plan.threads) {
  if (already.has(`${t.threadId}|${t.recipientId}`)) continue;
  // created_at is set to the real send time so "one message per person today" is not tripped by the import.
  const id = ok(await db.from('messages_out').insert({
    recipient_dms_user_id: t.recipientId, channel: 'email', lane: 'B', kind: t.kind, status: 'sent', to_address: t.to,
    subject: '[legacy manual outreach]', body: '(sent manually from the tracker before the automation; text not stored here)',
    gmail_thread_id: t.threadId, gmail_message_id: t.gmailMessageId, sent_at: t.sentAt, created_at: t.sentAt, mode: 'live',
  }).select('id').single(), 'import message').id;
  ok(await db.from('message_items').insert(t.issueIds.map((issue_id, i) => ({ message_out_id: id, issue_id, item_no: i + 1, nudge_no: t.nudges }))), 'import items');
  imported++;
}
const before = [];
for (const u of plan.issueUpdates) {
  const cur = issues.find((i) => i.id === u.id);
  before.push({ id: u.id, nudge_count: cur.nudge_count, last_nudged_at: cur.last_nudged_at });
  ok(await db.from('issues').update({ nudge_count: u.nudge_count, last_nudged_at: u.last_nudged_at }).eq('id', u.id), 'update issue');
}
console.log(`APPLIED: imported ${imported} threads, updated ${plan.issueUpdates.length} issues`);
console.log('PREVIOUS VALUES (for rollback):', JSON.stringify(before));
