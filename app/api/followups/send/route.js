import { requireUser, unauthorized } from "@/lib/session";
import { db, logEvent } from "@/lib/supabase";
import { sendDm, lookupByEmail, lookupByName, openDm } from "@/lib/slack";
import { sendEmail } from "@/lib/gmail";
import { followupBody, slackFollowup, outreachSubject } from "@/lib/templates";

const MAX_FOLLOWUPS = 3;

export async function POST(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { ids, channel } = await req.json(); // channel: "slack" | "email" | undefined (= use original channel)
  if (!Array.isArray(ids) || !ids.length) return Response.json({ error: "Provide ids[]" }, { status: 400 });

  if (channel === "email" && !user.gmail_refresh_token) {
    return Response.json({ error: "Connect Gmail in Settings before sending email follow-ups." }, { status: 400 });
  }

  const results = [];
  for (const id of ids) {
    const { data: rec } = await db.from("outreach_records")
      .select("*, contacts(*)").eq("id", id).eq("user_id", user.id).single();

    if (!rec || !["active", "no_reply", "stalled", "sent", "followup"].includes(rec.status)) {
      results.push({ id, ok: false, name: rec?.contacts?.name, error: "Not eligible for follow-up" }); continue;
    }
    if (rec.followups >= MAX_FOLLOWUPS) {
      const { error: stallErr } = await db.from("outreach_records").update({ status: "stalled", last_action_at: new Date().toISOString() }).eq("id", id);
      if (stallErr) { results.push({ id, ok: false, name: rec.contacts?.name, error: stallErr.message }); continue; }
      await logEvent({ outreachId: id, userId: user.id, action: "escalated_stalled", prevStatus: rec.status, newStatus: "stalled" });
      results.push({ id, ok: false, name: rec.contacts?.name, error: "Max follow-ups reached → marked Stalled" }); continue;
    }

    const c = rec.contacts;
    const n = rec.followups + 1;
    const useChannel = channel || rec.channel; // default to original channel if not specified

    try {
      const patch = { status: "followup", followups: n, last_action_at: new Date().toISOString() };

      if (useChannel === "email") {
        if (!c.email) throw new Error("No email address for this contact");
        const { messageId, threadId } = await sendEmail(user, {
          to: c.email,
          subject: "Re: " + outreachSubject(c),
          body: followupBody(c, user.name || "Operations Team", n),
        });
        // If switching from slack→email mid-flow, set up email anchors for future checks
        if (rec.channel !== "email") {
          patch.channel = "email";
          patch.gmail_message_id = messageId;
          patch.gmail_thread_id = threadId;
          patch.reached_out_at = new Date().toISOString(); // reset anchor for email thread checking
        }
      } else {
        // Slack follow-up
        let channelId = rec.slack_channel_id;
        if (!channelId) {
          let slackId = c.slack_user_id;
          if (!slackId && c.email) slackId = await lookupByEmail(user, c.email);
          if (!slackId && c.name)  slackId = await lookupByName(user, c.name);
          if (!slackId) throw new Error(`Could not find "${c.name}" on Slack`);
          channelId = await openDm(user, slackId);
          if (!channelId) throw new Error("Could not open Slack DM");
          patch.slack_channel_id = channelId;
          patch.first_message_ts = patch.first_message_ts || null;
        }
        const sent = await sendDm(user, channelId, slackFollowup(c, n));
        if (!sent.ok) throw new Error(sent.error || "Slack send failed");
        patch.slack_message_ts = sent.ts;
        if (!rec.first_message_ts) patch.first_message_ts = sent.ts;
        if (rec.channel !== "slack") patch.channel = "slack";
      }

      const { error: upErr } = await db.from("outreach_records").update(patch).eq("id", id);
      if (upErr) throw new Error(`Message sent but failed to update status: ${upErr.message}`);
      await logEvent({
        outreachId: id, userId: user.id, action: "followup_sent",
        prevStatus: rec.status, newStatus: "followup",
        payload: { n, channel: useChannel },
      });
      results.push({ id, ok: true, name: c.name });
    } catch (e) {
      results.push({ id, ok: false, name: c.name, error: e.message });
    }
  }
  return Response.json({ results });
}
