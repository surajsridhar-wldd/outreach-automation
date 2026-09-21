// One-off "first round now": sends a first message for every open DMS-found issue nobody has been nudged about yet, to its
// owner, right now, instead of waiting for the daily entry cap and the Wednesday weekly slot. It goes through exactly the
// same code as the tracker's "Send now". Follow-ups keep their normal schedule.
// Left out: people who already got an email today (their remaining items follow on schedule), owners who are missing,
// deleted or unreachable, held or excluded items, and items already nudged. Dry run unless APPLY=yes.
import * as S from './lib/store.js';
import { makeAppSender } from './lib/appSender.js';
import { istDate } from './lib/time.js';

const db = S.makeDb(process.env);
const apply = process.env.APPLY === 'yes';
const only = (process.env.ONLY_CATEGORIES || '').split(',').map((x) => x.trim()).filter(Boolean);
const settings = await S.loadSettings(db);
const ok = ({ data, error }, what) => { if (error) throw new Error(`${what}: ${error.message}`); return data; };

const today = istDate(new Date());
const startUtc = new Date(`${today}T00:00:00+05:30`).toISOString();
const issues = (await S.loadOpenIssues(db)).filter((i) => i.source !== 'manual' && (i.nudge_count || 0) === 0 && i.owner_state === 'active' && i.auto_followups !== false);
const people = new Map((await S.loadPeople(db)).map((p) => [p.dms_user_id, p]));
const emailedToday = new Set(ok(await db.from('messages_out').select('recipient_dms_user_id').eq('channel', 'email').eq('mode', 'live').in('status', ['sent', 'sending', 'unknown']).neq('subject', '[legacy manual outreach]').gte('created_at', startUtc), 'today').map((m) => m.recipient_dms_user_id));
const overrides = await S.loadOverrides(db);
const overridden = new Set(overrides.map((o) => o.issue_id));

const left = {};
const skip = (why) => { left[why] = (left[why] || 0) + 1; };
const picked = [];
for (const i of issues) {
  const p = people.get(i.owner_dms_user_id);
  if (only.length && !only.includes(i.category)) { skip('category not selected'); continue; }
  if (overridden.has(i.id)) { skip('has a co-owner/reassignment (left to the schedule)'); continue; }
  if (!p?.email || !/@wldd\.in$/i.test(p.email) || p.is_deleted) { skip('owner has no usable address'); continue; }
  if (p.unreachable_at) { skip('address bounced'); continue; }
  if (i.hold_until && i.hold_until >= today) { skip('on hold'); continue; }
  if (emailedToday.has(i.owner_dms_user_id)) { skip('already emailed today (follows on schedule)'); continue; }
  picked.push(i);
}
const byPerson = new Map();
for (const i of picked) byPerson.set(i.owner_dms_user_id, [...(byPerson.get(i.owner_dms_user_id) || []), i]);
const byCat = picked.reduce((a, i) => ({ ...a, [i.category]: (a[i.category] || 0) + 1 }), {});
console.log(`SENDNOW candidates: ${picked.length} issues -> ${byPerson.size} people (one email each)`);
console.log('SENDNOW by category:', JSON.stringify(byCat));
console.log('SENDNOW left out:', JSON.stringify(left));
console.log('SENDNOW people with the most items:', [...byPerson.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 5).map(([id, l]) => `${people.get(id).name} (${l.length})`).join(', '));
if (!apply) { console.log('DRY RUN: nothing sent. Set APPLY=yes to send.'); process.exit(0); }

// Batches never split a person, so everyone gets ONE email covering all their items.
const sender = makeAppSender({ baseUrl: settings.app_base_url, key: process.env.SUPABASE_SERVICE_ROLE_KEY });
const batches = []; let cur = [];
for (const [, list] of byPerson) {
  if (cur.length && cur.length + list.length > 25) { batches.push(cur); cur = []; }
  cur.push(...list);
}
if (cur.length) batches.push(cur);
let sent = 0, failed = 0, unsent = 0;
for (const [n, b] of batches.entries()) {
  try {
    const r = await sender.sendIssues(b.map((i) => i.id));
    sent += r.sent || 0; failed += r.failed || 0; unsent += (r.notSent || []).length + (r.skippedNoEmail || 0) + (r.skippedUnreachable || 0);
    console.log(`SENDNOW batch ${n + 1}/${batches.length}: ${JSON.stringify(r)}`);
  } catch (e) { failed += b.length; console.log(`SENDNOW batch ${n + 1}/${batches.length} FAILED: ${e.message}`); }
}
console.log(`SENDNOW DONE: sent ${sent} emails, failed ${failed}, not sent ${unsent}`);
process.exit(failed ? 1 : 0);
