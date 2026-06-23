import { requireUser, unauthorized } from "@/lib/session";
import { db, logEvent } from "@/lib/supabase";
import { checkOneRecord } from "@/lib/checker";
import { lookupByEmail, lookupByName, openDm, sendDm } from "@/lib/slack";
import { sendEmail } from "@/lib/gmail";
import { outreachSubject, outreachBody, slackOutreach } from "@/lib/templates";

export async function POST(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { ids, action, payload } = await req.json();
  if (!Array.isArray(ids) || !ids.length) return Response.json({ error: "Provide ids[]" }, { status: 400 });

  const results = [];

  for (const id of ids) {
    try {
      if (action === "delete") {
        const { data: rec } = await db.from("outreach_records").select("user_id, contact_id").eq("id", id).single();
        if (!rec || (rec.user_id !== user.id && user.role !== "admin")) { results.push({ id, ok: false, error: "not found or forbidden" }); continue; }
        const { error: delErr } = await db.from("outreach_records").delete().eq("id", id);
        if (delErr) throw new Error(delErr.message);
        const { count } = await db.from("outreach_records").select("*", { count: "exact", head: true }).eq("contact_id", rec.contact_id);
        if (count === 0) await db.from("contacts").delete().eq("id", rec.contact_id);
        results.push({ id, ok: true });

      } else {
        const { data: rec } = await db.from("outreach_records")
          .select("*, contacts(*)").eq("id", id).eq("user_id", user.id).single();
        if (!rec) { results.push({ id, ok: false, error: "not found" }); continue; }

        if (action === "check_reply") {
          const r = await checkOneRecord(rec, user);
          if (r.error) { results.push({ id, ok: false, name: rec.contacts?.name, error: r.error }); continue; }
          results.push({ id, ok: true, name: rec.contacts?.name, ...r });

        } else if (action === "resolve") {
          const { error: upErr } = await db.from("outreach_records").update({ status: "resolved", resolved_by: user.id, last_action_at: new Date().toISOString() }).eq("id", id);
          if (upErr) throw new Error(upErr.message);
          await logEvent({ outreachId: id, userId: user.id, action: "resolved", prevStatus: rec.status, newStatus: "resolved" });
          results.push({ id, ok: true });

        } else if (action === "monitor") {
          const note = payload?.note || "";
          const { error: upErr } = await db.from("outreach_records").update({
            status: "monitoring", message_notes: note || rec.message_notes, last_action_at: new Date().toISOString(),
          }).eq("id", id);
          if (upErr) throw new Error(upErr.message);
          await logEvent({ outreachId: id, userId: user.id, action: "status_changed", prevStatus: rec.status, newStatus: "monitoring", payload: { note } });
          results.push({ id, ok: true });

        } else if (action === "reassign") {
          // Renamed from escalate. Marks original record as escalated, creates a new pending
          // contact + outreach record for the new person, then immediately sends them a message
          // on the same channel as the original outreach.
          const note = payload?.note || "";
          const toName = payload?.toName || "";
          const toEmail = payload?.toEmail || "";
          const channel = rec.channel || "slack"; // use the same channel as original
          const c = rec.contacts;

          // 1. Mark original record as escalated
          const { error: upErr } = await db.from("outreach_records").update({
            status: "escalated",
            message_notes: note,
            last_action_at: new Date().toISOString(),
          }).eq("id", id);
          if (upErr) throw new Error(upErr.message);
          await logEvent({ outreachId: id, userId: user.id, action: "status_changed", prevStatus: rec.status, newStatus: "escalated", payload: { note, reassignedTo: { name: toName, email: toEmail } } });

          // 2. Create a new contact for the reassigned person (same campaign + issue)
          let newOutreachId = null;
          if (toName) {
            const { data: newContact, error: cErr } = await db.from("contacts").insert({
              user_id: user.id,
              name: toName,
              email: toEmail || null,
              campaign: c?.campaign || null,
              issue: c?.issue || null,
              source: "reassign",
            }).select("id").single();

            if (cErr) throw new Error(`Failed to create contact for reassigned person: ${cErr.message}`);

            const { data: newOutreach, error: oErr } = await db.from("outreach_records").insert({
              contact_id: newContact.id,
              user_id: user.id,
              status: "pending",
            }).select("id").single();
            if (oErr) throw new Error(`Failed to create outreach record: ${oErr.message}`);

            newOutreachId = newOutreach.id;
            await logEvent({ outreachId: newOutreach.id, userId: user.id, action: "created", newStatus: "pending", payload: { reassignedFrom: id, note } });

            // 3. Immediately send the initial outreach message to the new person
            const newC = { ...c, name: toName, email: toEmail || null, slack_user_id: null };
            const patch = {
              channel,
              status: "sent",
              reached_out_at: new Date().toISOString(),
              last_action_at: new Date().toISOString(),
            };

            try {
              if (channel === "email") {
                if (!toEmail) throw new Error("No email for reassigned person — add one and send manually");
                const { messageId, threadId } = await sendEmail(user, {
                  to: toEmail,
                  subject: outreachSubject(newC),
                  body: outreachBody(newC, user.name || "Operations Team"),
                });
                patch.gmail_message_id = messageId;
                patch.gmail_thread_id = threadId;
              } else {
                // Slack
                let slackId = null;
                if (toEmail) slackId = await lookupByEmail(user, toEmail);
                if (!slackId && toName) slackId = await lookupByName(user, toName);
                if (!slackId) throw new Error(`Could not find "${toName}" on Slack — add their email and retry`);

                // Cache slack_user_id on the new contact
                await db.from("contacts").update({ slack_user_id: slackId }).eq("id", newContact.id);

                const channelId = await openDm(user, slackId);
                if (!channelId) throw new Error("Could not open Slack DM with reassigned person");

                const sent = await sendDm(user, channelId, slackOutreach(newC, user.name || "Operations Team"));
                if (!sent.ok) throw new Error(sent.error || "Slack send to reassigned person failed");

                patch.slack_channel_id = channelId;
                patch.slack_message_ts = String(sent.ts);
                patch.first_message_ts = String(sent.ts);
              }

              const { error: sendErr } = await db.from("outreach_records").update(patch).eq("id", newOutreach.id);
              if (sendErr) throw new Error(`Message sent but DB update failed: ${sendErr.message}`);
              await logEvent({ outreachId: newOutreach.id, userId: user.id, action: "sent", prevStatus: "pending", newStatus: "sent", payload: { channel } });

            } catch (sendEx) {
              // Message send failed — leave new record as pending so user can retry manually
              await logEvent({ outreachId: newOutreach.id, userId: user.id, action: "note_added", payload: { note: `Auto-send failed: ${sendEx.message}` } });
              results.push({ id, ok: true, warning: `Reassigned but auto-send failed: ${sendEx.message}. New record created as pending.`, newOutreachId });
              continue;
            }
          }

          results.push({ id, ok: true, newOutreachId });

        } else if (action === "escalate") {
          // Legacy alias → redirect to reassign for backward compatibility
          const note = payload?.note || "";
          const escalateTo = payload?.escalateTo || null;
          const { error: upErr } = await db.from("outreach_records").update({
            status: "escalated", message_notes: note, last_action_at: new Date().toISOString(),
          }).eq("id", id);
          if (upErr) throw new Error(upErr.message);
          await logEvent({ outreachId: id, userId: user.id, action: "status_changed", prevStatus: rec.status, newStatus: "escalated", payload: { note, escalateTo } });
          results.push({ id, ok: true });

        } else if (action === "set_status") {
          const newStatus = payload?.status;
          if (!newStatus) { results.push({ id, ok: false, error: "no status" }); continue; }
          const { error: upErr } = await db.from("outreach_records").update({ status: newStatus, last_action_at: new Date().toISOString() }).eq("id", id);
          if (upErr) throw new Error(upErr.message);
          await logEvent({ outreachId: id, userId: user.id, action: "status_changed", prevStatus: rec.status, newStatus, payload });
          results.push({ id, ok: true });
        }
      }
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
    }
  }

  return Response.json({ results });
}
