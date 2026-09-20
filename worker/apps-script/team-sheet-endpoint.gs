/**
 * Read-only endpoint for the nudge worker: returns ONLY who reports to whom.
 *
 * The "Latest Team" sheet also holds Aadhaar/PAN numbers, birth dates, addresses and emergency
 * contacts. This script never reads or returns those columns: it picks four columns by header name
 * and nothing else. Runs as the person who deploys it (who has view access to the sheet).
 *
 * Setup: paste this into a new Apps Script project, replace KEY with a long random text, then
 * Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone.
 */
const SHEET_ID = '1Am8F341lrptQiGsZfyTOrn63rum3-tSM9dg9Ff_Y1pY';
const TAB_NAME = 'Latest Team';
const KEY = 'PASTE-A-LONG-RANDOM-TEXT-HERE';

function doGet(e) {
  const out = (obj) => ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  if (!KEY || KEY.length < 24 || KEY.indexOf('PASTE') === 0) return out({ error: 'endpoint not configured' });
  if (!e || !e.parameter || e.parameter.key !== KEY) return out({ error: 'unauthorized' });

  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TAB_NAME);
  if (!sheet) return out({ error: 'tab not found' });
  const values = sheet.getDataRange().getValues();
  const header = values[0].map((h) => String(h).trim());
  const col = (name) => header.indexOf(name);
  const iId = col('EmployeeID'), iFirst = col('First Name'), iLast = col('Last Name'), iEmail = col('Email ID'), iRep = col('Reporting To');
  if ([iId, iFirst, iLast, iEmail, iRep].some((i) => i < 0)) return out({ error: 'expected columns not found' });

  const rows = values.slice(1)
    .filter((r) => String(r[iId]).trim())
    .map((r) => ({
      id: String(r[iId]).trim(),
      name: (String(r[iFirst]).trim() + ' ' + String(r[iLast]).trim()).trim(),
      email: String(r[iEmail]).trim().toLowerCase(),
      reportsTo: String(r[iRep]).trim(),
    }));
  return out({ rows: rows });
}
