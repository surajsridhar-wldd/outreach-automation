import { randomUUID } from "crypto";
import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";
import { sendIssues } from "@/lib/ledgerSend.mjs";
import { catKey, labelOf, MANUAL_CATEGORIES, normName, dedupeKey, normalizeRows, parseTable } from "@/lib/ledger.mjs";
import { readSheet } from "@/lib/sheets";

// The one tracker API: every open, drafted or recently resolved issue, whether the DMS check found it or the owner
// added it by hand, plus the actions on them. Admin only.
export const maxDuration = 60;

const AUTOMATED = new Set(["invoice_approvals", "creator_submissions", "screenshot_approvals", "pending_closings", "pending_proposals", "zero_cost_services"]);
const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

async function admin() {
  const user = await requireUser();
  if (!user) return { res: unauthorized() };
  if (user.role !== "admin") return { res: Response.json({ error: "Admin only" }, { status: 403 }) };
  return { user };
}

async function all(query) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export async function GET() {
  const a = await admin(); if (a.res) return a.res;
  try {
    const since = new Date(Date.now() - 60 * 86400e3).toISOString();
    const issues = await all(() => db.from("issues").select("id,source,category,campaign_name,title,issue_text,state,owner_dms_user_id,owner_state,item_count,nudge_count,last_nudged_at,hold_until,hold_reason,claimed_done_at,false_done_claims,auto_followups,first_seen_at,cleared_at,clear_reason,resolved_by,notes,detail,legacy_record_id")
      .or(`state.in.(draft,open),cleared_at.gte.${since}`).order("first_seen_at", { ascending: false }));
    const ownerIds = [...new Set(issues.map((i) => i.owner_dms_user_id).filter(Boolean))];
    const people = [];
    for (const ids of chunk(ownerIds, 150)) {
      const { data } = await db.from("dms_people").select("dms_user_id,name,email,manager_email,unreachable_at,unreachable_reason").in("dms_user_id", ids);
      people.push(...(data || []));
    }
    const [{ data: review }, { data: settings }, { data: catRows }, { data: lastRun }] = await Promise.all([
      db.from("review_items").select("id,kind,note,created_at,issue_id,payload,issues(campaign_name,category)").eq("status", "open").order("created_at", { ascending: false }).limit(300),
      db.from("settings").select("key,value").in("key", ["paused", "mode"]),
      db.from("categories").select("tag,name"),
      db.from("runs").select("started_at,mode,ok,stats").order("started_at", { ascending: false }).limit(1),
    ]);
    const s = Object.fromEntries((settings || []).map((r) => [r.key, r.value]));
    const legacyCats = (catRows || []).map((c) => ({ key: catKey(c.tag), label: c.name })).filter((c) => !AUTOMATED.has(c.key));
    const categories = [...new Map([...MANUAL_CATEGORIES.map((k) => ({ key: k, label: labelOf(k) })), ...legacyCats].map((c) => [c.key, c])).values()];
    return Response.json({
      today: istToday(), paused: s.paused === true, mode: s.mode, issues, people, review: review || [], categories, automated: [...AUTOMATED],
      lastRun: lastRun?.[0] ? { at: lastRun[0].started_at, mode: lastRun[0].mode, ok: lastRun[0].ok, sent: lastRun[0].stats?.sent, notes: lastRun[0].stats?.notes || [] } : null,
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

async function findPerson(row) {
  const email = (row.email || "").trim().toLowerCase();
  if (email) {
    const { data } = await db.from("dms_people").select("dms_user_id,name,email,is_deleted").eq("email", email).limit(1);
    if (data?.length) return { person: data[0] };
    return { create: { dms_user_id: `contact:${email}`, name: row.name || email, email, is_deleted: false } };
  }
  const { data } = await db.from("dms_people").select("dms_user_id,name,email,is_deleted").eq("is_deleted", false).ilike("name", row.name);
  const exact = (data || []).filter((p) => normName(p.name) === normName(row.name));
  if (exact.length === 1) return { person: exact[0] };
  return { error: exact.length ? "more than one person has that name: add the email" : "person not found: add the email" };
}

async function importRows(body, user) {
  let values;
  try {
    values = body.sheetUrl ? await readSheet(body.sheetUrl) : parseTable(body.csvText || "");
  } catch (e) { return { status: 400, error: `Could not read: ${e.message}` }; }
  const rows = normalizeRows(values);
  if (!rows.length) return { status: 400, error: "No data rows found (the first row must be the column names)" };
  const result = { created: 0, refreshed: 0, skipped: [] };
  for (const row of rows) {
    const category = row.category ? catKey(row.category) : catKey(body.category);
    if (AUTOMATED.has(category)) { result.skipped.push({ row, why: `${labelOf(category)} is found by the DMS check automatically` }); continue; }
    if (!row.issue) { result.skipped.push({ row, why: "no issue text" }); continue; }
    const found = await findPerson(row);
    if (found.error) { result.skipped.push({ row, why: found.error }); continue; }
    const p = found.person || found.create;
    if (!/@wldd\.in$/i.test(p.email || "")) { result.skipped.push({ row, why: "only @wldd.in people can be messaged" }); continue; }
    if (found.person?.is_deleted) { result.skipped.push({ row, why: "that person's DMS account is deleted" }); continue; }
    if (found.create) await db.from("dms_people").upsert(found.create, { onConflict: "dms_user_id" });
    const campaign = row.campaign || row.issue.slice(0, 60);
    const { data: existing } = await db.from("issues").select("id,state,campaign_name,category").eq("owner_dms_user_id", p.dms_user_id).in("state", ["draft", "open"]).eq("category", category);
    const same = (existing || []).find((i) => dedupeKey(p.dms_user_id, i.campaign_name, i.category) === dedupeKey(p.dms_user_id, campaign, category));
    if (same?.state === "open") { result.skipped.push({ row, why: "already in flight (it will be followed up)" }); continue; }
    if (same) { await db.from("issues").update({ issue_text: row.issue }).eq("id", same.id); result.refreshed++; continue; }
    const { error } = await db.from("issues").insert({
      source: "manual", category, campaign_id: `manual:${randomUUID()}`, campaign_name: campaign, title: campaign, issue_text: row.issue,
      owner_dms_user_id: p.dms_user_id, owner_state: "active", item_count: 1, detail: {}, state: "draft", auto_followups: body.autoFollowups !== false,
      resolved_by: null, notes: `Imported by ${user.email}`,
    });
    if (error) result.skipped.push({ row, why: error.message }); else result.created++;
  }
  return { status: 200, ...result };
}

export async function POST(req) {
  const a = await admin(); if (a.res) return a.res;
  const body = await req.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string").slice(0, 200) : [];
  const done = (extra = {}) => Response.json({ ok: true, ...extra });
  const fail = (error, status = 400) => Response.json({ error }, { status });
  try {
    switch (body.action) {
      case "import": {
        const r = await importRows(body, a.user);
        return r.error ? fail(r.error, r.status) : done(r);
      }
      case "send": {
        if (!ids.length) return fail("Select something to send");
        if (ids.length > 25) return fail("Send at most 25 at a time");
        const r = await sendIssues(ids);
        return r.error ? fail(r.error, r.status) : done(r);
      }
      case "snooze": {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(body.until || "") || body.until < istToday()) return fail("Pick a date from today on");
        const { error } = await db.from("issues").update({ hold_until: body.until, hold_reason: body.reason || "snoozed by you", hold_renewals: 0 }).in("id", ids).eq("state", "open");
        return error ? fail(error.message, 500) : done();
      }
      case "unsnooze": {
        const { error } = await db.from("issues").update({ hold_until: null, hold_reason: null }).in("id", ids);
        return error ? fail(error.message, 500) : done();
      }
      case "resolve": {
        // Only issues you added yourself can be resolved by hand. DMS decides for the ones it finds, so they close on their own.
        const { data: rows } = await db.from("issues").select("id,source").in("id", ids).in("state", ["draft", "open"]);
        const mine = (rows || []).filter((r) => r.source === "manual").map((r) => r.id);
        const dms = (rows || []).length - mine.length;
        if (mine.length) {
          const { error } = await db.from("issues").update({ state: "cleared", cleared_at: new Date().toISOString(), clear_reason: body.reason || "resolved by you", resolved_by: a.user.email }).in("id", mine);
          if (error) return fail(error.message, 500);
        }
        return done({ resolved: mine.length, leftToDms: dms });
      }
      case "reopen": {
        const { error } = await db.from("issues").update({ state: "open", cleared_at: null, clear_reason: null, resolved_by: null }).in("id", ids).eq("source", "manual");
        return error ? fail(error.message, 500) : done();
      }
      case "discard": {
        const { error } = await db.from("issues").delete().in("id", ids).eq("state", "draft").eq("source", "manual");
        return error ? fail(error.message, 500) : done();
      }
      case "followups": {
        const { error } = await db.from("issues").update({ auto_followups: body.on === true }).in("id", ids).eq("source", "manual");
        return error ? fail(error.message, 500) : done();
      }
      case "note": {
        const { error } = await db.from("issues").update({ notes: String(body.text || "").slice(0, 2000) }).eq("id", ids[0]);
        return error ? fail(error.message, 500) : done();
      }
      case "reassign": {
        const email = String(body.email || "").trim().toLowerCase();
        const { data: p } = await db.from("dms_people").select("dms_user_id,is_deleted,email").eq("email", email).limit(1);
        if (!p?.length || p[0].is_deleted) return fail("No active person with that email");
        const { data: issue } = await db.from("issues").select("id,source,owner_dms_user_id").eq("id", ids[0]).single();
        if (!issue) return fail("Issue not found", 404);
        if (issue.source === "manual") {
          const { error } = await db.from("issues").update({ owner_dms_user_id: p[0].dms_user_id, owner_state: "active" }).eq("id", issue.id);
          return error ? fail(error.message, 500) : done();
        }
        const role = body.mode === "coowner" ? "co_owner" : "reassigned_to";
        const { error } = await db.from("issue_owners").insert({ issue_id: issue.id, dms_user_id: p[0].dms_user_id, role, replaces_dms_user_id: role === "reassigned_to" ? issue.owner_dms_user_id : null, lead_at_creation: issue.owner_dms_user_id, active: true });
        return error ? fail(error.message, 500) : done();
      }
      default:
        return fail("Unknown action");
    }
  } catch (e) {
    return fail(e.message, 500);
  }
}
