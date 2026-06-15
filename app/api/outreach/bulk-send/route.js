import { requireUser, unauthorized } from "@/lib/session";
import { db, logEvent } from "@/lib/supabase";
import { lookupByEmail, lookupByName, openDm, sendDm } from "@/lib/slack";
import { sendEmail } from "@/lib/gmail";
import { outreachSubject, outreachBody, slackOutreach } from "@/lib/templates";

export async function POST(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { ids, channel } = await req.json();

  if (!Array.isArray(ids) || !ids.length || !["email", "slack"].includes(channel)) {
    return Response.json({ error: "Provide ids[] and channel (email|slack)" }, { status: 400 });
  }
  if (channel === "email" && !user.gmail_refresh_token) {
    return Response.json({ error: "Connect Gmail in Settings before sending emails." }, { status: 400 });
  }

  const results = [];

  for (const id of ids) {
    const { data: rec } = await db.from("outreach_records")
      .select("*, contacts(*)").eq("id", id).eq("user_id", user.id).single();

    if (!rec || rec.status !== "pending") {
      results.push({ id, ok: false, name: rec?.contacts?.name || id, error: "Not pending — skipped" });
      continue;
    }

    const c = rec.contacts;

    try {
      const patch = {
        channel,
        status: "sent",
        reached_out_at: new Date().toISOString(),
        last_action_at: new Date().toISOString(),
      };

      if (channel === "email") {
        if (!c.email) throw new Error("No email address for this contact");
        const { messageId, threadId } = await sendEmail(user, {
          to: c.email,
          subject: outreachSubject(c),
          body: outreachBody(c, user.name || "Operations Team"),
        });
        patch.gmail_message_id = messageId;
        patch.gmail_thread_id = threadId;

      } else {
        // Slack: resolve ID by cached → email → name
        let slackId = c.slack_user_id;
        if (!slackId && c.email) slackId = await lookupByEmail(user, c.email);
        if (!slackId && c.name)  slackId = await lookupByName(user, c.name);
        if (!slackId) throw new Error(`Could not find "${c.name}" on Slack — check name matches their Slack profile`);

        // Cache the resolved Slack ID
        if (slackId !== c.slack_user_id) {
          await db.from("contacts").update({ slack_user_id: slackId }).eq("id", c.id);
        }

        const channelId = await openDm(user, slackId);
        if (!channelId) throw new Error("Could not open Slack DM");

        const sent = await sendDm(user, channelId, slackOutreach(c, user.name || "Operations Team"));
        if (!sent.ok) throw new Error(sent.error || "Slack send failed");

        patch.slack_channel_id = channelId;
        patch.slack_message_ts = sent.ts;
      }

      await db.from("outreach_records").update(patch).eq("id", rec.id);
      await logEvent({
        outreachId: rec.id, userId: user.id,
        action: "sent", prevStatus: "pending", newStatus: "sent",
        payload: { channel },
      });

      results.push({ id, ok: true, name: c.name });

    } catch (e) {
      results.push({ id, ok: false, name: c.name, error: e.message });
    }
  }

  const sent   = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;

  return Response.json({ results, sent, failed });
}
