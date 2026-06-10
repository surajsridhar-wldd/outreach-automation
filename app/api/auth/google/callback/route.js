import { google } from "googleapis";
import { googleOAuthClient } from "@/lib/gmail";
import { encrypt } from "@/lib/crypto";
import { db } from "@/lib/supabase";
import { requireUser } from "@/lib/session";

export async function GET(req) {
  const user = await requireUser();
  if (!user) return Response.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/login`);

  const code = new URL(req.url).searchParams.get("code");
  if (!code) return Response.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/settings?gmail=failed`);

  const client = googleOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  // Find the gmail address
  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const me = await oauth2.userinfo.get();

  await db.from("users").update({
    gmail_refresh_token: encrypt(tokens.refresh_token),
    gmail_address: me.data.email,
  }).eq("id", user.id);

  return Response.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/settings?gmail=connected`);
}
