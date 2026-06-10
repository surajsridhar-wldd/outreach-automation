import { requireUser, unauthorized } from "@/lib/session";
import { db, logEvent } from "@/lib/supabase";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();

  const { data: records } = await db.from("outreach_records")
    .select("*, contacts(name, email, campaign, issue)")
    .eq("user_id", user.id)
    .in("status", ["needs_review", "resolved_auto", "replied"])
    .order("last_action_at", { ascending: false });

  // For each record, fetch the most recent reply_classified event to get full messages
  const enriched = await Promise.all((records || []).map(async (rec) => {
    const { data: events } = await db.from("outreach_history")
      .select("payload, created_at")
      .eq("outreach_id", rec.id)
      .eq("action", "reply_classified")
      .order("created_at", { ascending: false })
      .limit(1);

    const latestEvent = events?.[0];
    return {
      ...rec,
      reply_messages: latestEvent?.payload?.messages || [],
      reply_deterministic: latestEvent?.payload?.deterministic ?? null,
    };
  }));

  return Response.json({ records: enriched });
}

export async function POST(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { id, decision } = await req.json();
  // decision: resolved | replied | declined (= not resolved, back to no_reply for follow-up)

  const { data: rec } = await db.from("outreach_records")
    .select("*").eq("id", id).eq("user_id", user.id).single();
  if (!rec) return Response.json({ error: "Not found" }, { status: 404 });

  let newStatus;
  const patch = { last_action_at: new Date().toISOString() };

  if (decision === "resolved") {
    newStatus = "resolved";
    patch.status = "resolved";
    patch.resolved_by = user.id;
  } else if (decision === "replied") {
    newStatus = "replied";
    patch.status = "replied";
    patch.replied_at = rec.replied_at || new Date().toISOString();
  } else if (decision === "declined") {
    // Not resolved — put back in no_reply so it enters follow-up queue
    newStatus = "no_reply";
    patch.status = "no_reply";
    patch.reply_classification = null;
    patch.reply_confidence = null;
    patch.message_notes = null;
    patch.replied_at = null;
  }

  await db.from("outreach_records").update(patch).eq("id", id);
  await logEvent({
    outreachId: id, userId: user.id,
    action: "status_changed",
    prevStatus: rec.status, newStatus,
    payload: { via: "review", decision },
  });
  return Response.json({ ok: true });
}
