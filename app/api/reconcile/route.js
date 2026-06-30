import { requireUser, unauthorized } from "@/lib/session";
import { db, logEvent } from "@/lib/supabase";
import { sameCampaign, sameName, issueSamenessFast } from "@/lib/matching";
import { judgeIssueSameness } from "@/lib/claude";
import { getCategories } from "@/lib/categories";

// Reconcile a pasted "complete current list" for ONE category against in-flight
// records IN THAT CATEGORY ONLY. Anything open in the category but absent from the
// list is a candidate for auto-resolve (it dropped off the source of truth = fixed).
//
// dryRun:true  -> returns preview { matched, toCreate, toResolve, ambiguous }, writes NOTHING.
// dryRun:false -> applies: creates new + resolves absent ones. Call only after user confirms.
//
// SCOPE GUARD: every query is filtered to the selected category. Other categories
// are never read or touched.

// Open statuses considered during reconciliation. Includes In-Flight states AND
// snoozed + needs_review (Review), so that:
//   • a record that's snoozed/in-review but still matches an incoming row is NOT
//     duplicated as a new record, and
//   • a snoozed/review record ABSENT from a complete list gets auto-resolved (it
//     was fixed while parked).
const OPEN_STATUSES = ["sent", "active", "no_reply", "followup", "stalled", "needs_review", "snoozed", "pending"];

function parseRows(text) {
  const firstLine = (text || "").split("\n")[0] || "";
  const sep = firstLine.includes("\t") ? "\t" : ",";
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === sep) { row.push(field.trim()); field = ""; }
      else if (ch === "\n") { row.push(field.trim()); if (row.some(f => f)) rows.push(row); row = []; field = ""; if (next === "\r") i++; }
      else if (ch === "\r") {}
      else field += ch;
    }
  }
  if (field.trim() || row.length) { row.push(field.trim()); if (row.some(f => f)) rows.push(row); }
  return rows;
}

function normalize(values) {
  if (!values || values.length < 1) return [];
  const head = values[0].map(h => String(h).toLowerCase());
  const hasHeader = head.some(h => /name|email|issue|campaign/.test(h));
  let nameIdx = 1, emailIdx = 2, issueIdx = 3, campaignIdx = 0, start = 0;
  if (hasHeader) {
    const find = (re, fb) => { const i = head.findIndex(h => re.test(h)); return i >= 0 ? i : fb; };
    nameIdx = find(/name/, 1); emailIdx = find(/email|mail/, 2);
    issueIdx = find(/issue|error|problem|desc|note/, 3); campaignIdx = find(/campaign/, 0);
    start = 1;
  }
  return values.slice(start)
    .filter(r => r.some(f => f && String(f).trim()))
    .map(r => ({
      campaign: String(r[campaignIdx] || "").trim(),
      name: String(r[nameIdx] || "").trim(),
      email: String(r[emailIdx] || "").trim(),
      issue: String(r[issueIdx] || "").trim(),
    }))
    .filter(r => r.name || r.issue);
}

async function isSameIssue(incoming, existingIssue, campaign) {
  const fast = issueSamenessFast(incoming, existingIssue);
  if (fast === "same") return true;
  if (fast === "different") return false;
  const { same, confidence } = await judgeIssueSameness({ a: incoming, b: existingIssue, campaign });
  return same && confidence >= 0.6;
}

export async function POST(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { category, csvText, complete, dryRun } = await req.json();

  if (!category) return Response.json({ error: "category is required" }, { status: 400 });
  if (!complete) return Response.json({ error: "Reconciliation requires confirming this is the complete list for the category." }, { status: 400 });

  const rows = normalize(parseRows(csvText || ""));
  // An empty list is VALID — it means nothing is open in this category anymore.

  // Pull ONLY this category's open records (scope guard).
  const { data: catRecs, error: qErr } = await db.from("outreach_records")
    .select("id, status, category, message_notes, contacts(id, name, email, campaign, issue)")
    .eq("user_id", user.id)
    .eq("category", category)
    .in("status", OPEN_STATUSES);
  if (qErr) return Response.json({ error: qErr.message }, { status: 500 });

  const records = catRecs || [];
  const matchedRecordIds = new Set();
  const matchedRowIdx = new Set();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    for (const rec of records) {
      if (matchedRecordIds.has(rec.id)) continue;
      const c = rec.contacts || {};
      if (!sameName(c.name, row.name)) continue;
      if (!sameCampaign(c.campaign || "", row.campaign || "")) continue;
      const fast = issueSamenessFast(row.issue, c.issue);
      if (fast === "same") { matchedRecordIds.add(rec.id); matchedRowIdx.add(i); break; }
      if (fast === "ambiguous") {
        const same = await isSameIssue(row.issue, c.issue, row.campaign);
        if (same) { matchedRecordIds.add(rec.id); matchedRowIdx.add(i); break; }
      }
    }
  }

  const toResolve = records.filter(r => !matchedRecordIds.has(r.id)).map(r => ({
    id: r.id, name: r.contacts?.name, campaign: r.contacts?.campaign, issue: r.contacts?.issue, status: r.status,
  }));
  const toCreate = rows.filter((_, i) => !matchedRowIdx.has(i));
  const matched = records.filter(r => matchedRecordIds.has(r.id)).map(r => ({
    id: r.id, name: r.contacts?.name, campaign: r.contacts?.campaign, issue: r.contacts?.issue,
  }));

  if (dryRun) {
    return Response.json({
      dryRun: true, category,
      summary: { matched: matched.length, toCreate: toCreate.length, toResolve: toResolve.length },
      matched, toCreate, toResolve,
    });
  }

  // APPLY
  const now = new Date().toISOString();
  let resolved = 0, createdCount = 0;

  for (const rec of toResolve) {
    const { error } = await db.from("outreach_records").update({
      status: "resolved", resolved_by: user.id, last_action_at: now,
      message_notes: `Auto-resolved — no longer present in ${category} snapshot on ${now.slice(0,10)}.`,
    }).eq("id", rec.id);
    if (!error) {
      await logEvent({ outreachId: rec.id, userId: user.id, action: "auto_resolved_by_sync", prevStatus: rec.status, newStatus: "resolved", payload: { category, snapshotDate: now.slice(0,10) } });
      resolved++;
    }
  }

  const createErrors = [];
  for (const row of toCreate) {
    const { data: contact, error: cErr } = await db.from("contacts").insert({
      user_id: user.id, name: row.name, email: row.email || null,
      campaign: row.campaign || null, issue: row.issue, source: "reconcile",
    }).select("id").single();
    if (cErr) { createErrors.push(`contact "${row.name}": ${cErr.message}`); continue; }
    const { data: outreach, error: oErr } = await db.from("outreach_records").insert({
      contact_id: contact.id, user_id: user.id, status: "pending", category,
    }).select("id").single();
    if (oErr) { createErrors.push(`outreach "${row.name}": ${oErr.message}`); continue; }
    await logEvent({ outreachId: outreach.id, userId: user.id, action: "created", newStatus: "pending", payload: { via: "reconcile", category } });
    createdCount++;
  }

  return Response.json({ ok: true, resolved, created: createdCount, matched: matched.length, createErrors: createErrors.slice(0, 5), toCreateCount: toCreate.length });
}
