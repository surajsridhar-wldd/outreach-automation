import { requireUser, unauthorized } from "@/lib/session";
import { db, logEvent } from "@/lib/supabase";
import { readSheet } from "@/lib/sheets";

function normalizeRows(values) {
  // values = array of arrays, first row headers
  if (!values || values.length < 2) return [];
  const headers = values[0].map((h) => String(h).trim().toLowerCase().replace(/[^a-z0-9]/g, "_"));
  const findKey = (re, fallback) => headers.findIndex((h) => re.test(h)) >= 0 ? headers.findIndex((h) => re.test(h)) : fallback;
  const nameIdx = findKey(/name/, 0);
  const emailIdx = findKey(/email|mail/, -1);
  const issueIdx = findKey(/issue|error|problem|desc|note/, headers.length - 1);
  const campaignIdx = findKey(/campaign/, -1);
  return values.slice(1)
    .filter(r => r.length && r.some(f => f && String(f).trim()))  // skip fully empty rows
    .map(r => ({
      name:     String(r[nameIdx]     || "").trim(),
      email:    emailIdx    >= 0 ? String(r[emailIdx]    || "").trim() : "",
      issue:    String(r[issueIdx]    || "").trim(),
      campaign: campaignIdx >= 0 ? String(r[campaignIdx] || "").trim() : "",
    }))
    .filter(r => r.name && r.name.length > 0); // must have a name
}

function parseCsvText(text) {
  // Detect separator from first line
  const firstLine = text.split("\n")[0];
  const sep = firstLine.includes("\t") ? "\t" : ",";

  // Proper parser that handles quoted fields containing newlines and commas
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        // Escaped quote inside quoted field
        field += '"';
        i++;
      } else if (ch === '"') {
        // End of quoted field
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === sep) {
        row.push(field.trim());
        field = "";
      } else if (ch === "\n") {
        row.push(field.trim());
        // Only add non-empty rows (skip blank lines)
        if (row.some(f => f.length > 0)) rows.push(row);
        row = [];
        field = "";
        // Handle \r\n
        if (next === "\r") i++;
      } else if (ch === "\r") {
        // skip
      } else {
        field += ch;
      }
    }
  }

  // Push last field/row
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
    return Response.json({ error: `Could not read sheet: ${e.message}. Is it shared with the service account or link-viewable?` }, { status: 400 });
  }

  const rows = normalizeRows(values);
  if (!rows.length) return Response.json({ error: "No data rows found. Check the table has headers + at least one row." }, { status: 400 });

  let created = 0;
  for (const r of rows) {
    const { data: contact } = await db.from("contacts").insert({
      user_id: user.id, name: r.name, email: r.email || null, campaign: r.campaign || null, issue: r.issue, source,
    }).select("id").single();
    const { data: outreach } = await db.from("outreach_records").insert({
      contact_id: contact.id, user_id: user.id, status: "pending",
    }).select("id").single();
    await logEvent({ outreachId: outreach.id, userId: user.id, action: "created", newStatus: "pending" });
    created++;
  }
  return Response.json({ ok: true, created });
}
