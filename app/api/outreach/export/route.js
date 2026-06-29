import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";
import { exportSheet } from "@/lib/sheets";

const LABEL = {
  pending: "Pending", sent: "Outreach Sent", active: "Active",
  needs_review: "Needs Review", followup: "Follow-up Sent", snoozed: "Snoozed",
  resolved: "Resolved", no_reply: "No Reply", stalled: "Stalled", escalated: "Escalated",
};

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { data: records } = await db.from("outreach_records")
    .select("*, contacts(id, name, email, campaign, issue)")
    .eq("user_id", user.id).order("created_at", { ascending: false });

  const header = ["Campaign", "Name", "Email", "Issue", "Status", "Channel", "Reached Out At", "Replied At", "Follow-ups", "Classification", "Notes"];
  const rows = (records || []).map((r) => [
    r.contacts?.campaign || "", r.contacts?.name || "", r.contacts?.email || "", r.contacts?.issue || "",
    LABEL[r.status] || r.status, r.channel || "", r.reached_out_at || "", r.replied_at || "",
    r.followups, r.reply_classification || "", r.message_notes || "",
  ]);
  try {
    const url = await exportSheet(
      `Ops Outreach Tracker — ${user.name || "export"} — ${new Date().toISOString().slice(0, 10)}`,
      header, rows, user.gmail_address || user.email
    );
    return Response.json({ url });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
