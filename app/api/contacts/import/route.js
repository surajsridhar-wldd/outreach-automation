import { requireUser, unauthorized } from "@/lib/session";
import { db, logEvent } from "@/lib/supabase";
import { readSheet } from "@/lib/sheets";
import { sameCampaign, sameName, issueSamenessFast } from "@/lib/matching";
import { judgeIssueSamenessBatch } from "@/lib/claude";

// IMPORT — instant and cheap:
//   • Dedup against in-flight uses FREE token matching (no AI) for clear cases.
//   • Only genuinely ambiguous issue-sameness pairs go through ONE batched Claude
//     call at the end (not per-row).
//   • Category tagging is deferred to /api/tag-pending (browser-triggered after
//     import, batched), with the cron as backstop. Keeps AI cost flat & import fast.

function normalizeRows(values) {
  if (!values || values.length < 2) return [];
  const headers = values[0].map(h => String(h).trim().toLowerCase().replace(/[^a-z0-9]/g, "_"));
  const idx = (re, fallback) => { const i = headers.findIndex(h => re.test(h)); return i >= 0 ? i : fallback; };
  const nameIdx     = idx(/name/, 0);
  const emailIdx    = idx(/email|mail/, -1);
  const issueIdx    = idx(/issue|error|problem|desc|note/, headers.length - 1);
  const campaignIdx = idx(/campaign/, -1);

  return values.slice(1)
    .filter(r => r.length && r.some(f => f && String(f).trim()))
    .map(r => ({
      name:     String(r[nameIdx]     || "").trim(),
      email:    emailIdx    >= 0 ? String(r[emailIdx]    || "").trim() : "",
      issue:    String(r[issueIdx]    || "").trim(),
      campaign: campaignIdx >= 0 ? String(r[campaignIdx] || "").trim() : "",
    }))
    .filter(r => r.name.length > 0);
}

function parseCsvText(text) {
  const firstLine = text.split("\n")[0];
  const sep = firstLine.includes("\t") ? "\t" : ",";
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { field += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === sep) { row.push(field.trim()); field = ""; }
      else if (ch === "\n") {
        row.push(field.trim());
        if (row.some(f => f.length > 0)) rows.push(row);
        row = []; field = "";
        if (next === "\r") i++;
      } else if (ch === "\r") { /* skip */ }
      else { field += ch; }
    }
  }
  if (field.trim() || row.length) {
    row.push(field.trim());
    if (row.some(f => f.length > 0)) rows.push(row);
  }
  return rows;
}

const OPEN_STATUSES = ["sent", "active", "no_reply", "followup", "stalled", "needs_review"];

