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

export async function sendEmail(user, { to, subject, body }) {
  const raw = Buffer.from(
    `From: ${user.gmail_address}\r\nTo: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const res = await gmailFor(user).users.messages.send({ userId: "me", requestBody: { raw } });
  return { messageId: res.data.id, threadId: res.data.threadId };
}

// Returns messages from the POC in our exact thread, after our send
export async function threadRepliesFrom(user, threadId, pocEmail, sinceMs) {
  const res = await gmailFor(user).users.threads.get({ userId: "me", id: threadId, format: "full" });
  const msgs = res.data.messages || [];
  const replies = [];
  for (const m of msgs) {
    const from = (m.payload?.headers || []).find((h) => h.name.toLowerCase() === "from")?.value || "";
    const ts = parseInt(m.internalDate || "0", 10);
    if (ts > sinceMs && from.toLowerCase().includes(pocEmail.toLowerCase())) {
      replies.push(m.snippet || "(no preview)");
    }
  }
  return replies;
}
