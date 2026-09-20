// Reporting lines from the company's "Latest Team" sheet, the most up-to-date source.
//
// The worker never reads the sheet directly. A small Apps Script endpoint (see
// apps-script/team-sheet-endpoint.gs) returns only four fields per person (id, name, email,
// "Reporting To"); the sheet's sensitive columns are never exposed to the worker.
//
// Matching, most reliable first:
//   person  : DMS email == sheet "Email ID", else a UNIQUE full-name match
//   manager : the employee id printed in "Reporting To" (e.g. "Name WLDD/427/EMP") == sheet EmployeeID,
//             else a UNIQUE name match on the printed name
// The manager's email is taken from the sheet row itself, so no name guessing against the database.

const ID_RE = /(WLDD\/\d+\/[A-Z]+)\s*$/i;
const COMPANY_EMAIL = /^[^@\s]+@wldd\.in$/i;

export const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
export const idFromReportsTo = (text) => (String(text || '').match(ID_RE)?.[1] || '').toUpperCase() || null;
export const nameFromReportsTo = (text) => String(text || '').replace(ID_RE, '').trim();

export function parseTeamRows(payload) {
  if (!payload || payload.error) throw new Error(`team sheet endpoint: ${payload?.error || 'empty response'}`);
  if (!Array.isArray(payload.rows)) throw new Error('team sheet endpoint: no rows');
  return payload.rows
    .map((r) => ({ id: String(r.id || '').trim().toUpperCase(), name: String(r.name || '').trim(), email: String(r.email || '').trim().toLowerCase(), reportsTo: String(r.reportsTo || '').trim() }))
    .filter((r) => r.id);
}

/** Fetches the rows. A suspiciously small answer (truncated export) is treated as a failure, never as data. */
export async function fetchTeamRows({ url, fetchImpl = fetch, minRows = 50 }) {
  const res = await fetchImpl(url, { redirect: 'follow' });
  let data;
  try { data = await res.json(); } catch { throw new Error(`team sheet endpoint returned ${res.status} and not JSON`); }
  const rows = parseTeamRows(data);
  if (rows.length < minRows) throw new Error(`team sheet looks incomplete (${rows.length} rows)`);
  return rows;
}

export function makeManagerResolver(rows) {
  const byEmail = new Map();
  const byId = new Map();
  const byName = new Map();
  for (const r of rows) {
    if (r.email && !byEmail.has(r.email)) byEmail.set(r.email, r);
    if (!byId.has(r.id)) byId.set(r.id, r);
    const k = norm(r.name);
    if (k) byName.set(k, [...(byName.get(k) || []), r]);
  }
  const uniqueByName = (name) => { const c = byName.get(norm(name)); return c?.length === 1 ? c[0] : null; };

  return function resolve({ email, name }) {
    let row = byEmail.get(String(email || '').toLowerCase());
    let matchedBy = 'email';
    if (!row) { row = uniqueByName(name); matchedBy = 'name'; }
    if (!row) return { status: 'person_not_in_sheet' };
    if (!row.reportsTo) return { status: 'no_reporting_to', matchedBy };

    const mid = idFromReportsTo(row.reportsTo);
    const mgr = (mid && byId.get(mid)) || uniqueByName(nameFromReportsTo(row.reportsTo));
    if (!mgr) return { status: 'manager_not_found', matchedBy };
    if (mgr.id === row.id) return { status: 'self', matchedBy };
    if (!COMPANY_EMAIL.test(mgr.email)) return { status: 'manager_email_not_company', matchedBy };
    return { status: 'ok', matchedBy, manager_email: mgr.email, manager_name: mgr.name };
  };
}

/**
 * Overlay sheet managers on the people we are about to store. The sheet wins over the DMS-derived
 * manager (cohort/pod lead) when it can answer; otherwise the DMS answer is kept.
 */
export function overlayManagers(people, resolve) {
  const stats = { people: people.length, fromSheet: 0, agreeWithDms: 0, differFromDms: 0, keptDms: 0, none: 0, byStatus: {} };
  const out = people.map((p) => {
    const r = resolve({ email: p.email, name: p.name });
    stats.byStatus[r.status] = (stats.byStatus[r.status] || 0) + 1;
    if (r.status === 'ok') {
      stats.fromSheet++;
      if (p.manager_email) (p.manager_email.toLowerCase() === r.manager_email ? stats.agreeWithDms++ : stats.differFromDms++);
      return { ...p, manager_email: r.manager_email, manager_name: r.manager_name, manager_source: 'sheet' };
    }
    if (p.manager_email) { stats.keptDms++; return p; }
    stats.none++;
    return p;
  });
  return { people: out, stats };
}
