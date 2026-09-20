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
export async function addReviewItem(db, { kind, issue_id = null, note, message_in_id = null }) {
  let q = db.from('review_items').select('id').eq('status', 'open').eq('kind', kind);
  q = issue_id ? q.eq('issue_id', issue_id) : q.eq('note', note);
  if (ok(await q.limit(1), 'check review item').length) return;
  ok(await db.from('review_items').insert({ kind, issue_id, note, message_in_id }), 'add review item');
}

/** Executor store bound to a database handle. */
export function executorStore(db) {
  return {
    async hasMessageToday(recipientId, todayIst) {
      const startUtc = new Date(`${todayIst}T00:00:00+05:30`).toISOString();
      const rows = ok(await db.from('messages_out').select('id').eq('recipient_dms_user_id', recipientId)
        .in('status', ['sending', 'sent', 'unknown']).in('mode', ['live', 'canary']).gte('created_at', startUtc).limit(1), 'check messages today');
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
    /** The owner said "done", Mongo still flags it, and we have nudged again: a false claim. */
    async recordFalseDone(issueId) {
      const cur = ok(await db.from('issues').select('false_done_claims').eq('id', issueId).single(), 'load false-done count');
      const n = (cur.false_done_claims || 0) + 1;
      ok(await db.from('issues').update({ false_done_claims: n, claimed_done_at: null }).eq('id', issueId), 'record false done');
      return n;
    },
    async applySent({ issues, recipientIds, deferredIds, nowIso }) {
      for (const i of issues) {
        ok(await db.from('issues').update({ nudge_count: i.nudgeCount + 1, last_nudged_at: nowIso }).eq('id', i.id), 'mark issue nudged');
      }
      if (recipientIds.length) {
        ok(await db.from('dms_people').update({ entered_at: nowIso }).in('dms_user_id', recipientIds).is('entered_at', null), 'mark people entered');
        ok(await db.from('dms_people').update({ skipped_count: 0 }).in('dms_user_id', recipientIds), 'reset skips');
      }
      if (deferredIds.length) {
        const rows = ok(await db.from('dms_people').select('dms_user_id,skipped_count').in('dms_user_id', deferredIds), 'load skips');
        for (const r of rows) ok(await db.from('dms_people').update({ skipped_count: (r.skipped_count || 0) + 1 }).eq('dms_user_id', r.dms_user_id), 'bump skip');
      }
    },
  };
}

/**
 * A run that died between "sending" and confirmation leaves rows stuck in 'sending'. We cannot know
 * whether Gmail delivered them, so they become 'unknown' (still counted as "messaged today" so nobody is
 * emailed twice) and the owner is asked to check the Sent folder.
 */
export async function recoverStale(db, olderThanMinutes = 30) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
  const rows = ok(await db.from('messages_out').select('id,recipient_dms_user_id,to_address,created_at').eq('status', 'sending').lt('created_at', cutoff), 'find stale sends');
  for (const r of rows) {
    ok(await db.from('messages_out').update({ status: 'unknown', error: 'Run ended before delivery was confirmed' }).eq('id', r.id), 'mark stale send');
    await addReviewItem(db, { kind: 'send_failed', note: `Unconfirmed send to ${r.to_address || r.recipient_dms_user_id} (${r.created_at}). Check the Sent folder: it may or may not have gone out.` });
  }
  return rows.length;
}

// ---------------------------------------------------------------------------------------------
// Reply reading
// ---------------------------------------------------------------------------------------------

const daysAgoIso = (now, n) => new Date(now.getTime() - n * 86_400_000).toISOString();

/** Reminder emails from the last 30 days whose thread we read for replies, with the items each carried. */
async function replyThreads(db, now) {
  const outs = await fetchAll(() => db.from('messages_out').select('id,recipient_dms_user_id,gmail_thread_id,sent_at')
    .eq('channel', 'email').eq('status', 'sent').in('mode', ['live', 'canary']).not('gmail_thread_id', 'is', null).gte('sent_at', daysAgoIso(now, 30)).order('sent_at'), 'load sent reminders');
  const itemRows = outs.length ? await fetchAll(() => db.from('message_items').select('message_out_id,issue_id,item_no').in('message_out_id', outs.map((o) => o.id)), 'load reminder items') : [];
  const itemsByOut = new Map();
  for (const r of itemRows) itemsByOut.set(r.message_out_id, [...(itemsByOut.get(r.message_out_id) || []), r]);
  const byThread = new Map();
  for (const o of outs) {
    const t = byThread.get(o.gmail_thread_id) || { threadId: o.gmail_thread_id, recipientId: o.recipient_dms_user_id, outs: [] };
    t.outs.push({ id: o.id, sent_at: o.sent_at, items: itemsByOut.get(o.id) || [] });
    byThread.set(o.gmail_thread_id, t);
  }
  return [...byThread.values()];
}

