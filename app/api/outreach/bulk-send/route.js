import { requireUser, unauthorized } from "@/lib/session";
import { db, logEvent } from "@/lib/supabase";
import { lookupByEmail, lookupByName, openDm, sendDm } from "@/lib/slack";
import { sendEmail } from "@/lib/gmail";
import { outreachSubject, outreachBody, slackOutreach, bundledOutreachSubject, bundledOutreachBody, slackBundledOutreach } from "@/lib/templates";
import { keyOf } from "@/lib/matching";
import crypto from "crypto";

// Groups selected pending records by RECIPIENT (email if present, else normalized
// name) so that if 2+ selected records are going to the same person, they go out
// as ONE message listing all issues instead of separate messages. Records stay
// independent in the DB (each keeps its own status/history) — they just share a
// batch_id and the same sent message's channel/ts/thread so reply-checking can
// attribute a reply back to whichever specific issue it's actually about.
function groupByRecipient(recs) {
  const groups = new Map();
  for (const rec of recs) {
    const c = rec.contacts;
    const key = c.email ? `email:${keyOf(c.email)}` : `name:${keyOf(c.name)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rec);
  }
  return [...groups.values()];
}

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

  const { data: allRecs } = await db.from("outreach_records")
    .select("*, contacts(*)").in("id", ids).eq("user_id", user.id);

  const results = [];
  const pendingRecs = [];
  for (const id of ids) {
    const rec = (allRecs || []).find(r => r.id === id);
    if (!rec || rec.status !== "pending") {
      results.push({ id, ok: false, name: rec?.contacts?.name || id, error: "Not pending — skipped" });
      continue;
    }
    pendingRecs.push(rec);
  }

  const groups = groupByRecipient(pendingRecs);

  for (const group of groups) {
    if (group.length === 1) {
      await sendSingle(group[0], user, channel, results);
    } else {
      await sendBundled(group, user, channel, results);
    }
  }

  const sent   = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;

  return Response.json({ results, sent, failed });
}

async function sendSingle(rec, user, channel, results) {
  const c = rec.contacts;
  try {
    const patch = {
      channel, status: "sent",
      reached_out_at: new Date().toISOString(), last_action_at: new Date().toISOString(),
    };

    if (channel === "email") {
      if (!c.email) throw new Error("No email address for this contact");
      const { messageId, threadId } = await sendEmail(user, {
        to: c.email, subject: outreachSubject(c), body: outreachBody(c, user.name || "Operations Team"),
      });
      patch.gmail_message_id = messageId;
      patch.gmail_thread_id = threadId;
    } else {
      const slackId = await resolveSlackId(c, user);
      const channelId = await openDm(user, slackId);
      if (!channelId) throw new Error("Could not open Slack DM");
      const sent = await sendDm(user, channelId, slackOutreach(c, user.name || "Operations Team"));
      if (!sent.ok) throw new Error(sent.error || "Slack send failed");
      patch.slack_channel_id = channelId;
      patch.slack_message_ts = sent.ts;
      patch.first_message_ts = sent.ts;
    }

    const { error: updateErr } = await db.from("outreach_records").update(patch).eq("id", rec.id);
    if (updateErr) throw new Error(`Message sent but failed to update status: ${updateErr.message}`);
    await logEvent({ outreachId: rec.id, userId: user.id, action: "sent", prevStatus: "pending", newStatus: "sent", payload: { channel } });
    results.push({ id: rec.id, ok: true, name: c.name });
  } catch (e) {
    results.push({ id: rec.id, ok: false, name: c.name, error: e.message });
  }
}

async function sendBundled(group, user, channel, results) {
  const c0 = group[0].contacts;
  const items = group.map(r => ({ campaign: r.contacts.campaign, issue: r.contacts.issue }));
  const batchId = crypto.randomUUID();

  try {
    const patch = {
      channel, status: "sent", batch_id: batchId,
      reached_out_at: new Date().toISOString(), last_action_at: new Date().toISOString(),
    };

    if (channel === "email") {
      if (!c0.email) throw new Error("No email address for this contact");
      const { messageId, threadId } = await sendEmail(user, {
        to: c0.email,
        subject: bundledOutreachSubject(c0.name, items.length),
        body: bundledOutreachBody(c0.name, items, user.name || "Operations Team"),
      });
      patch.gmail_message_id = messageId;
      patch.gmail_thread_id = threadId;
    } else {
      const slackId = await resolveSlackId(c0, user);
      const channelId = await openDm(user, slackId);
      if (!channelId) throw new Error("Could not open Slack DM");
      const sent = await sendDm(user, channelId, slackBundledOutreach(c0.name, items, user.name || "Operations Team"));
      if (!sent.ok) throw new Error(sent.error || "Slack send failed");
      patch.slack_channel_id = channelId;
      patch.slack_message_ts = sent.ts;
      patch.first_message_ts = sent.ts;
      // Cache the resolved Slack ID on every contact in the bundle so future
      // reply-checks/follow-ups for each record don't need to re-resolve it.
      for (const rec of group) {
        if (rec.contacts.slack_user_id !== slackId) {
          await db.from("contacts").update({ slack_user_id: slackId }).eq("id", rec.contacts.id);
        }
      }
    }

    // Apply the SAME sent message's channel/ts/thread to every record in the
    // bundle — each stays an independent record, but reply-checking (which
    // already attributes per-person across a contact's open issues) will find
    // the same conversation for all of them.
    for (const rec of group) {
      const { error: updateErr } = await db.from("outreach_records").update(patch).eq("id", rec.id);
      if (updateErr) {
        results.push({ id: rec.id, ok: false, name: rec.contacts.name, error: `Message sent but failed to update status: ${updateErr.message}` });
        continue;
      }
      await logEvent({ outreachId: rec.id, userId: user.id, action: "sent", prevStatus: "pending", newStatus: "sent", payload: { channel, bundled: true, batchId, bundleSize: group.length } });
      results.push({ id: rec.id, ok: true, name: `${rec.contacts.name} (bundled ×${group.length})` });
    }
  } catch (e) {
    for (const rec of group) {
      results.push({ id: rec.id, ok: false, name: rec.contacts.name, error: e.message });
    }
  }
}

async function resolveSlackId(c, user) {
  let slackId = c.slack_user_id;
  if (!slackId && c.email) slackId = await lookupByEmail(user, c.email);
  if (!slackId && c.name)  slackId = await lookupByName(user, c.name);
  if (!slackId) throw new Error(`Could not find "${c.name}" on Slack — check name matches their Slack profile`);
  if (slackId !== c.slack_user_id) {
    const { error: cacheErr } = await db.from("contacts").update({ slack_user_id: slackId }).eq("id", c.id);
    if (cacheErr) console.error(`Failed to cache slack_user_id for ${c.name}:`, cacheErr.message);
  }
  return slackId;
}
