import { db, logEvent } from "@/lib/supabase";
import { checkOneRecord } from "@/lib/checker";
import { sendDm } from "@/lib/slack";
import { sendEmail } from "@/lib/gmail";
import { followupBody, slackFollowup, outreachSubject } from "@/lib/templates";

export const maxDuration = 300; // allow up to 5 min on Vercel

export async function GET(req) {
  // Vercel cron sends Authorization: Bearer CRON_SECRET
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: records } = await db.from("outreach_records")
    .select("*, contacts(*)")
    .in("status", ["sent", "active", "no_reply", "followup"]);

  const { data: users } = await db.from("users").select("*");
  const userById = Object.fromEntries((users || []).map((u) => [u.id, u]));

  let checked = 0, autoFollowups = 0;
  for (const rec of records || []) {
    const owner = userById[rec.user_id];
    if (!owner) continue;
    const result = await checkOneRecord(rec, owner);
    checked++;

    // Optional auto-followup if the owner enabled it
    const settings = owner.settings || {};
    if (result.newStatus === "no_reply" && settings.auto_followup) {
      const days = (Date.now() - new Date(rec.reached_out_at).getTime()) / 86400000;
      const max = settings.max_followups ?? 3;
      if (days >= (settings.followup_after_days ?? 1) && rec.followups < max) {
        const c = rec.contacts;
        const n = rec.followups + 1;
        try {
          if (rec.channel === "email") {
            await sendEmail(owner, { to: c.email, subject: "Re: " + outreachSubject(c), body: followupBody(c, owner.name, n) });
          } else {
            const sent = await sendDm(owner, rec.slack_channel_id, slackFollowup(c, n));
            if (sent.ok) {
              const { error: tsErr } = await db.from("outreach_records").update({ slack_message_ts: sent.ts }).eq("id", rec.id);
              if (tsErr) console.error("cron: failed to update slack_message_ts:", tsErr.message);
            }
          }
          const { error: upErr } = await db.from("outreach_records").update({ status: "followup", followups: n, last_action_at: new Date().toISOString() }).eq("id", rec.id);
          if (upErr) { console.error("cron: failed to update followup status:", upErr.message); continue; }
          await logEvent({ outreachId: rec.id, userId: owner.id, action: "followup_sent", prevStatus: "no_reply", newStatus: "followup", payload: { n, auto: true } });
          autoFollowups++;
        } catch (e) { /* skip on error */ }
      }
    }
  }
  return Response.json({ ok: true, checked, autoFollowups });
}
