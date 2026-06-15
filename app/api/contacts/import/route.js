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

  let created = 0, skipped = 0;

  for (const r of rows) {
    // Dedup: check if this person+campaign already has a non-resolved outreach
    const { data: existing } = await db.from("contacts")
      .select("id, outreach_records(id, status)")
      .eq("user_id", user.id)
      .eq("campaign", r.campaign || "")
      .ilike("name", r.name)
      .single();

    if (existing) {
      const hasActive = (existing.outreach_records || []).some(o =>
        !["resolved", "escalated"].includes(o.status)
      );
      if (hasActive) { skipped++; continue; } // Already have an active outreach for this person+campaign
    }

    const { data: contact } = await db.from("contacts").insert({
      user_id: user.id, name: r.name,
      email: r.email || null, campaign: r.campaign || null, issue: r.issue, source,
    }).select("id").single();

    const { data: outreach } = await db.from("outreach_records").insert({
      contact_id: contact.id, user_id: user.id, status: "pending",
    }).select("id").single();

    await logEvent({ outreachId: outreach.id, userId: user.id, action: "created", newStatus: "pending" });
    created++;
  }

  return Response.json({ ok: true, created, skipped });
}
