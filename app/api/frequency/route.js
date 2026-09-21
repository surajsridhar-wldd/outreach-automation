import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";
import { computeFrequency } from "@/lib/frequency.mjs";
import { labelOf } from "@/lib/ledger.mjs";

// One holistic view of how often people are chased and how well it works, from the unified ledger (admin only).
async function all(query) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query().range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  if (user.role !== "admin") return Response.json({ error: "Admin only" }, { status: 403 });
  try {
    const [issues, people, sends, replies, owners, weekly] = await Promise.all([
      all(() => db.from("issues").select("id,category,state,owner_dms_user_id,nudge_count,false_done_claims,hold_renewals,first_seen_at,cleared_at,last_nudged_at,source")),
      all(() => db.from("dms_people").select("dms_user_id,name,email,manager_email")),
      all(() => db.from("messages_out").select("id,recipient_dms_user_id,sent_at").eq("status", "sent").eq("mode", "live").neq("subject", "[legacy manual outreach]")),
      all(() => db.from("messages_in").select("sender_dms_user_id,received_at,in_reply_to_message_out_id").eq("from_owner", true)),
      all(() => db.from("issue_owners").select("replaces_dms_user_id").not("replaces_dms_user_id", "is", null)),
      db.from("nudge_weekly").select("*").order("week", { ascending: false }).limit(60).then((r) => r.data || []),
    ]);
    const outs = new Map(sends.map((s) => [s.id, s.sent_at]));
    const reassigned = new Map(); for (const o of owners) reassigned.set(o.replaces_dms_user_id, (reassigned.get(o.replaces_dms_user_id) || 0) + 1);
    const f = computeFrequency({ issues, people, sends, replies, outs, reassigned });
    return Response.json({ ...f, byCategory: f.byCategory.map((c) => ({ ...c, label: labelOf(c.category) })), weekly: weekly.map((w) => ({ ...w, label: labelOf(w.category) })) });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
