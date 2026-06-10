import { exchangeSlackCode } from "@/lib/slack";
import { encrypt } from "@/lib/crypto";
import { db } from "@/lib/supabase";
import { getSession } from "@/lib/session";

export async function GET(req) {
  const code = new URL(req.url).searchParams.get("code");
  if (!code) return Response.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/login?error=no_code`);

  try {
    const data = await exchangeSlackCode(code);
    if (!data.ok || !data.authed_user?.access_token) {
      return Response.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/login?error=${data.error || "oauth_failed"}`);
    }

    const token = data.authed_user.access_token;
    const slackUserId = data.authed_user.id;
    const teamId = data.team?.id || null;

    // Get profile using the user token directly
    const profileRes = await fetch(`https://slack.com/api/users.info?user=${slackUserId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const profileData = await profileRes.json();
    const profile = profileData.ok ? profileData.user : {};
    const realName = profile.real_name || profile.name || "Unknown";
    const avatar = profile.profile?.image_192 || null;
    const email = profile.profile?.email || null;

    // First user becomes admin
    const { count } = await db.from("users").select("*", { count: "exact", head: true });
    const role = (count === 0) ? "admin" : "member";

    // Check if user exists
    const { data: existing } = await db
      .from("users")
      .select("id")
      .eq("slack_user_id", slackUserId)
      .maybeSingle();

    let userId;

    if (existing?.id) {
      userId = existing.id;
      await db.from("users").update({
        slack_access_token: encrypt(token),
        slack_team_id: teamId,
        name: realName,
        avatar_url: avatar,
        email,
      }).eq("id", userId);
    } else {
      const { data: created, error: insertError } = await db.from("users").insert({
        slack_user_id: slackUserId,
        slack_team_id: teamId,
        slack_access_token: encrypt(token),
        role,
        name: realName,
        avatar_url: avatar,
        email,
      }).select("id").single();

      if (insertError || !created?.id) {
        console.error("Insert error:", JSON.stringify(insertError));
        return Response.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/login?error=db_${insertError?.code || "insert_failed"}`);
      }
      userId = created.id;
    }

    const session = await getSession();
    session.userId = userId;
    await session.save();

    return Response.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/tracker`);
  } catch (e) {
    console.error("Slack callback error:", e.message);
    return Response.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/login?error=${encodeURIComponent(e.message)}`);
  }
}