async function slackConversations(db, now) {
  const outs = await fetchAll(() => db.from('messages_out').select('id,recipient_dms_user_id,slack_channel_id,sent_at,created_at')
    .eq('channel', 'slack').eq('status', 'sent').in('mode', ['live', 'canary']).not('slack_channel_id', 'is', null).gte('sent_at', daysAgoIso(now, 14)).order('sent_at'), 'load slack pings');
  const byChannel = new Map();
  for (const o of outs) {
    const c = byChannel.get(o.slack_channel_id) || { channelId: o.slack_channel_id, recipientId: o.recipient_dms_user_id, oldest: Math.floor(new Date(o.sent_at).getTime() / 1000), outs: [] };
    c.outs.push({ id: o.id, sent_at: o.sent_at, items: [] });
    byChannel.set(o.slack_channel_id, c);
  }
  // A Slack ping carries no numbered items: use the person's latest email reminder for context.
  for (const c of byChannel.values()) {
    const last = ok(await db.from('messages_out').select('id,sent_at').eq('recipient_dms_user_id', c.recipientId).eq('channel', 'email').eq('status', 'sent').in('mode', ['live', 'canary']).order('sent_at', { ascending: false }).limit(1), 'latest reminder');
    if (last[0]) {
      const items = ok(await db.from('message_items').select('issue_id,item_no').eq('message_out_id', last[0].id), 'latest reminder items');
      c.outs = [{ id: c.outs[0].id, sent_at: c.outs[0].sent_at, items }];
    }
  }
  return [...byChannel.values()];
}

export function replyStore(db) {
  return {
    replyThreads: (now) => replyThreads(db, now),
    slackConversations: (now) => slackConversations(db, now),
    async getMessageIn(channel, externalId) {
      const rows = ok(await db.from('messages_in').select('id,clean_text,from_owner,processed_at').eq('channel', channel).eq('external_id', externalId).limit(1), 'load message_in');
      return rows[0] || null;
    },
    async insertMessageIn(row) { return ok(await db.from('messages_in').insert(row).select('id').single(), 'store reply').id; },
    async insertInterpretations(rows) { if (rows.length) ok(await db.from('interpretations').insert(rows), 'store interpretations'); },
    async markProcessed(id) { ok(await db.from('messages_in').update({ processed_at: new Date().toISOString() }).eq('id', id), 'mark reply processed'); },
    async monthLlmSpend(now) {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
      const rows = await fetchAll(() => db.from('interpretations').select('cost_usd').gte('created_at', start), 'load model spend');
      return rows.reduce((a, r) => a + Number(r.cost_usd || 0), 0);
    },
    async markUnreachable(id, reason) { ok(await db.from('dms_people').update({ unreachable_at: new Date().toISOString(), unreachable_reason: reason }).eq('dms_user_id', id), 'mark unreachable'); },
    addReviewItem: (item) => addReviewItem(db, item),
    async applyEffect(e, messageInId, todayIst, nowIso) {
      if (e.type === 'claimed_done') {
        ok(await db.from('issues').update({ claimed_done_at: nowIso }).eq('id', e.issueId).eq('state', 'open'), 'record done claim');
      } else if (e.type === 'hold') {
        const cur = ok(await db.from('issues').select('hold_until,hold_renewals').eq('id', e.issueId).single(), 'load hold');
        // A hold never shortens an existing longer one; each extension is counted.
        const until = cur.hold_until && cur.hold_until > e.until ? cur.hold_until : e.until;
        ok(await db.from('issues').update({ hold_until: until, hold_reason: e.reason, hold_renewals: (cur.hold_renewals || 0) + 1 }).eq('id', e.issueId).eq('state', 'open'), 'set hold');
      } else if (e.type === 'owner') {
        const dup = ok(await db.from('issue_owners').select('id').eq('issue_id', e.issueId).eq('dms_user_id', e.dmsUserId).eq('active', true).limit(1), 'check owner');
        if (!dup.length) ok(await db.from('issue_owners').insert({ issue_id: e.issueId, dms_user_id: e.dmsUserId, role: e.role, replaces_dms_user_id: e.replaces, lead_at_creation: e.leadAtCreation, source_message_in_id: messageInId }), 'add owner');
      }
    },
  };
}
