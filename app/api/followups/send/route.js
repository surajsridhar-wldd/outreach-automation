import { requireUser, unauthorized } from "@/lib/session";
import { db, logEvent } from "@/lib/supabase";
import { sendDm } from "@/lib/slack";
import { sendEmail } from "@/lib/gmail";
import { followupBody, slackFollowup, outreachSubject } from "@/lib/templates";

const MAX_FOLLOWUPS = 3;

export async function POST(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { ids } = await req.json();
  if (!Array.isArray(ids) || !ids.length) return Response.json({ error: "Provide ids[]" }, { status: 400 });

  const results = [];
  for (const id of ids) {
    const { data: rec } = await db.from("outreach_records")
      .select("*, contacts(*)").eq("id", id).eq("user_id", user.id).single();

    if (!rec || !["no_reply", "stalled", "sent", "followup"].includes(rec.status)) {
      results.push({ id, ok: false, name: rec?.contacts?.name, error: "Not eligible for follow-up" }); continue;
    }
    if (rec.followups >= MAX_FOLLOWUPS) {
      await db.from("outreach_records").update({ status: "stalled", last_action_at: new Date().toISOString() }).eq("id", id);
      await logEvent({ outreachId: id, userId: user.id, action: "escalated_stalled", prevStatus: rec.status, newStatus: "stalled" });
      results.push({ id, ok: false, name: rec.contacts?.name, error: "Max follow-ups reached → marked Stalled" }); continue;
    }

    const c = rec.contacts;
    const n = rec.followups + 1;
    try {
      if (rec.channel === "email") {
        if (!c.email) throw new Error("No email address");
        await sendEmail(user, { to: c.email, subject: "Re: " + outreachSubject(c), body: followupBody(c, user.name || "Operations Team", n) });
      } else {
        if (!rec.slack_channel_id) throw new Error("No Slack channel ID");
        const sent = await sendDm(user, rec.slack_channel_id, slackFollowup(c, n));
        if (!sent.ok) throw new Error(sent.error || "Slack send failed");
        await db.from("outreach_records").update({ slack_message_ts: sent.ts }).eq("id", id);
      }
      await db.from("outreach_records").update({ status:"followup", followups:n, last_action_at:new Date().toISOString() }).eq("id", id);
      await logEvent({ outreachId: id, userId: user.id, action:"followup_sent", prevStatus:rec.status, newStatus:"followup", payload:{ n } });
      results.push({ id, ok: true, name: c.name });
    } catch (e) {
      results.push({ id, ok: false, name: c.name, error: e.message });
    }
  }
  return Response.json({ results });
}
