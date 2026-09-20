import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";

// Admin-only view of the automated nudge system (worker in GitHub Actions writes; this only reads,
// plus Pause/Resume and marking review items done).
async function admin() {
  const user = await requireUser();
  if (!user) return { res: unauthorized() };
  if (user.role !== "admin") return { res: Response.json({ error: "Admin only" }, { status: 403 }) };
  return { user };
}

const q = async (p) => { const { data, error } = await p; if (error) throw new Error(error.message); return data || []; };

export async function GET() {
  const a = await admin(); if (a.res) return a.res;
  try {
    const [settings, runs, needsOwner, review, cats, people, weekly, messages, replies, open] = await Promise.all([
      q(db.from("settings").select("key,value")),
      q(db.from("runs").select("id,mode,started_at,finished_at,ok,stats,error").order("started_at", { ascending: false }).limit(8)),
      q(db.from("issues").select("id,category,campaign_name,owner_dms_user_id,owner_state,item_count,first_seen_at").eq("state", "open").neq("owner_state", "active").order("first_seen_at")),
      q(db.from("review_items").select("id,kind,note,created_at,issue_id,issues(campaign_name,category)").eq("status", "open").order("created_at", { ascending: false }).limit(200)),
      q(db.from("nudge_category_stats").select("*")),
      q(db.from("nudge_person_stats").select("*").gt("issues_total", 0).order("open_after_3_nudges", { ascending: false }).order("false_done_claims", { ascending: false }).order("open_issues", { ascending: false }).limit(25)),
      q(db.from("nudge_weekly").select("*").order("week", { ascending: false }).limit(40)),
      q(db.from("messages_out").select("id,channel,kind,status,mode,to_address,intended_to,subject,created_at,sent_at,recipient_dms_user_id").order("created_at", { ascending: false }).limit(60)),
      q(db.from("interpretations").select("id,intent,evidence,confidence,promised_date,needs_review,created_at,issues(campaign_name),messages_in(sender_address,received_at)").order("created_at", { ascending: false }).limit(40)),
      q(db.from("issues").select("category,nudge_count,hold_until,claimed_done_at").eq("state", "open")),
    ]);
    const ids = [...new Set(messages.map((m) => m.recipient_dms_user_id).filter(Boolean))];
    const names = ids.length ? Object.fromEntries((await q(db.from("dms_people").select("dms_user_id,name").in("dms_user_id", ids))).map((p) => [p.dms_user_id, p.name])) : {};
    for (const m of messages) m.recipient_name = names[m.recipient_dms_user_id] || null;
    const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    const counts = {
      open: open.length,
      onHold: open.filter((i) => i.hold_until && i.hold_until >= today).length,
      claimedDone: open.filter((i) => i.claimed_done_at).length,
      atLadderEnd: open.filter((i) => i.nudge_count >= 5).length,
    };
    return Response.json({ settings: Object.fromEntries(settings.map((s) => [s.key, s.value])), runs, needsOwner, review, cats, people, weekly, messages, replies, counts });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req) {
  const a = await admin(); if (a.res) return a.res;
  const body = await req.json().catch(() => ({}));
  if (body.action === "pause" || body.action === "resume") {
    const { error } = await db.from("settings").upsert({ key: "paused", value: body.action === "pause", updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ ok: true, paused: body.action === "pause" });
  }
  if (body.action === "resolve_review" && typeof body.id === "string") {
    const { error } = await db.from("review_items").update({ status: "done", resolved_at: new Date().toISOString() }).eq("id", body.id);
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ ok: true });
  }
  return Response.json({ error: "Unknown action" }, { status: 400 });
}
