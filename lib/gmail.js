import { google } from "googleapis";
import { decrypt } from "./crypto";

export function googleOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.NEXT_PUBLIC_BASE_URL}/api/auth/google/callback`
  );
}

export function googleAuthUrl() {
  return googleOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  });
}

function gmailFor(user) {
  const auth = googleOAuthClient();
  auth.setCredentials({ refresh_token: decrypt(user.gmail_refresh_token) });
  return google.gmail({ version: "v1", auth });
}

// Encode subject with RFC 2047 UTF-8 to avoid garbled special chars
function encodeSubject(subject) {
  // Only encode if non-ASCII chars present
  if (/^[\x00-\x7F]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
}

export async function sendEmail(user, { to, subject, body }) {
  const encodedSubject = encodeSubject(subject);
  const message = [
    `From: ${user.gmail_address}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    body,
  ].join("\r\n");

  const raw = Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await gmailFor(user).users.messages.send({ userId: "me", requestBody: { raw } });
  return { messageId: res.data.id, threadId: res.data.threadId };
}

// Returns reply snippets from the POC in our thread, after our send
export async function threadRepliesFrom(user, threadId, pocEmail, sinceMs) {
  try {
    const res = await gmailFor(user).users.threads.get({ userId: "me", id: threadId, format: "full" });
    const msgs = res.data.messages || [];
    const replies = [];
    for (const m of msgs) {
      const headers = m.payload?.headers || [];
      const from = headers.find(h => h.name.toLowerCase() === "from")?.value || "";
      const ts = parseInt(m.internalDate || "0", 10);
      if (ts > sinceMs && from.toLowerCase().includes(pocEmail.toLowerCase())) {
        replies.push(m.snippet || "(no preview)");
      }
    }
    return replies;
  } catch (e) {
    console.error("threadRepliesFrom error:", e.message);
    return [];
  }
}