export async function POST(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { csvText, sheetUrl } = await req.json();

  let values, source;
  try {
    if (sheetUrl) { values = await readSheet(sheetUrl); source = "google_sheet"; }
    else if (csvText) { values = parseCsvText(csvText); source = "csv"; }
    else return Response.json({ error: "Provide csvText or sheetUrl" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: `Could not read: ${e.message}` }, { status: 400 });
  }

  const rows = normalizeRows(values);
  if (!rows.length) return Response.json({ error: "No data rows found" }, { status: 400 });

  const { data: allContacts } = await db.from("contacts")
    .select("id, name, email, campaign, issue, outreach_records(id, status, message_notes, snoozed_until)")
    .eq("user_id", user.id);
  const contacts = allContacts || [];

  // PASS 1 (no AI): free token matching.
  const decisions = [];
  for (const r of rows) {
    const pcContacts = contacts.filter(
      c => sameName(c.name, r.name) && sameCampaign(c.campaign || "", r.campaign || "")
    );
    const recs = pcContacts.flatMap(c =>
      (c.outreach_records || []).map(o => ({ ...o, contactIssue: c.issue, contactId: c.id }))
    );

    const snoozedRec = recs.find(o => o.status === "snoozed");
    if (snoozedRec) { decisions.push({ row: r, kind: "refresh", rec: snoozedRec }); continue; }

    const openRecs = recs.filter(o => OPEN_STATUSES.includes(o.status));
    let decided = null;
    const ambigRecs = [];
    for (const o of openRecs) {
      const verdict = issueSamenessFast(r.issue, o.contactIssue);
      if (verdict === "same") { decided = { kind: "followup", rec: o }; break; }
      if (verdict === "ambiguous") ambigRecs.push(o);
    }
    if (decided) { decisions.push({ row: r, ...decided }); continue; }
    if (ambigRecs.length) { decisions.push({ row: r, kind: "ambiguous", ambigRecs }); continue; }
    decisions.push({ row: r, kind: "create" });
  }

  // PASS 2 (one batched AI call): resolve ambiguous pairs.
  const ambiguousDecisions = decisions.filter(d => d.kind === "ambiguous");
  if (ambiguousDecisions.length) {
    const pairs = [];
    ambiguousDecisions.forEach((d, di) => {
      d.ambigRecs.forEach((o, oi) => {
        pairs.push({ id: `${di}:${oi}`, a: d.row.issue, b: o.contactIssue, campaign: d.row.campaign });
      });
    });
    let verdicts = {};
    try { verdicts = await judgeIssueSamenessBatch({ pairs }); }
    catch (e) { console.error("batch sameness failed:", e.message); }

    ambiguousDecisions.forEach((d, di) => {
      let matchedRec = null;
      d.ambigRecs.forEach((o, oi) => {
        const v = verdicts[`${di}:${oi}`];
        if (!matchedRec && v && v.same && v.confidence >= 0.6) matchedRec = o;
      });
      if (matchedRec) { d.kind = "followup"; d.rec = matchedRec; }
      else { d.kind = "create"; }
    });
  }

  // APPLY
  let created = 0, skipped = 0, refreshed = 0, followup_queued = 0;
  const now = () => new Date().toISOString();

  for (const d of decisions) {
    if (d.kind === "refresh") {
      await db.from("outreach_records").update({ last_action_at: now() }).eq("id", d.rec.id);
      await logEvent({ outreachId: d.rec.id, userId: user.id, action: "note_added", payload: { note: "Re-appeared in import — still snoozed" } });
      refreshed++; continue;
    }
    if (d.kind === "followup") {
      const { error: fuErr } = await db.from("outreach_records").update({
        status: "no_reply", last_action_at: now(),
        message_notes: (d.rec.message_notes ? d.rec.message_notes + "; " : "") + "Re-appeared in import — follow-up queued",
      }).eq("id", d.rec.id);
      if (!fuErr) {
        await logEvent({ outreachId: d.rec.id, userId: user.id, action: "note_added", payload: { note: "Re-appeared in import — same issue, follow-up queued" } });
        followup_queued++;
      }
      continue;
    }
    const r = d.row;
    const { data: contact, error: cErr } = await db.from("contacts").insert({
      user_id: user.id, name: r.name, email: r.email || null,
      campaign: r.campaign || null, issue: r.issue, source,
    }).select("id").single();
    if (cErr) { console.error("import: contact insert failed:", cErr.message); skipped++; continue; }

    const { data: outreach, error: oErr } = await db.from("outreach_records").insert({
      contact_id: contact.id, user_id: user.id, status: "pending",
    }).select("id").single();
    if (oErr) { console.error("import: outreach insert failed:", oErr.message); skipped++; continue; }

    await logEvent({ outreachId: outreach.id, userId: user.id, action: "created", newStatus: "pending" });
    created++;
    contacts.push({ id: contact.id, name: r.name, email: r.email, campaign: r.campaign, issue: r.issue,
      outreach_records: [{ id: outreach.id, status: "pending", message_notes: null }] });
  }

  const { count: untaggedCount } = await db.from("outreach_records")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("status", "pending")
    .is("category", null)
    .is("category_confidence", null);

  return Response.json({ ok: true, created, skipped, refreshed, followup_queued, untaggedCount: untaggedCount || 0 });
}
