// Supabase access for the worker (service-role key, server side only). Every function throws on
// error so a run fails loudly instead of half-writing silently.

import { createClient } from '@supabase/supabase-js';

export function makeDb(env = process.env) {
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

const ok = ({ data, error }, what) => {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
};

/** Reads every row (PostgREST returns at most 1000 per request). */
async function fetchAll(query, what) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = ok(await query().range(from, from + 999), what);
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

export async function loadSettings(db) {
  const rows = ok(await db.from('settings').select('key,value'), 'load settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function setSetting(db, key, value) {
  ok(await db.from('settings').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' }), `set ${key}`);
}

export async function loadHolidays(db) {
  return new Set(ok(await db.from('holidays').select('day'), 'load holidays').map((r) => r.day));
}

export const loadOpenIssues = (db) => fetchAll(() => db.from('issues').select('*').eq('state', 'open'), 'load open issues');
export const loadOverrides = (db) => fetchAll(() => db.from('issue_owners').select('*').eq('active', true), 'load owner overrides');
export const loadPeople = (db) => fetchAll(() => db.from('dms_people').select('*'), 'load people');

export async function recentSentCounts(db, n = 4) {
  const rows = ok(await db.from('runs').select('stats').eq('ok', true).in('mode', ['live', 'canary']).order('started_at', { ascending: false }).limit(n), 'load recent runs');
  return rows.map((r) => r.stats?.sent).filter((x) => Number.isFinite(x));
}

export async function startRun(db, { mode, trigger }) {
  return ok(await db.from('runs').insert({ mode, trigger }).select('id').single(), 'start run').id;
}

export async function finishRun(db, id, { ok: success, stats, error }) {
  ok(await db.from('runs').update({ finished_at: new Date().toISOString(), ok: success, stats, error: error || null }).eq('id', id), 'finish run');
}

export async function loadSender(db, email) {
  return ok(await db.from('users').select('name,email,gmail_address,gmail_refresh_token,slack_access_token').eq('email', email).single(), 'load sender');
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/** Apply a diffIssues result plus the owners seen in this read. */
export async function applySync(db, { diff, people, nowIso }) {
  if (people.length) ok(await db.from('dms_people').upsert(people, { onConflict: 'dms_user_id' }), 'upsert people');

  const cols = (f) => ({
    category: f.category, campaign_id: f.campaign_id, campaign_name: f.campaign_name, campaign_status: f.campaign_status,
    owner_dms_user_id: f.owner_dms_user_id, owner_state: f.owner_state, item_count: f.item_count, detail: f.detail, last_seen_at: nowIso,
  });
  for (const rows of chunk(diff.toInsert.map((f) => ({ ...cols(f), first_seen_at: nowIso })), 200)) {
    ok(await db.from('issues').insert(rows), 'insert issues');
  }
  for (const rows of chunk(diff.toUpdate.map((f) => ({ id: f.id, ...cols(f) })), 200)) {
    ok(await db.from('issues').upsert(rows, { onConflict: 'id' }), 'update issues');
  }
  for (const ids of chunk(diff.toClear.map((r) => r.id), 200)) {
    ok(await db.from('issues').update({ state: 'cleared', cleared_at: nowIso, clear_reason: 'no_longer_flagged_by_mongo' }).in('id', ids), 'clear issues');
  }
}

/** Open review items are de-duplicated so the same problem is not listed every run. */
export async function addReviewItem(db, { kind, issue_id = null, note }) {
  let q = db.from('review_items').select('id').eq('status', 'open').eq('kind', kind);
  q = issue_id ? q.eq('issue_id', issue_id) : q.eq('note', note);
  if (ok(await q.limit(1), 'check review item').length) return;
  ok(await db.from('review_items').insert({ kind, issue_id, note }), 'add review item');
}

/** Executor store bound to a database handle. */
export function executorStore(db) {
  return {
    async hasMessageToday(recipientId, todayIst) {
      const startUtc = new Date(`${todayIst}T00:00:00+05:30`).toISOString();
      const rows = ok(await db.from('messages_out').select('id').eq('recipient_dms_user_id', recipientId)
        .in('status', ['sending', 'sent']).in('mode', ['live', 'canary']).gte('created_at', startUtc).limit(1), 'check messages today');
      return rows.length > 0;
    },
    async insertMessage(row) {
      return ok(await db.from('messages_out').insert(row).select('id').single(), 'insert message').id;
    },
    async insertItems(rows) {
      if (rows.length) ok(await db.from('message_items').insert(rows), 'insert message items');
    },
    async updateMessage(id, patch) {
      ok(await db.from('messages_out').update(patch).eq('id', id), 'update message');
    },
    async savePersonThread(id, patch) {
      ok(await db.from('dms_people').update(patch).eq('dms_user_id', id), 'save person thread');
    },
    addReviewItem: (item) => addReviewItem(db, item),
    async applySent({ issues, recipientIds, deferredIds, nowIso }) {
      for (const i of issues) {
        ok(await db.from('issues').update({ nudge_count: i.nudgeCount + 1, last_nudged_at: nowIso }).eq('id', i.id), 'mark issue nudged');
      }
      ok(await db.from('dms_people').update({ entered_at: nowIso }).in('dms_user_id', recipientIds).is('entered_at', null), 'mark people entered');
      ok(await db.from('dms_people').update({ skipped_count: 0 }).in('dms_user_id', recipientIds), 'reset skips');
      if (deferredIds.length) {
        const rows = ok(await db.from('dms_people').select('dms_user_id,skipped_count').in('dms_user_id', deferredIds), 'load skips');
        for (const r of rows) ok(await db.from('dms_people').update({ skipped_count: (r.skipped_count || 0) + 1 }).eq('dms_user_id', r.dms_user_id), 'bump skip');
      }
    },
  };
}
