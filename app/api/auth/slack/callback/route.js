import { exchangeSlackCode, getSlackUser } from "@/lib/slack";
import { encrypt } from "@/lib/crypto";
import { db } from "@/lib/supabase";
import { getSession } from "@/lib/session";

export async function GET(req) {
  const code = new URL(req.url).searchParams.get("code");
  if (!code) return Response.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/login?error=no_code`);

  const data = await exchangeSlackCode(code);
  if (!data.ok || !data.authed_user?.access_token) {
    return Response.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/login?error=${data.error || "oauth_failed"}`);
  }

  const token = data.authed_user.access_token;
  const slackUserId = data.authed_user.id;
  const teamId = data.team?.id;

  // Profile
  const info = await getSlackUser(token, slackUserId);
  const profile = info.ok ? info.user : {};

  // First user ever becomes admin
  const { count } = await db.from("users").select("*", { count: "exact", head: true });
  const role = count === 0 ? "admin" : "member";

  // Upsert
  const { data: existing } = await db.from("users").select("id, role").eq("slack_user_id", slackUserId).single();
  let userId;
  if (existing) {
    userId = existing.id;
    await db.from("users").update({
      slack_access_token: encrypt(token),
      slack_team_id: teamId,
      name: profile.real_name || profile.name,
      avatar_url: profile.profile?.image_192,
      email: profile.profile?.email,
    }).eq("id", userId);
  } else {
    const { data: created } = await db.from("users").insert({
      slack_user_id: slackUserId,
      slack_team_id: teamId,
      slack_access_token: encrypt(token),
      role,
      name: profile.real_name || profile.name,
      avatar_url: profile.profile?.image_192,
      email: profile.profile?.email,
    }).select("id").single();
    userId = created.id;
  }

  const session = await getSession();
  session.userId = userId;
  await session.save();

  return Response.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/tracker`);
}
