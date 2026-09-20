// Exercises every database and sending path a LIVE run depends on, against the real database, using
// clearly-labelled throwaway rows that are removed afterwards. Rehearsal cannot cover these because it
// never changes state. Sends exactly one email, to the owner only, to test duplicate-send protection.
//
//   node selfcheck.js        (run by the workflow with task=selfcheck)

import { makeDb, executorStore, recoverStale, loadSettings } from './lib/store.js';
import { signRequest } from '../lib/nudgeSend.mjs';
import { istDate } from './lib/time.js';

const P = 'ZZ-SELFCHECK';

export async function main(env = process.env) {
  const db = makeDb(env);
  const store = executorStore(db);
  const settings = await loadSettings(db);
  const results = [];
  const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond, detail }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${detail}`}`); };
  const must = ({ data, error }, what) => { if (error) throw new Error(`${what}: ${error.message}`); return data; };
  const now = new Date();
  const nowIso = now.toISOString();

  try {
    await cleanup(db);

    // --- setup: two throwaway people and one issue --------------------------------------------------------
    must(await db.from('dms_people').upsert([
      { dms_user_id: `${P}-P1`, name: 'Selfcheck One', email: 'selfcheck1@wldd.in' },
      { dms_user_id: `${P}-P2`, name: 'Selfcheck Two', email: 'selfcheck2@wldd.in', skipped_count: 1 },
    ], { onConflict: 'dms_user_id' }), 'seed people');
    const issue = must(await db.from('issues').insert({
      category: 'invoice_approvals', campaign_id: `${P}-C1`, campaign_name: 'Selfcheck campaign', owner_dms_user_id: `${P}-P1`, owner_state: 'active', item_count: 1,
    }).select('id,nudge_count').single(), 'seed issue');

    // --- messages: same calls a live run makes -----------------------------------------------------------------
    check('nobody messaged today yet', (await store.hasMessageToday(`${P}-P1`, istDate(now))) === false);
    const msgId = await store.insertMessage({
      recipient_dms_user_id: `${P}-P1`, channel: 'email', lane: 'A', kind: 'first', status: 'sending', to_address: 'selfcheck1@wldd.in',
      subject: 'x', body: 'x', mode: 'live',
    });
    check('a "sending" message counts as messaged today', (await store.hasMessageToday(`${P}-P1`, istDate(now))) === true);
    await store.insertItems([{ message_out_id: msgId, issue_id: issue.id, item_no: 1, nudge_no: 1 }]);
    await store.updateMessage(msgId, { status: 'sent', sent_at: nowIso, gmail_message_id: 'g', gmail_thread_id: 't' });
    await store.savePersonThread(`${P}-P1`, { email_thread_id: 'T-SELF', email_rfc_message_id: '<self@check>', email_subject: 'S' });
    await store.applySent({ issues: [{ id: issue.id, nudgeCount: 0 }], recipientIds: [`${P}-P1`], deferredIds: [`${P}-P2`], nowIso });

    const i2 = must(await db.from('issues').select('nudge_count,last_nudged_at').eq('id', issue.id).single(), 'read issue');
    check('state advanced: nudge count 1 and last-nudged time saved', i2.nudge_count === 1 && !!i2.last_nudged_at, JSON.stringify(i2));
    const p1 = must(await db.from('dms_people').select('entered_at,skipped_count,email_thread_id,email_rfc_message_id').eq('dms_user_id', `${P}-P1`).single(), 'read p1');
    check('person marked as entered, thread saved for follow-ups', !!p1.entered_at && p1.skipped_count === 0 && p1.email_thread_id === 'T-SELF' && p1.email_rfc_message_id === '<self@check>', JSON.stringify(p1));
    const p2 = must(await db.from('dms_people').select('skipped_count,entered_at').eq('dms_user_id', `${P}-P2`).single(), 'read p2');
    check('a deferred person gains a skip and is NOT marked as entered', p2.skipped_count === 2 && !p2.entered_at, JSON.stringify(p2));

    // --- crash recovery -----------------------------------------------------------------------------------------
    const staleId = await store.insertMessage({
      recipient_dms_user_id: `${P}-P2`, channel: 'email', lane: 'A', kind: 'first', status: 'sending', to_address: 'selfcheck2@wldd.in',
      subject: 'x', body: 'x', mode: 'live', created_at: new Date(Date.now() - 40 * 60_000).toISOString(),
    });
    const recovered = await recoverStale(db, 30);
    const st = must(await db.from('messages_out').select('status').eq('id', staleId).single(), 'read stale');
    check('an interrupted send becomes "unknown" and is flagged', recovered >= 1 && st.status === 'unknown', `${recovered} ${st.status}`);
    check('an "unknown" send still counts as messaged today (no double email)', (await store.hasMessageToday(`${P}-P2`, istDate(now))) === true);

    // --- review items are de-duplicated ------------------------------------------------------------------------
    await store.addReviewItem({ kind: 'send_failed', note: `${P} duplicate check` });
    await store.addReviewItem({ kind: 'send_failed', note: `${P} duplicate check` });
    const dup = must(await db.from('review_items').select('id').eq('note', `${P} duplicate check`), 'read reviews');
    check('the same problem is listed once, not every run', dup.length === 1, `${dup.length}`);

    // --- the send route: signed request works, a repeat with the same key cannot send twice ---------------------
    if (env.SKIP_SEND_CHECK) {
      console.log('SKIP  send route check (SKIP_SEND_CHECK set)');
    } else {
      const call = async (payload, key = env.SUPABASE_SERVICE_ROLE_KEY) => {
        const raw = JSON.stringify(payload); const ts = String(Date.now());
        const res = await fetch(`${settings.app_base_url}/api/nudge/send`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nudge-timestamp': ts, 'x-nudge-signature': signRequest(key, ts, raw) }, body: raw });
        return { status: res.status, data: await res.json().catch(() => ({})) };
      };
      const key = `selfcheck-${Date.now()}`;
      const mail = { type: 'email', idempotencyKey: key, to: settings.sender_user_email, cc: [], subject: '[SELFCHECK] Delivery check', body: 'Self-check of the nudge system. Nothing to do.' };
      const first = await call(mail);
      check('signed request is accepted and the email is sent', first.status === 200 && !!first.data.gmailMessageId, JSON.stringify(first));
      const second = await call(mail);
      check('the same request repeated is NOT sent again', second.status === 200 && second.data.duplicate === true && second.data.gmailMessageId === first.data.gmailMessageId, JSON.stringify(second));
      const bad = await call({ ...mail, idempotencyKey: `${key}-b`, to: 'someone@gmail.com' });
      check('an outside address is refused', bad.status === 502 && /non-wldd\.in/.test(JSON.stringify(bad.data)), JSON.stringify(bad));
      const forged = await call({ ...mail, idempotencyKey: `${key}-c` }, 'wrong-key');
      check('a wrongly signed request is refused', forged.status === 401, `${forged.status}`);
    }
  } finally {
    await cleanup(db);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) throw new Error(`self-check failed: ${failed.map((f) => f.name).join('; ')}`);
  return results;
}

async function cleanup(db) {
  await db.from('review_items').delete().like('note', `${P}%`);
  await db.from('messages_out').delete().like('recipient_dms_user_id', `${P}%`);
  await db.from('issues').delete().like('campaign_id', `${P}%`);
  await db.from('dms_people').delete().like('dms_user_id', `${P}%`);
  await db.from('send_log').delete().like('idempotency_key', 'selfcheck-%');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
}
