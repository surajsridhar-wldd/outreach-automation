import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";
import { labelOf } from "@/lib/ledger.mjs";

export async function GET(req) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope");
  const format = url.searchParams.get("format"); // xlsx

  // Build stats from outreach_records + contacts directly
  // (more reliable than the view which can miss bulk sends)
  let q = db.from("outreach_records")
    .select("*, contacts(id, name, email, campaign)")
    .neq("status", "pending") // only count sent ones
    .order("created_at", { ascending: false });

  if (!(scope === "all" && user.role === "admin")) {
    q = q.eq("user_id", user.id);
  }

  const { data: records, error } = await q;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  // Aggregate by POC email (or name if no email) — one row per POC across all campaigns
  const pocMap = {};
  for (const r of (records || [])) {
    const key = r.contacts?.email || r.contacts?.name || "unknown";
    if (!pocMap[key]) {
      pocMap[key] = {
        poc_email: r.contacts?.email || "",
        poc_name: r.contacts?.name || "Unknown",
        user_id: r.user_id,
        campaigns: new Set(),
        total_outreaches: 0,
        total_followups: 0,
        reply_count: 0,
        response_times_hours: [],
        last_contacted: null,
        statuses: [],
      };
    }
    const p = pocMap[key];
    if (r.contacts?.campaign) p.campaigns.add(r.contacts.campaign);
    p.total_outreaches++;
    p.total_followups += (r.followups || 0);
    p.statuses.push(r.status);
    if (r.replied_at && r.reached_out_at) {
      p.reply_count++;
      const hrs = (new Date(r.replied_at) - new Date(r.reached_out_at)) / 3600000;
      if (hrs > 0) p.response_times_hours.push(hrs);
    }
    if (!p.last_contacted || r.reached_out_at > p.last_contacted) {
      p.last_contacted = r.reached_out_at;
    }
  }

  // Get user names for admin view
  let userMap = {};
  if (scope === "all" && user.role === "admin") {
    const { data: users } = await db.from("users").select("id, name");
    userMap = Object.fromEntries((users || []).map(u => [u.id, u.name]));
  }

  // Unified numbers: everything the automation and "send now" have sent, and how each person's issues stand in the ledger.
  let ledgerCategories = [];
  const ledgerByEmail = {};
  if (scope === "all" && user.role === "admin") {
    const [{ data: sent }, { data: iss }, { data: ppl }, { data: cats }] = await Promise.all([
      db.from("messages_out").select("recipient_dms_user_id").eq("channel", "email").eq("status", "sent").eq("mode", "live").neq("subject", "[legacy manual outreach]"),
      db.from("issues").select("owner_dms_user_id,state,nudge_count,false_done_claims,hold_renewals"),
      db.from("dms_people").select("dms_user_id,name,email"),
      db.from("nudge_category_stats").select("*"),
    ]);
    ledgerCategories = (cats || []).map((c) => ({ ...c, label: labelOf(c.category) }));
    const byId = Object.fromEntries((ppl || []).map((p) => [p.dms_user_id, p]));
    const slot = (id) => { const p = byId[id]; if (!p?.email) return null; return (ledgerByEmail[p.email.toLowerCase()] ||= { name: p.name, email: p.email, auto_nudges: 0, open_now: 0, false_done: 0, holds: 0 }); };
    for (const m of sent || []) { const l = slot(m.recipient_dms_user_id); if (l) l.auto_nudges++; }
    for (const i of iss || []) { const l = slot(i.owner_dms_user_id); if (!l) continue; if (i.state !== "cleared") l.open_now++; l.false_done += i.false_done_claims || 0; l.holds += i.hold_renewals || 0; }
  }

  const stats = Object.values(pocMap).map(p => ({
    poc_email: p.poc_email,
    poc_name: p.poc_name,
    user_id: p.user_id,
    user_name: userMap[p.user_id] || null,
    distinct_campaigns: p.campaigns.size,
    campaigns_list: [...p.campaigns].join(", "),
    total_outreaches: p.total_outreaches,
    total_followups: p.total_followups,
    reply_rate_pct: p.total_outreaches > 0 ? Math.round((p.reply_count / p.total_outreaches) * 100) : 0,
    avg_response_hours: p.response_times_hours.length > 0
      ? Math.round(p.response_times_hours.reduce((a, b) => a + b, 0) / p.response_times_hours.length * 10) / 10
      : null,
    last_contacted: p.last_contacted,
    resolved_count: p.statuses.filter(s => s === "resolved").length,
    escalated_count: p.statuses.filter(s => s === "escalated").length,
    ...(ledgerByEmail[(p.poc_email || "").toLowerCase()] ? (({ auto_nudges, open_now, false_done, holds }) => ({ auto_nudges, open_now, false_done, holds }))(ledgerByEmail[(p.poc_email || "").toLowerCase()]) : { auto_nudges: 0, open_now: 0, false_done: 0, holds: 0 }),
  }));
  // People who only exist in the ledger (never chased through the old tracker) still get a row.
  const known = new Set(stats.map((x) => (x.poc_email || "").toLowerCase()));
  for (const l of Object.values(ledgerByEmail)) {
    if (known.has(l.email.toLowerCase()) || (!l.auto_nudges && !l.open_now)) continue;
    stats.push({ poc_email: l.email, poc_name: l.name, user_id: null, user_name: null, distinct_campaigns: 0, campaigns_list: "", total_outreaches: 0, total_followups: 0, reply_rate_pct: null, avg_response_hours: null, last_contacted: null, resolved_count: 0, escalated_count: 0, auto_nudges: l.auto_nudges, open_now: l.open_now, false_done: l.false_done, holds: l.holds });
  }
  stats.sort((a, b) => (b.total_outreaches + b.auto_nudges) - (a.total_outreaches + a.auto_nudges));

  // XLSX export
  if (format === "xlsx") {
    const rows = [
      ["POC Name", "Email", "Campaigns", "Total Outreaches", "Total Follow-ups", "Automated/Send-now Nudges", "Open Now", "False Done Claims", "Reply Rate %", "Avg Response (hrs)", "Resolved", "Escalated", "Last Contacted"],
      ...stats.map(s => [
        s.poc_name, s.poc_email, s.campaigns_list,
        s.total_outreaches, s.total_followups, s.auto_nudges, s.open_now, s.false_done,
        s.reply_rate_pct, s.avg_response_hours ?? "",
        s.resolved_count, s.escalated_count,
        s.last_contacted ? new Date(s.last_contacted).toLocaleDateString() : "",
      ])
    ];

    // Build CSV (browser will handle download)
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    return new Response(csv, {
      headers: {
        "content-type": "text/csv",
        "content-disposition": `attachment; filename="frequency-tracker-${new Date().toISOString().slice(0,10)}.csv"`,
      }
    });
  }

  // ── Per-category aggregation (§5) ─────────────────────────────────────────
  const catMap = {};
  for (const r of (records || [])) {
    const cat = r.category || "UNTAGGED";
    if (!catMap[cat]) catMap[cat] = { category: cat, total: 0, replied: 0, resolved: 0, open: 0, response_times_hours: [] };
    const cm = catMap[cat];
    cm.total++;
    if (r.replied_at) {
      cm.replied++;
      if (r.reached_out_at) {
        const hrs = (new Date(r.replied_at) - new Date(r.reached_out_at)) / 3600000;
        if (hrs > 0) cm.response_times_hours.push(hrs);
      }
    }
    if (r.status === "resolved") cm.resolved++;
    else if (!["escalated"].includes(r.status)) cm.open++;
  }
  const byCategory = Object.values(catMap).map(cm => ({
    category: cm.category,
    total: cm.total,
    open: cm.open,
    resolved: cm.resolved,
    reply_rate_pct: cm.total > 0 ? Math.round((cm.replied / cm.total) * 100) : 0,
    avg_response_hours: cm.response_times_hours.length
      ? Math.round(cm.response_times_hours.reduce((a, b) => a + b, 0) / cm.response_times_hours.length * 10) / 10
      : null,
  })).sort((a, b) => b.total - a.total);

  return Response.json({ stats, userMap, byCategory, ledgerCategories });
}
