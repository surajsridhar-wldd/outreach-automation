// One-off, idempotent: brings the OLD tracker's records into the unified ledger so nothing lives in two places.
//   resolved records   -> closed issues (source manual), so the Frequency page and the history include them
//   pending records    -> drafts (imported, never sent)
//   other open records -> open issues with automatic follow-ups OFF (parked until you review them)
// Records already carried over to a DMS-found issue (same person + campaign + category) are left out.
// Dry run unless APPLY=yes. A record is never imported twice (legacy_record_id is unique).
import * as S from './lib/store.js';
import { catKey } from '../lib/ledger.mjs';

const db = S.makeDb(process.env);
const apply = process.env.APPLY === 'yes';
const ok = ({ data, error }, what) => { if (error) throw new Error(`${what}: ${error.message}`); return data; };
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const AUTOMATED_TAGS = new Set(['PENDING_CLOSURE', 'PENDING_VENDOR_APPROVAL', 'PENDING_PROPOSAL', 'NO_SERVOCE_COST']);

async function fetchAll(build) { const out = []; for (let f = 0; ; f += 1000) { const r = ok(await build().range(f, f + 999), 'read'); out.push(...r); if (r.length < 1000) return out; } }

const records = await fetchAll(() => db.from('outreach_records').select('id,status,category,followups,reached_out_at,created_at,last_action_at,snoozed_until,message_notes,gmail_thread_id,contacts(name,email,campaign,issue)').order('created_at'));
const already = new Set((await fetchAll(() => db.from('issues').select('legacy_record_id').not('legacy_record_id', 'is', null))).map((r) => r.legacy_record_id));
const history = new Map();
for (let i = 0; i < records.length; i += 100) {
  const ids = records.slice(i, i + 100).map((r) => r.id);
  for (const h of ok(await db.from('outreach_history').select('outreach_id,action,new_status,created_at').in('outreach_id', ids).in('action', ['sent', 'followup_sent', 'resolved', 'status_changed', 'updated']), 'history')) history.set(h.outreach_id, [...(history.get(h.outreach_id) || []), h]);
}
const people = await S.loadPeople(db);
const byEmail = new Map(people.filter((p) => p.email).map((p) => [p.email.toLowerCase(), p]));
const liveIssues = await S.loadOpenIssues(db);
const liveKeys = new Set(liveIssues.filter((i) => i.source !== 'manual').map((i) => `${i.category}|${norm(i.campaign_name)}|${i.owner_dms_user_id}`));

const plan = { resolved: [], drafts: [], parked: [], skipped: {} };
const skip = (why) => { plan.skipped[why] = (plan.skipped[why] || 0) + 1; };
for (const r of records) {
  if (already.has(r.id)) { skip('already imported'); continue; }
  const c = r.contacts; const email = (c?.email || '').toLowerCase();
  if (!email || !/@wldd\.in$/.test(email)) { skip('no company email'); continue; }
  const category = catKey(r.category);
  const person = byEmail.get(email);
  const ownerId = person?.dms_user_id || `contact:${email}`;
  if (r.status !== 'resolved' && liveKeys.has(`${category}|${norm(c.campaign)}|${ownerId}`)) { skip('already a DMS-found issue (history carried over)'); continue; }
  if (r.status !== 'resolved' && AUTOMATED_TAGS.has(r.category) && r.category !== 'NO_SERVOCE_COST') { skip('automated category, different owner now (stale)'); continue; }
  const evs = history.get(r.id) || [];
  const sends = evs.filter((e) => e.action === 'sent' || e.action === 'followup_sent').length;
  const resolvedAt = evs.filter((e) => e.new_status === 'resolved').map((e) => e.created_at).sort()[0] || r.last_action_at;
  const base = {
    source: 'manual', category, campaign_id: `legacy:${r.id}`, campaign_name: c.campaign || (c.issue || '').slice(0, 60), title: c.campaign, issue_text: c.issue,
    owner_dms_user_id: ownerId, owner_state: 'active', item_count: 1, detail: {}, legacy_record_id: r.id,
    nudge_count: sends || (r.status === 'pending' ? 0 : 1 + (r.followups || 0)), last_nudged_at: r.reached_out_at || null, first_seen_at: r.created_at,
    notes: r.message_notes || null,
    _person: person ? null : { dms_user_id: ownerId, name: c.name || email, email, is_deleted: false },
  };
  if (r.status === 'resolved') plan.resolved.push({ ...base, state: 'cleared', cleared_at: resolvedAt, clear_reason: 'resolved in the old tracker', resolved_by: 'old tracker', auto_followups: false });
  else if (r.status === 'pending') plan.drafts.push({ ...base, state: 'draft', auto_followups: true });
  else plan.parked.push({ ...base, state: 'open', auto_followups: false, hold_until: r.snoozed_until ? r.snoozed_until.slice(0, 10) : null, hold_reason: r.snoozed_until ? 'snoozed in the old tracker' : null });
}
console.log(`legacy records: ${records.length}; to close (history): ${plan.resolved.length}; drafts: ${plan.drafts.length}; parked open: ${plan.parked.length}`);
console.log('left out:', JSON.stringify(plan.skipped));
console.log('parked by category:', JSON.stringify(plan.parked.reduce((a, p) => ({ ...a, [p.category]: (a[p.category] || 0) + 1 }), {})));
if (!apply) { console.log('DRY RUN: nothing written. Set APPLY=yes to write.'); process.exit(0); }

const all = [...plan.resolved, ...plan.drafts, ...plan.parked];
const newPeople = [...new Map(all.filter((x) => x._person).map((x) => [x._person.dms_user_id, x._person])).values()];
if (newPeople.length) ok(await db.from('dms_people').upsert(newPeople, { onConflict: 'dms_user_id' }), 'people');
let n = 0;
for (let i = 0; i < all.length; i += 100) {
  const rows = all.slice(i, i + 100).map(({ _person, ...row }) => row);
  ok(await db.from('issues').insert(rows), 'insert issues'); n += rows.length;
}
console.log(`APPLIED: imported ${n} records (${newPeople.length} new people)`);
