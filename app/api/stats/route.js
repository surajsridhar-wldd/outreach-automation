import { requireUser, unauthorized } from "@/lib/session";
import { db } from "@/lib/supabase";

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
  })).sort((a, b) => b.total_outreaches - a.total_outreaches);

  // XLSX export
  if (format === "xlsx") {
    const rows = [
      ["POC Name", "Email", "Campaigns", "Total Outreaches", "Total Follow-ups", "Reply Rate %", "Avg Response (hrs)", "Resolved", "Escalated", "Last Contacted"],
      ...stats.map(s => [
        s.poc_name, s.poc_email, s.campaigns_list,
        s.total_outreaches, s.total_followups,
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

  return Response.json({ stats, userMap });
}
