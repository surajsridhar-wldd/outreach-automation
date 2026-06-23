import { requireUser, unauthorized } from "@/lib/session";
import { db, logEvent } from "@/lib/supabase";
import { readSheet } from "@/lib/sheets";

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

// Normalise issue text for comparison — lowercase, collapse whitespace
function normalizeIssue(s) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

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

  let created = 0, skipped = 0, refreshed = 0, followup_queued = 0;

  for (const r of rows) {
    // Find all contacts for this user + name + campaign (may have multiple rows = multiple outreach records)
    const { data: existing } = await db.from("contacts")
      .select("id, issue, outreach_records(id, status)")
      .eq("user_id", user.id)
      .eq("campaign", r.campaign || "")
      .ilike("name", r.name);

    if (existing && existing.length > 0) {
      const monitoringRec = existing
        .flatMap(c => (c.outreach_records || []).map(o => ({ ...o, issue: c.issue })))
        .find(o => o.status === "monitoring");

      if (monitoringRec) {
        // Recurring known issue — refresh "last seen" timestamp
        await db.from("outreach_records").update({ last_action_at: new Date().toISOString() }).eq("id", monitoringRec.id);
        await logEvent({ outreachId: monitoringRec.id, userId: user.id, action: "note_added", payload: { note: "Re-appeared in latest import — still monitoring" } });
        refreshed++; continue;
      }

      // Check if there's an active outreach for the same issue (same text → queue follow-up)
      const incomingIssue = normalizeIssue(r.issue);
      const sameIssueActiveRec = existing
        .flatMap(c => (c.outreach_records || []).map(o => ({ ...o, contactIssue: c.issue })))
        .find(o =>
          ["sent","active","no_reply","followup","stalled","needs_review"].includes(o.status) &&
          normalizeIssue(o.contactIssue) === incomingIssue
        );

      if (sameIssueActiveRec) {
        // Same person, same campaign, same issue → queue a follow-up on the existing record
        const { error: fuErr } = await db.from("outreach_records").update({
          status: "no_reply",
          last_action_at: new Date().toISOString(),
          message_notes: (sameIssueActiveRec.message_notes ? sameIssueActiveRec.message_notes + "; " : "") + "Re-appeared in import — follow-up queued",
        }).eq("id", sameIssueActiveRec.id);
        if (!fuErr) {
          await logEvent({ outreachId: sameIssueActiveRec.id, userId: user.id, action: "note_added", payload: { note: "Re-appeared in import — same issue, follow-up queued" } });
          followup_queued++;
        }
        continue;
      }

      // Check if there is ANY active outreach for a DIFFERENT issue (same person, same campaign, different issue → new record)
      const differentIssueActive = existing
        .flatMap(c => (c.outreach_records || []).map(o => ({ ...o, contactIssue: c.issue })))
        .find(o =>
          ["sent","active","no_reply","followup","stalled","needs_review"].includes(o.status) &&
          normalizeIssue(o.contactIssue) !== incomingIssue
        );

      if (differentIssueActive) {
        // Different issue → fall through to create a new record (don't skip!)
        // (no continue here)
      } else {
        // Only resolved/escalated exist for this person+campaign → treat as fresh, fall through
      }
    }

    // Create new contact + outreach record
    const { data: contact, error: cErr } = await db.from("contacts").insert({
      user_id: user.id, name: r.name,
      email: r.email || null, campaign: r.campaign || null, issue: r.issue, source,
    }).select("id").single();
    if (cErr) { console.error("import: failed to insert contact:", cErr.message); skipped++; continue; }

    const { data: outreach, error: oErr } = await db.from("outreach_records").insert({
      contact_id: contact.id, user_id: user.id, status: "pending",
    }).select("id").single();
    if (oErr) { console.error("import: failed to insert outreach_record:", oErr.message); skipped++; continue; }

    await logEvent({ outreachId: outreach.id, userId: user.id, action: "created", newStatus: "pending" });
    created++;
  }

  return Response.json({ ok: true, created, skipped, refreshed, followup_queued });
}
