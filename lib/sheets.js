import { google } from "googleapis";

function serviceAuth() {
  return new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"]
  );
}

export function sheetIdFromUrl(url) {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

export async function readSheet(url) {
  const id = sheetIdFromUrl(url);
  if (!id) throw new Error("Not a valid Google Sheet URL");
  const sheets = google.sheets({ version: "v4", auth: serviceAuth() });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: id });
  const firstTab = meta.data.sheets[0].properties.title;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: firstTab });
  return res.data.values || [];
}

export async function exportSheet(title, header, rows, shareWithEmail) {
  const auth = serviceAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const drive = google.drive({ version: "v3", auth });
  const created = await sheets.spreadsheets.create({ requestBody: { properties: { title } } });
  const id = created.data.spreadsheetId;
  await sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: "A1",
    valueInputOption: "RAW",
    requestBody: { values: [header, ...rows] },
  });
  // Share: with the user's email if we have it, otherwise anyone-with-link
  try {
    if (shareWithEmail) {
      await drive.permissions.create({
        fileId: id,
        requestBody: { type: "user", role: "writer", emailAddress: shareWithEmail },
        sendNotificationEmail: false,
      });
    }
  } catch (e) { /* fall through to link share */ }
  await drive.permissions.create({ fileId: id, requestBody: { type: "anyone", role: "reader" } });
  return `https://docs.google.com/spreadsheets/d/${id}`;
}
