"use client";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { SC, DaysChip, days, CategoryChip, BulkBar, catColor } from "@/components/shared";
import { tabOf, labelOf, describeIssue, statusOf, holdInfo, fmtDay } from "@/lib/ledger.mjs";

// One tracker for everything. Issues the DMS check finds and issues you add by hand sit in the same list, follow the same
// nudge schedule and collect replies the same way. Same tabs, colours and row layout as before.

const TABS = [
  { id: "outreach", label: "Outreach", help: "Issues you added by hand that have not been sent yet. Send them whenever you like, on any day." },
  { id: "inflight", label: "In Flight", help: "Everything open and being followed up, whether the DMS check found it or you added it. Follow-ups go out on their own; you can also nudge any of them now." },
  { id: "review", label: "Review", help: "Things that need a person: replies the system was not sure about, issues with no owner, unclear cases." },
  { id: "snoozed", label: "Snoozed", help: "Paused until a date. Nothing goes out for these until the day after. Replies asking for time land here automatically." },
  { id: "resolved", label: "Resolved", help: "Closed by DMS (it stopped flagging them) or by you. Last 60 days." },
  { id: "excluded", label: "Excluded", help: "Zero-cost-service cases that are never nudged: the ones you excluded, and the ones DMS notes say the internal team handled. Undo any of them here." },
];
const KIND = {
  needs_owner: "Needs owner", low_confidence: "Please check", ambiguous_redirect: "Who is the new owner?", ladder_exhausted: "Five nudges, no result",
  false_done_twice: "Said done twice, still pending", dispute: "Disputes an item", question: "Asked a question", blocked: "Blocked",
  manager_missing: "No manager on file", send_failed: "Send problem", sync_guard: "Suspicious DMS read",
};
const INTENT = { done_claimed: "said it is done", promise_with_date: "promised a date", acknowledged: "acknowledged", hold: "asked for time", waiting_on: "waiting on someone", redirect: "handed it over", loop_in: "looped someone in", blocked: "is blocked", question: "asked a question", dispute: "disputes it", noise: "no answer", other: "replied" };
const when = (t) => (t ? new Date(t).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
const dmy = (t) => (t ? new Date(t).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" }) : "");
const addDaysIso = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const monthEnd = (d) => { const x = new Date(`${d}T00:00:00Z`); return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); };

const STAT_LABEL = { draft: "Not sent yet", new: "Not nudged yet", nudged: "Nudged once", followup: "Follow-ups sent", escalated: "Manager copied", exhausted: "Ladder finished", replied: "Replied", saiddone: "Said done, still pending", noowner: "No owner", snoozed: "Snoozed", resolved: "Resolved" };
function LBadge({ palette, label }) {
  const c = SC[palette] || SC.pending;
  return (
    <span className="badge" style={{ color: c.color, background: c.bg, border: `1px solid ${c.border}` }}>
      <span className="badge-dot" style={{ background: c.dot }} />{label}
    </span>
  );
}
// The ⋯ menu is drawn on top of the whole page (not inside the table), so it is never hidden behind the next row or clipped by
// the table's own scrolling.
function RowMenu({ items }) {
  const [pos, setPos] = useState(null); const ref = useRef(null);
  useEffect(() => {
    if (!pos) return undefined;
    const close = () => setPos(null);
    window.addEventListener("click", close); window.addEventListener("scroll", close, true); window.addEventListener("resize", close);
    return () => { window.removeEventListener("click", close); window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, [pos]);
  function toggle(e) {
    e.stopPropagation();
    if (pos) return setPos(null);
    const r = ref.current.getBoundingClientRect(); const h = items.length * 38 + 10;
    setPos({ right: Math.max(8, window.innerWidth - r.right), top: r.bottom + h > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4 });
  }
  return (<>
    <button ref={ref} className="btn btn-sm" onClick={toggle} title="More actions">⋯</button>
    {pos && createPortal(
      <div style={{ position: "fixed", top: pos.top, right: pos.right, zIndex: 1000, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,.16)", minWidth: 220, overflow: "hidden" }} onClick={(e) => e.stopPropagation()}>
        {items.map((it, i) => (
          <button key={i} onClick={() => { setPos(null); it.onClick(); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "9px 14px", fontSize: 13, border: "none", background: "none", cursor: "pointer", color: it.danger ? "#dc2626" : "#374151" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "#f3f4f6"; }} onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}>{it.label}</button>
        ))}
      </div>, document.body)}
  </>);
}

function Chk({ checked, onChange }) { return <div style={{ padding: "12px 8px 12px 14px" }}><input type="checkbox" style={{ width: "auto" }} checked={checked} onChange={onChange} /></div>; }
function Cell({ children, gap, onClick, clickable }) { return <div className="row-main" style={{ cursor: clickable ? "pointer" : "default", gap: gap ? 6 : undefined }} onClick={onClick}>{children}</div>; }

export default function Tracker() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState("inflight");
  const [sel, setSel] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [q, setQ] = useState("");
  const [fCat, setFCat] = useState(""); const [fSrc, setFSrc] = useState(""); const [fStatus, setFStatus] = useState(""); const [fCamp, setFCamp] = useState("");
  const [drawer, setDrawer] = useState(null);       // issue id
  const [campDrawer, setCampDrawer] = useState(null); // campaign name
  const [modal, setModal] = useState(null);         // { type, ids, ... }
  const [channel, setChannel] = useState("email");
  const [progress, setProgress] = useState(null);
  const [catPicker, setCatPicker] = useState(false);
  const [imp, setImp] = useState({ text: "", sheet: "", category: "revenue_mismatch", auto: true });
  const [aux, setAux] = useState(null);            // run log, replies, zero-cost decisions (from /api/nudges)
  const [activity, setActivity] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/ledger"); const j = await r.json();
    if (!r.ok) return setErr(j.error || "Could not load");
    setErr(null); setD(j);
  }, []);
  const loadAux = useCallback(async () => { try { const r = await fetch("/api/nudges"); if (r.ok) setAux(await r.json()); } catch {} }, []);
  useEffect(() => { loadAux(); }, [loadAux]);
  useEffect(() => { load(); const f = () => document.visibilityState === "visible" && load(); document.addEventListener("visibilitychange", f); window.addEventListener("focus", load); return () => { document.removeEventListener("visibilitychange", f); window.removeEventListener("focus", load); }; }, [load]);
  useEffect(() => { setSel(new Set()); setFStatus(""); setFCamp(""); }, [tab]);
  const show = (msg, type = "info") => { setToast({ msg, type }); setTimeout(() => setToast(null), 7000); };

  async function post(body, url = "/api/ledger") {
    setBusy(true);
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { show(`⚠ ${j.error || "Something went wrong"}`, "error"); return null; }
      await load(); if (url === "/api/nudges") await loadAux(); return j;
    } finally { setBusy(false); }
  }

  const people = useMemo(() => new Map((d?.people || []).map((p) => [p.dms_user_id, p])), [d]);
  const today = d?.today;
  const categories = useMemo(() => {
    const seen = new Map(); for (const i of d?.issues || []) seen.set(i.category, { tag: i.category, name: labelOf(i.category) });
    for (const c of d?.categories || []) seen.set(c.key, { tag: c.key, name: c.label });
    return [...seen.values()];
  }, [d]);
  const rows = useMemo(() => (d?.issues || []).map((i) => {
    // An unofficial handover: everything DMS says is led by one person is nudged to another. Shown under the new person.
    const to = d.redirects?.[i.owner_dms_user_id] ? people.get(d.redirects[i.owner_dms_user_id]) : null;
    const person = to || people.get(i.owner_dms_user_id);
    const handedOver = to ? people.get(i.owner_dms_user_id)?.name || "the DMS lead" : null;
    return { ...i, person, handedOver, tab: tabOf(i, today), status: statusOf(to ? { ...i, owner_state: "active" } : i, today, d.lastReply?.[i.id]), reply: d.lastReply?.[i.id] };
  }), [d, people, today]);
  const counts = useMemo(() => {
    const c = { outreach: 0, inflight: 0, snoozed: 0, resolved: 0 };
    for (const r of rows) c[r.tab]++;
    // Needs-owner issues have their own section; they are not counted twice.
    c.review = (d?.review || []).filter((r) => r.kind !== "needs_owner").length + rows.filter((r) => r.status.key === "noowner" && r.state !== "cleared").length;
    c.excluded = (aux?.zeroDecisions || []).filter((x) => x.decision === "exclude").length + (aux?.zeroStats?.autoExcluded?.length || 0);
    return c;
  }, [rows, d, aux]);

  // Scorecards: records in flight per category, split into already nudged / yet to nudge.
  const catStats = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      if (r.tab !== "inflight" && r.tab !== "snoozed") continue;
      const c = m.get(r.category) || { cat: r.category, total: 0, nudged: 0, notYet: 0, snoozed: 0 };
      if (r.tab === "snoozed") c.snoozed++; else { c.total++; if ((r.nudge_count || 0) > 0) c.nudged++; else c.notYet++; }
      m.set(r.category, c);
    }
    return [...m.values()].filter((c) => c.total > 0 || c.snoozed > 0).sort((a, b) => b.total - a.total);
  }, [rows]);
  const listTab = tab !== "review" && tab !== "excluded";
  const inTab = rows.filter((r) => r.tab === tab);
  const ql = q.trim().toLowerCase();
  const view = inTab.filter((r) => (!fCat || r.category === fCat) && (!fSrc || r.source === fSrc) && (!fStatus || r.status.key === fStatus) && (!fCamp || r.campaign_name === fCamp)
    && (!ql || [r.campaign_name, describeIssue(r), r.person?.name, r.person?.email, labelOf(r.category)].some((x) => (x || "").toLowerCase().includes(ql))));
  const campaigns = [...new Set(inTab.map((r) => r.campaign_name).filter(Boolean))].sort();
  const statusCounts = {}; for (const r of inTab) statusCounts[r.status.key] = (statusCounts[r.status.key] || 0) + 1;
  const chosen = view.filter((r) => sel.has(r.id));
  const manualChosen = chosen.filter((r) => r.source === "manual");
  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allOn = view.length > 0 && chosen.length === view.length;

  // Sends in small groups of people: each email takes a few seconds on the server, which has a time limit per request.
  async function nudge(items, ch = channel) {
    const byPerson = new Map(); for (const r of items) byPerson.set(r.owner_dms_user_id, [...(byPerson.get(r.owner_dms_user_id) || []), r]);
    const nudgedToday = items.filter((r) => r.last_nudged_at && dmy(r.last_nudged_at) === dmy(new Date())).length;
    if (!confirm(`${ch === "slack" ? "Slack DM" : "Email"} ${byPerson.size} ${byPerson.size === 1 ? "person" : "people"} about ${items.length} item${items.length === 1 ? "" : "s"} now?\n\nIt goes out immediately, whatever the day or time, and counts as a nudge; automatic follow-ups continue from here.${nudgedToday ? `\n\n${nudgedToday} of these were already nudged today.` : ""}`)) return;
    const groups = []; let cur = []; let n = 0;
    for (const [, list] of byPerson) { if (n >= 3) { groups.push(cur); cur = []; n = 0; } cur.push(...list); n++; }
    if (cur.length) groups.push(cur);
    let sent = 0, failed = 0, skipped = 0;
    for (const [k, g] of groups.entries()) {
      setProgress({ done: k * 3, total: byPerson.size, sent, failed });
      const r = await post({ action: "send", ids: g.map((x) => x.id).slice(0, 25), channel: ch });
      if (r) { sent += r.sent || 0; failed += r.failed || 0; skipped += (r.skippedUnreachable || 0) + (r.notSent?.length || 0) + (r.skippedNoEmail || 0); } else failed += g.length;
    }
    setProgress(null); setSel(new Set());
    show(`${failed ? "⚠ " : "✅ "}Sent ${sent}${failed ? `, ${failed} failed` : ""}${skipped ? `, ${skipped} skipped (no owner or bounced address)` : ""}`, failed ? "error" : "info");
  }
  async function resolve(ids) {
    const r = await post({ action: "resolve", ids });
    if (r) { show(`✅ Resolved ${r.resolved}${r.leftToDms ? ` · ${r.leftToDms} found by the DMS check close on their own when DMS stops flagging them (snooze them to pause)` : ""}`); setSel(new Set()); }
  }
  async function checkReplies(ids) {
    show("🔍 Checking replies…");
    const r = await post({ action: "check_replies", ids });
    if (r) show(`🔍 Looked at ${r.threads} conversation${r.threads === 1 ? "" : "s"}: ${r.newReplies} new repl${r.newReplies === 1 ? "y" : "ies"}${r.changes ? `, ${r.changes} change${r.changes === 1 ? "" : "s"} made` : ""}${r.forReview ? `, ${r.forReview} for you to check` : ""}${r.capReached ? " · the monthly reading budget is used up" : ""}`);
  }
  async function doImport() {
    const r = await post({ action: "import", csvText: imp.sheet ? undefined : imp.text, sheetUrl: imp.sheet || undefined, category: imp.category, autoFollowups: imp.auto });
    if (!r) return;
    show(`✅ Added ${r.created}${r.refreshed ? ` · refreshed ${r.refreshed}` : ""}${r.skipped.length ? ` · skipped ${r.skipped.length}: ${r.skipped.slice(0, 3).map((s) => `${s.row.name || s.row.email} (${s.why})`).join("; ")}${r.skipped.length > 3 ? "…" : ""}` : ""}`, r.created === 0 && r.skipped.length ? "error" : "info");
    setImp({ ...imp, text: "", sheet: "" });
  }
  async function togglePause() {
    if (!d.paused && !confirm("Pause all sending? Nothing (automatic or manual) will go out until you resume. The DMS check keeps running.")) return;
    await post({ action: d.paused ? "resume" : "pause" }, "/api/nudges");
  }
  function exportCsv() {
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [["Person", "Email", "Campaign", "Category", "Issue", "Status", "Nudges", "Last nudged", "Source"].map(esc).join(",")];
    for (const r of view) lines.push([r.person?.name, r.person?.email, r.campaign_name, labelOf(r.category), describeIssue(r), r.status.label, r.nudge_count, r.last_nudged_at ? new Date(r.last_nudged_at).toISOString().slice(0, 10) : "", r.source === "manual" ? "Added by you" : "DMS check"].map(esc).join(","));
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" })); a.download = `tracker-${tab}-${today}.csv`; a.click();
  }

  if (err) return <div><div className="page-header"><h1>Tracker</h1><p>{err}</p></div><p style={{ fontSize: 13 }}>The tracker is for admins. <Link href="/tracker-legacy">Open the old tracker</Link>.</p></div>;
  if (!d) return <div className="empty"><h3>Loading…</h3></div>;

  const menu = (r) => [
    { label: "💤 Snooze…", onClick: () => setModal({ type: "snooze", ids: [r.id] }) },
    { label: "↗ Reassign / add co-owner…", onClick: () => setModal({ type: "reassign", ids: [r.id] }) },
    { label: "🔍 Check replies", onClick: () => checkReplies([r.id]) },
    ...(r.source === "manual" ? [{ label: "✏ Edit", onClick: () => setModal({ type: "edit", row: r }) }, { label: r.auto_followups === false ? "🔁 Turn auto follow-ups on" : "⏸ Turn auto follow-ups off", onClick: () => post({ action: "followups", ids: [r.id], on: r.auto_followups === false }) }] : []),
    ...(r.category === "zero_cost_services" ? [{ label: "🚫 Exclude for good", danger: true, onClick: () => confirm("Never nudge this campaign and service again?") && post({ action: "zero_cost_exclude", campaign_id: r.campaign_id, campaign_name: r.campaign_name, service: r.detail?.service }, "/api/nudges") }] : []),
  ];

  const statusStats = tab === "inflight" || tab === "snoozed" ? Object.entries(statusCounts) : [];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, gap: 10, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-.4px" }}>Tracker</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <LBadge palette={d.paused ? "no_reply" : "active"} label={d.paused ? "Automation paused" : `Automation ${d.mode}${d.lastRun ? ` · last run ${when(d.lastRun.at)}` : ""}`} />
          <button className={`btn btn-sm ${d.paused ? "btn-green" : "btn-red"}`} disabled={busy} onClick={togglePause}>{d.paused ? "▶ Resume" : "⏸ Pause"}</button>
          <button className="btn btn-sm" onClick={() => setActivity(true)} title="Recent automatic runs, replies read and emails sent">📋 Run log</button>
          <button className="btn btn-sm" onClick={exportCsv}>⬇ Export CSV</button>
          <button className="btn btn-sm" onClick={load}>↻ Refresh</button>
        </div>
      </div>
      {d.lastRun?.notes?.length > 0 && <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 13, color: "#92400e" }}>⚠ Last run needs attention: {d.lastRun.notes.join(" · ")}</div>}

      <div className="tabs">
        {TABS.map((t) => {
          const cnt = counts[t.id]; const urgent = t.id === "review" && cnt > 0;
          return <button key={t.id} className={`tab-btn ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>{t.label}{cnt > 0 && <span className="tab-count" style={urgent ? { background: "#f59e0b", color: "#fff" } : {}}>{cnt}</span>}</button>;
        })}
      </div>
      <p style={{ fontSize: 12, color: "#9ca3af", marginBottom: 12 }}>{TABS.find((t) => t.id === tab).help}</p>

      {listTab && (
        <div style={{ marginBottom: 16 }}><input placeholder="🔍 Search by person, campaign, email, category or issue…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 440 }} /></div>
      )}

      {tab === "outreach" && (
        <div className="import-box" style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Add issues</div>
            <button className="btn btn-sm" onClick={() => setModal({ type: "reconcile" })} title="Reconcile a category against a complete list: resolves what is no longer on it">🔄 Reconcile a category</button>
          </div>
          <div className="example-box">{"Campaign\tPOC Name\tEmail\tIssue\tCategory (optional)\nXiaomi Plan 3\tPriya Sharma\tpriya@wldd.in\tThe value on DMS differs from Finance (498,000). Please check and edit.\tRevenue mismatch"}</div>
          <p style={{ fontSize: 11, color: "#9ca3af", marginBottom: 10 }}>The issue text is exactly what the person sees. Invoices, creator links, screenshots, closings, proposals and zero-cost services are found by the DMS check and added on their own. Re-adding something already in flight does nothing.</p>
          <input placeholder="Google Sheet URL (optional)" value={imp.sheet} onChange={(e) => setImp({ ...imp, sheet: e.target.value })} style={{ marginBottom: 8 }} />
          <textarea rows={4} placeholder="Or paste a tab-separated / CSV table…" value={imp.text} onChange={(e) => setImp({ ...imp, text: e.target.value })} style={{ resize: "vertical", marginBottom: 10 }} />
          <div className="form-row">
            <label style={{ fontSize: 12, color: "#6b7280" }}>Category when no column&nbsp;
              <select style={{ width: 200, display: "inline-block" }} value={imp.category} onChange={(e) => setImp({ ...imp, category: e.target.value })}>{d.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
            <label style={{ fontSize: 12, color: "#6b7280", display: "flex", alignItems: "center", gap: 6 }}><input type="checkbox" style={{ width: "auto" }} checked={imp.auto} onChange={(e) => setImp({ ...imp, auto: e.target.checked })} />Follow up automatically after the first send</label>
            <button className="btn btn-primary" disabled={busy || !(imp.text.trim() || imp.sheet.trim())} onClick={doImport}>{busy ? "Adding…" : "Add →"}</button>
          </div>
        </div>
      )}

      {tab === "inflight" && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 12, padding: "8px 12px", background: "#f8f9fb", border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 12, color: "#6b7280" }}>
          <span style={{ fontWeight: 600, color: "#374151" }}>Buttons:</span>
          <span>🔁 Nudge now</span><span style={{ color: "#d1d5db" }}>·</span><span>🔍 Check replies</span><span style={{ color: "#d1d5db" }}>·</span><span>✓ Resolve (yours only)</span><span style={{ color: "#d1d5db" }}>·</span><span>Details: history and replies</span><span style={{ color: "#d1d5db" }}>·</span><span>⋯ Snooze · Reassign · Edit · Exclude</span>
        </div>
      )}

      {tab === "inflight" && catStats.length > 0 && (<>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", letterSpacing: ".8px", margin: "2px 0 8px" }}>IN FLIGHT BY CATEGORY</div>
        <div className="stat-grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(190px,1fr))", marginBottom: 14 }}>
          {catStats.map((c) => {
            const col = catColor(c.cat);
            return (
              <div key={c.cat} className="stat-card" style={{ borderColor: fCat === c.cat ? col : undefined, background: fCat === c.cat ? `${col}0d` : undefined }} onClick={() => setFCat(fCat === c.cat ? "" : c.cat)}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}><div className="stat-num" style={{ color: col }}>{c.total}</div><div style={{ fontSize: 11, color: "#6b7280" }}>({c.nudged} nudged · {c.notYet} yet to nudge{c.snoozed ? ` · ${c.snoozed} snoozed` : ""})</div></div>
                <div className="stat-label">{labelOf(c.cat)}</div>
              </div>
            );
          })}
        </div>
        {statusStats.length > 1 && <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", letterSpacing: ".8px", margin: "2px 0 8px" }}>BY STATUS</div>}
      </>)}
      {statusStats.length > 1 && (
        <div className="stat-grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))" }}>
          {statusStats.sort((a, b) => b[1] - a[1]).map(([k, n]) => {
            const s = inTab.find((r) => r.status.key === k).status; const c = SC[s.palette] || SC.pending;
            return (
              <div key={k} className="stat-card" style={{ borderColor: fStatus === k ? c.dot : undefined }} onClick={() => setFStatus(fStatus === k ? "" : k)}>
                <div className="stat-num" style={{ color: c.color }}>{n}</div>
                <div className="stat-label">{STAT_LABEL[k] || s.label}</div>
              </div>
            );
          })}
        </div>
      )}

      {listTab && (
        <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
          <select value={fCat} onChange={(e) => setFCat(e.target.value)} style={{ width: "auto", minWidth: 160 }}><option value="">All categories</option>{categories.map((c) => <option key={c.tag} value={c.tag}>{c.name}</option>)}</select>
          <select value={fSrc} onChange={(e) => setFSrc(e.target.value)} style={{ width: "auto", minWidth: 170 }}><option value="">DMS check + added by me</option><option value="mongo">Found by the DMS check</option><option value="manual">Added by me</option></select>
          {campaigns.length > 0 && <select value={fCamp} onChange={(e) => setFCamp(e.target.value)} style={{ width: "auto", minWidth: 160, maxWidth: 260 }}><option value="">All campaigns</option>{campaigns.map((c) => <option key={c} value={c}>{c}</option>)}</select>}
          {(fCat || fSrc || fStatus || fCamp) && <button className="btn btn-sm" onClick={() => { setFCat(""); setFSrc(""); setFStatus(""); setFCamp(""); }}>✕ Clear</button>}
          <span style={{ marginLeft: "auto", fontSize: 12, color: "#9ca3af" }}>{view.length} issues</span>
        </div>
      )}

      {listTab && view.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 13, fontWeight: 500 }}>
            <input type="checkbox" style={{ width: "auto" }} checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(view.map((r) => r.id)))} />
            {chosen.length > 0 ? `${chosen.length} selected` : `Select all (${view.length})`}
          </label>
        </div>
      )}

      {listTab && (
        <BulkBar selected={chosen.length}>
          {tab !== "resolved" && <div className="channel-toggle">
            <button className={`ch-btn ${channel === "email" ? "active" : ""}`} onClick={() => setChannel("email")}>📧 Email</button>
            <button className={`ch-btn ${channel === "slack" ? "active" : ""}`} onClick={() => setChannel("slack")}>💬 Slack</button>
          </div>}
          {tab !== "resolved" && <button className={`btn btn-sm ${tab === "outreach" ? "btn-primary" : "btn-orange"}`} disabled={busy} onClick={() => nudge(chosen)}>{tab === "outreach" ? `Send ${chosen.length}` : `🔁 Nudge now (${chosen.length})`}</button>}
          {["inflight", "snoozed"].includes(tab) && <button className="btn btn-green btn-sm" disabled={busy} onClick={() => checkReplies(chosen.map((r) => r.id))}>🔍 Check replies</button>}
          {tab === "inflight" && <button className="btn btn-sm" style={{ background: "#ecfeff", color: "#0e7490", border: "1px solid #a5f3fc" }} onClick={() => setModal({ type: "snooze", ids: chosen.map((r) => r.id) })}>💤 Snooze</button>}
          {tab === "snoozed" && <button className="btn btn-sm" onClick={() => post({ action: "unsnooze", ids: chosen.map((r) => r.id) })}>Wake up now</button>}
          {["outreach", "inflight", "snoozed"].includes(tab) && <button className="btn btn-purple btn-sm" disabled={busy || !manualChosen.length} title="Only issues you added yourself. DMS closes the ones it finds." onClick={() => resolve(manualChosen.map((r) => r.id))}>✓ Resolve ({manualChosen.length})</button>}
          {tab !== "resolved" && <button className="btn btn-sm" style={{ background: "rgba(255,255,255,.1)", color: "rgba(255,255,255,.85)", border: "1px solid rgba(255,255,255,.2)" }} onClick={() => setModal({ type: "reassign", ids: chosen.map((r) => r.id) })}>↗ Reassign</button>}
          {manualChosen.length > 0 && tab !== "resolved" && (
            <span style={{ position: "relative" }}>
              <button className="btn btn-sm" onClick={() => setCatPicker((o) => !o)}>🏷️ Set category</button>
              {catPicker && (
                <div style={{ position: "absolute", top: "100%", left: 0, marginTop: 4, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,.1)", zIndex: 50, minWidth: 220, padding: 6 }}>
                  {d.categories.map((c) => <button key={c.key} onClick={async () => { setCatPicker(false); const r = await post({ action: "set_category", ids: manualChosen.map((x) => x.id), category: c.key }); if (r) { show(`🏷️ Tagged ${manualChosen.length} as “${c.label}”`); setSel(new Set()); } }} style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", fontSize: 13, border: "none", background: "none", cursor: "pointer", borderRadius: 6, color: "#111827" }}>{c.label}</button>)}
                </div>
              )}
            </span>
          )}
          {tab === "outreach" && <button className="btn btn-red btn-sm" style={{ marginLeft: "auto" }} onClick={() => confirm(`Discard ${chosen.length} draft(s)?`) && post({ action: "discard", ids: chosen.map((r) => r.id) })}>🗑 Discard</button>}
          {tab === "resolved" && <button className="btn btn-sm" onClick={() => post({ action: "reopen", ids: manualChosen.map((r) => r.id) })} disabled={!manualChosen.length}>↩ Reopen (yours)</button>}
        </BulkBar>
      )}

      {tab === "excluded" ? <ExcludedTab aux={aux} busy={busy} post={post} /> : tab === "review" ? <ReviewTab d={d} rows={rows} busy={busy} post={post} setDrawer={setDrawer} setCampDrawer={setCampDrawer} categories={categories} /> : view.length === 0 ? (
        <div className="empty"><div className="empty-icon">{tab === "outreach" ? "📋" : tab === "snoozed" ? "💤" : tab === "resolved" ? "✅" : "📬"}</div><h3>{fStatus || fCat || fSrc || fCamp || ql ? "Nothing matches these filters" : tab === "outreach" ? "Nothing waiting to be sent" : tab === "snoozed" ? "Nothing snoozed" : tab === "resolved" ? "Nothing resolved yet" : "Nothing in flight"}</h3><p>{tab === "outreach" ? "Paste issues above. Once sent they move to In Flight." : ""}</p></div>
      ) : (
        <div><p className="scroll-hint">← swipe the table sideways to see every column →</p><div className="tbl-wrap">
          <table>
            <thead><tr><th style={{ width: 32 }}></th><th style={{ minWidth: 150 }}>POC</th><th>CAMPAIGN</th><th>ISSUE</th>{tab === "snoozed" ? <><th>WHY IT IS SNOOZED</th><th>NUDGING RESUMES</th></> : <th>STATUS</th>}{tab !== "outreach" && <th>{tab === "resolved" ? "CLOSED · NUDGES" : "NUDGES · LAST"}</th>}<th style={{ position: "sticky", right: 0, background: "var(--bg)", zIndex: 1 }}>ACTIONS</th></tr></thead>
            <tbody>
              {view.map((r) => (
                <tr key={r.id}>
                  <td><Chk checked={sel.has(r.id)} onChange={() => toggle(r.id)} /></td>
                  <td><Cell onClick={() => setDrawer(r.id)} clickable><div className="poc-block"><div className="poc-name">{r.person?.name || <span style={{ color: "#dc2626" }}>No owner</span>}</div><div className="poc-email">{r.person?.email || "—"}</div>{r.source === "manual" && <div style={{ fontSize: 10, color: "#7c3aed", marginTop: 2 }}>added by you</div>}{r.handedOver && <div style={{ fontSize: 10, color: "#0e7490", marginTop: 2 }}>handled for {r.handedOver}</div>}</div></Cell></td>
                  <td><Cell>{r.campaign_name ? <span className="campaign-pill" onClick={() => setCampDrawer(r.campaign_name)}>{r.campaign_name} ↗</span> : "—"}<div><CategoryChip category={r.category} categories={categories} /></div></Cell></td>
                  <td><Cell><div className="issue-text" style={{ minWidth: 200, maxWidth: 380 }}>{describeIssue(r)}</div></Cell></td>
                  {tab === "snoozed" ? (<>
                    <td><Cell><div>{(() => { const h = holdInfo(r); return h ? (<><LBadge palette="snoozed" label={h.by === "you" ? "Snoozed by you" : h.by === "their reply" ? "From their reply" : "Snoozed"} /><div style={{ fontSize: 12, color: "#374151", marginTop: 5, lineHeight: 1.45, maxWidth: 300 }}>{h.why}</div></>) : null; })()}</div></Cell></td>
                    <td><Cell><div><div style={{ fontSize: 13, fontWeight: 600 }}>{fmtDay(holdInfo(r)?.resumes)}</div><div style={{ fontSize: 11, color: "#9ca3af" }}>paused through {fmtDay(r.hold_until)}</div></div></Cell></td>
                  </>) : (
                  <td><Cell><div><LBadge palette={r.status.palette} label={r.status.label} />
                    {r.reply && r.status.key === "replied" && <div style={{ fontSize: 11, color: "#6b7280", marginTop: 4, fontStyle: "italic" }}>{INTENT[r.reply.intent] || "replied"}{r.reply.promised_date ? ` (${r.reply.promised_date})` : ""}: “{(r.reply.evidence || "").slice(0, 60)}”</div>}
                    {r.auto_followups === false && r.state === "open" && <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 3 }}>no automatic follow-ups</div>}</div></Cell></td>)}
                  {tab !== "outreach" && <td><Cell><div><span style={{ fontSize: 14, fontWeight: 700, color: r.nudge_count >= 4 ? "#dc2626" : r.nudge_count >= 2 ? "#d97706" : r.nudge_count ? "#2563eb" : "#9ca3af" }}>{r.nudge_count || 0}</span><span style={{ fontSize: 11, color: "#9ca3af" }}> nudge{r.nudge_count === 1 ? "" : "s"}</span><div><DaysChip d={days(tab === "resolved" ? r.cleared_at : r.last_nudged_at)} /></div></div></Cell></td>}
                  <td style={{ position: "sticky", right: 0, background: "#fff", boxShadow: "-8px 0 8px -8px rgba(0,0,0,.12)" }}><Cell gap>
                    {tab !== "resolved" && <button className={`btn btn-sm ${tab === "outreach" ? "btn-primary" : "btn-orange"}`} disabled={busy} onClick={() => nudge([r])} title="Send a nudge to the owner right now">{tab === "outreach" ? "Send" : "🔁"}</button>}
                    {tab !== "resolved" && r.source === "manual" && <button className="btn btn-purple btn-sm" onClick={() => resolve([r.id])} title="Mark resolved">✓</button>}
                    {tab === "resolved" && r.source === "manual" && <button className="btn btn-sm" onClick={() => post({ action: "reopen", ids: [r.id] })}>↩ Reopen</button>}
                    <button className="btn btn-sm" style={{ color: "#6b7280" }} onClick={() => setDrawer(r.id)}>Details</button>
                    {tab !== "resolved" && <RowMenu items={menu(r)} />}
                  </Cell></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></div>
      )}
      <p style={{ marginTop: 18, fontSize: 12, color: "#9ca3af" }}><Link href="/tracker-legacy">Open the old tracker</Link> · the automation's run log is the 📋 button at the top right</p>

      {modal?.type === "snooze" && <SnoozeModal today={today} count={modal.ids.length} onClose={() => setModal(null)} onPick={async (until, note) => { const r = await post({ action: "snooze", ids: modal.ids, until, reason: note || undefined }); if (r) { show(`💤 Snoozed until ${until}`); setModal(null); setSel(new Set()); } }} />}
      {modal?.type === "reassign" && <ReassignModal count={modal.ids.length} busy={busy} onClose={() => setModal(null)} onDone={async (email, mode) => { let ok = true; for (const id of modal.ids) { const r = await post({ action: "reassign", ids: [id], email, mode }); if (!r) { ok = false; break; } } if (ok) { show("↗ Done"); setModal(null); setSel(new Set()); } }} />}
      {modal?.type === "edit" && <EditModal row={modal.row} categories={d.categories} busy={busy} onClose={() => setModal(null)} onSave={async (patch) => { const r = await post({ action: "edit", ids: [modal.row.id], ...patch }); if (r) { show("✅ Saved"); setModal(null); } }} />}
      {modal?.type === "reconcile" && <ReconcileModal categories={d.categories} onClose={() => setModal(null)} post={post} onDone={(msg) => { show(msg); setModal(null); }} />}
      {progress && <div className="modal-overlay"><div className="progress-modal"><h3 style={{ fontSize: 16, fontWeight: 700 }}>Sending…</h3><p style={{ fontSize: 13, color: "#6b7280", margin: "6px 0" }}>{Math.min(progress.done, progress.total)} of {progress.total} people</p><div className="progress-bar-track"><div className="progress-bar-fill" style={{ width: `${(progress.done / progress.total) * 100}%`, background: "#2563eb" }} /></div><p style={{ fontSize: 12, color: "#9ca3af" }}>Sent {progress.sent}{progress.failed ? ` · ${progress.failed} failed` : ""}. Please keep this page open.</p></div></div>}
      {activity && <ActivityDrawer aux={aux} onClose={() => setActivity(false)} />}
      {drawer && <Drawer id={drawer} row={rows.find((r) => r.id === drawer)} categories={categories} today={today} onClose={() => setDrawer(null)} post={post} busy={busy} nudge={nudge} reload={load} openCampaign={(c) => { setDrawer(null); setCampDrawer(c); }} />}
      {campDrawer && <CampaignDrawer name={campDrawer} rows={rows.filter((r) => r.campaign_name === campDrawer)} categories={categories} onClose={() => setCampDrawer(null)} open={(id) => { setCampDrawer(null); setDrawer(id); }} />}
      {toast && <div className="toast" style={{ background: toast.type === "error" ? "#dc2626" : "#1e293b" }}>{toast.msg}</div>}
    </div>
  );
}

function ExcludedTab({ aux, busy, post }) {
  if (!aux) return <div className="empty"><h3>Loading…</h3></div>;
  const mine = (aux.zeroDecisions || []).filter((x) => x.decision === "exclude");
  const forced = (aux.zeroDecisions || []).filter((x) => x.decision === "nudge");
  const auto = aux.zeroStats?.autoExcluded || [];
  return (<>
    <h3 style={{ margin: "4px 0 8px", fontSize: 15 }}>Excluded by you ({mine.length})</h3>
    <p style={{ fontSize: 12, color: "#9ca3af", marginBottom: 8 }}>Never nudged. If the DMS note on one of these changes later, it comes back to Review (not straight to a nudge) so nothing hides a real recurrence.</p>
    <div style={{ marginBottom: 22 }}><div className="tbl-wrap"><table><thead><tr><th>CAMPAIGN</th><th>SERVICE</th><th>EXCLUDED</th><th></th></tr></thead><tbody>
      {mine.map((x) => <tr key={x.id}><td><Cell><b style={{ fontSize: 13 }}>{x.campaign_name}</b></Cell></td><td><Cell>{x.service}</Cell></td><td><Cell><span style={{ fontSize: 12, color: "#6b7280" }}>{when(x.decided_at)}{x.reason ? ` · ${x.reason}` : ""}</span></Cell></td><td><Cell><button className="btn btn-sm" disabled={busy} onClick={() => post({ action: "zero_cost_undo", id: x.id }, "/api/nudges")}>↩ Undo</button></Cell></td></tr>)}
      {!mine.length && <tr><td colSpan={4}><Cell><span style={{ color: "#9ca3af" }}>None yet.</span></Cell></td></tr>}
    </tbody></table></div></div>
    {forced.length > 0 && (<><h3 style={{ margin: "4px 0 8px", fontSize: 15 }}>Always nudged, even though the note mentions AI or Chiraiya ({forced.length})</h3>
      <div style={{ marginBottom: 22 }}><div className="tbl-wrap"><table><thead><tr><th>CAMPAIGN</th><th>SERVICE</th><th></th></tr></thead><tbody>
        {forced.map((x) => <tr key={x.id}><td><Cell><b style={{ fontSize: 13 }}>{x.campaign_name}</b></Cell></td><td><Cell>{x.service}</Cell></td><td><Cell><button className="btn btn-sm" disabled={busy} onClick={() => post({ action: "zero_cost_undo", id: x.id }, "/api/nudges")}>↩ Undo</button></Cell></td></tr>)}
      </tbody></table></div></div></>)}
    <h3 style={{ margin: "4px 0 8px", fontSize: 15 }}>Excluded automatically ({auto.length})</h3>
    <p style={{ fontSize: 12, color: "#9ca3af", marginBottom: 8 }}>The internal note in DMS clearly says our own team did the work, so there is nothing to map. These fixed rules cost nothing to run and are re-checked on every DMS check.</p>
    <div className="tbl-wrap"><table><thead><tr><th>CAMPAIGN</th><th>SERVICE</th><th>NOTE IN DMS</th></tr></thead><tbody>
      {auto.map((x, i) => <tr key={i}><td><Cell><b style={{ fontSize: 13 }}>{x.campaign_name}</b></Cell></td><td><Cell>{x.service}</Cell></td><td><Cell><span className="issue-text">{x.note}</span></Cell></td></tr>)}
      {!auto.length && <tr><td colSpan={3}><Cell><span style={{ color: "#9ca3af" }}>None at the last check.</span></Cell></td></tr>}
    </tbody></table></div>
  </>);
}

function ActivityDrawer({ aux, onClose }) {
  const [t, setT] = useState("runs");
  const runs = aux?.runs || []; const replies = aux?.replies || []; const msgs = aux?.messages || [];
  return (<>
    <div className="drawer-overlay" onClick={onClose} />
    <div className="drawer" style={{ width: 640 }}>
      <div className="drawer-header"><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div><div className="poc-name" style={{ fontSize: 15 }}>Run log</div><div className="poc-email">What the automation did recently. Per-issue history is in each issue's Details.</div></div><button className="btn btn-sm" onClick={onClose}>✕</button></div>
        <div className="tabs" style={{ marginTop: 12, marginBottom: 0 }}>{[["runs", `Runs (${runs.length})`], ["sent", `Sent (${msgs.length})`], ["replies", `Replies read (${replies.length})`]].map(([k, l]) => <button key={k} className={`tab-btn ${t === k ? "active" : ""}`} onClick={() => setT(k)}>{l}</button>)}</div></div>
      <div className="drawer-body">
        {!aux ? <p style={{ color: "#9ca3af" }}>Loading…</p> : t === "runs" ? (
          runs.map((r) => (
            <div key={r.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, marginBottom: 10 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}><LBadge palette={r.ok === false ? "no_reply" : r.ok ? "active" : "sent"} label={r.ok === false ? "Failed" : r.ok ? "OK" : "Running"} /><b style={{ fontSize: 13 }}>{when(r.started_at)}</b><span style={{ fontSize: 12, color: "#6b7280" }}>{r.mode}</span></div>
              <div style={{ fontSize: 12, color: "#374151" }}>Sent <b>{r.stats?.sent ?? 0}</b> of {r.stats?.planned ?? 0} planned · closed by DMS {r.stats?.cleared ?? 0} · new {r.stats?.inserted ?? 0}{r.stats?.skipped ? ` · skipped: ${r.stats.skipped}` : ""}{r.stats?.replyStats && !r.stats.replyStats.skipped ? ` · replies: ${r.stats.replyStats.newMessages ?? 0} new, cost $${(r.stats.replyStats.cost || 0).toFixed(3)}` : ""}</div>
              {(r.stats?.notes || []).length > 0 && <div style={{ fontSize: 12, color: "#92400e", marginTop: 4 }}>⚠ {r.stats.notes.join(" · ")}</div>}{r.error && <div style={{ fontSize: 12, color: "#dc2626", marginTop: 4 }}>{r.error}</div>}
            </div>))
        ) : t === "sent" ? (
          <div className="tbl-wrap"><table><thead><tr><th>WHEN</th><th>TO</th><th>KIND</th><th>STATUS</th></tr></thead><tbody>{msgs.map((m) => <tr key={m.id}><td><Cell><span style={{ fontSize: 12 }}>{when(m.sent_at || m.created_at)}</span></Cell></td><td><Cell><div className="poc-block"><div className="poc-name">{m.recipient_name || m.to_address}</div>{m.intended_to && <div className="poc-email">rehearsal for {m.intended_to}</div>}</div></Cell></td><td><Cell>{m.channel} · {m.kind}</Cell></td><td><Cell>{m.status}{m.mode !== "live" ? ` (${m.mode})` : ""}</Cell></td></tr>)}</tbody></table></div>
        ) : (
          <div className="tbl-wrap"><table><thead><tr><th>RECEIVED</th><th>FROM</th><th>READ AS</th><th>WHAT THEY SAID</th></tr></thead><tbody>{replies.map((r) => <tr key={r.id}><td><Cell><span style={{ fontSize: 12 }}>{when(r.messages_in?.received_at)}</span></Cell></td><td><Cell><span style={{ fontSize: 12 }}>{r.messages_in?.sender_address}</span></Cell></td><td><Cell><div><b style={{ fontSize: 12 }}>{INTENT[r.intent] || r.intent}</b>{r.promised_date ? <div style={{ fontSize: 11, color: "#6b7280" }}>{r.promised_date}</div> : null}</div></Cell></td><td><Cell><span className="issue-text">{r.evidence}</span></Cell></td></tr>)}</tbody></table></div>
        )}
      </div>
    </div>
  </>);
}

function ReviewTab({ d, rows, busy, post, setDrawer, setCampDrawer, categories }) {
  const noOwner = rows.filter((r) => r.state !== "cleared" && r.status.key === "noowner");
  const toCheck = d.review.filter((r) => r.kind !== "needs_owner");   // needs-owner has its own section above
  const [owner, setOwner] = useState({});
  return (<>
    {noOwner.length > 0 && (<>
      <h3 style={{ margin: "4px 0 10px", fontSize: 15 }}>Needs an owner ({noOwner.length})</h3>
      <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "#991b1b" }}>⚠ {noOwner.length} issue{noOwner.length === 1 ? " has" : "s have"} no owner: the campaign lead in DMS is deleted or missing. Nobody is nudged until you assign someone (or DMS gets a new lead).</div>
      <div className="tbl-wrap" style={{ marginBottom: 22 }}><table><thead><tr><th>CAMPAIGN</th><th>ISSUE</th><th>ASSIGN TO (EMAIL) OR EXCLUDE</th></tr></thead><tbody>
        {noOwner.map((i) => (<tr key={i.id}>
          <td><Cell><span className="campaign-pill" onClick={() => setCampDrawer(i.campaign_name)}>{i.campaign_name} ↗</span><div><CategoryChip category={i.category} categories={categories} /></div></Cell></td>
          <td><Cell><div className="issue-text">{describeIssue(i)}</div></Cell></td>
          <td><Cell gap><input style={{ maxWidth: 220 }} placeholder="name@wldd.in" value={owner[i.id] || ""} onChange={(e) => setOwner({ ...owner, [i.id]: e.target.value })} /><button className="btn btn-primary btn-sm" disabled={busy || !owner[i.id]} onClick={() => post({ action: "reassign", ids: [i.id], email: owner[i.id], mode: "reassign" })}>Assign</button>
            {i.category === "zero_cost_services" && <button className="btn btn-red btn-sm" disabled={busy} title="Never nudge this campaign and service, no owner needed" onClick={() => confirm(`Exclude ${i.campaign_name} (${i.detail?.service || "service"}) for good? It will never be nudged.`) && post({ action: "zero_cost_exclude", campaign_id: i.campaign_id, campaign_name: i.campaign_name, service: i.detail?.service }, "/api/nudges")}>🚫 Exclude for good</button>}</Cell></td>
        </tr>))}
      </tbody></table></div></>)}
    <h3 style={{ margin: "4px 0 10px", fontSize: 15 }}>To check ({toCheck.length})</h3>
    {toCheck.length === 0 ? <div className="empty" style={{ padding: 30 }}><div className="empty-icon">✨</div><h3>Nothing to check</h3><p>Every reply was clear enough to act on automatically.</p></div> : toCheck.map((r) => (
      <div key={r.id} style={{ background: "#fff", border: "1px solid #fde68a", borderLeft: "4px solid #f59e0b", borderRadius: 10, padding: 16, marginBottom: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
              <LBadge palette="needs_review" label={KIND[r.kind] || r.kind} />
              {(r.issues?.campaign_name || r.payload?.campaign_name) && <span className="campaign-pill" onClick={() => r.issue_id ? setDrawer(r.issue_id) : setCampDrawer(r.payload.campaign_name)}>{r.issues?.campaign_name || r.payload.campaign_name} ↗</span>}
              <span style={{ fontSize: 11, color: "#9ca3af" }}>{when(r.created_at)}</span>
            </div>
            <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.5 }}>{r.note}</div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {r.payload?.type === "zero_cost" && <>
              <button className="btn btn-red btn-sm" disabled={busy} title="Never nudge this campaign and service" onClick={() => post({ action: "zero_cost_decide", reviewId: r.id, decision: "exclude" }, "/api/nudges")}>🚫 Exclude for good</button>
              <button className="btn btn-orange btn-sm" disabled={busy} title="Always nudge it" onClick={() => post({ action: "zero_cost_decide", reviewId: r.id, decision: "nudge" }, "/api/nudges")}>🔁 Nudge this</button></>}
            {r.issue_id && <button className="btn btn-sm" onClick={() => setDrawer(r.issue_id)}>Details</button>}
            <button className="btn btn-purple btn-sm" disabled={busy} onClick={() => post({ action: "resolve_review", id: r.id }, "/api/nudges")}>✓ Mark done</button>
          </div>
        </div>
      </div>))}
  </>);
}

function SnoozeModal({ today, count, onClose, onPick }) {
  const [date, setDate] = useState(addDaysIso(today, 7)); const [note, setNote] = useState("");
  const presets = [["3 days", addDaysIso(today, 3)], ["1 week", addDaysIso(today, 7)], ["2 weeks", addDaysIso(today, 14)], ["End of month", monthEnd(today)]];
  return (
    <div className="modal-overlay"><div className="modal">
      <h3>Snooze {count > 1 ? `${count} issues` : "issue"}</h3>
      <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 16 }}>Hidden from In Flight until the day after this date, then back on the normal follow-up schedule. Nothing is sent while snoozed, not even for the month-end invoice push.</p>
      <div className="form-field"><label>Snooze until</label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>{presets.map(([l, v]) => <button key={l} className={`btn btn-sm ${date === v ? "btn-primary" : ""}`} onClick={() => setDate(v)}>{l}</button>)}</div>
        <input type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} /></div>
      <div className="form-field"><label>Note (optional)</label><textarea rows={2} placeholder="Why are you snoozing this?" value={note} onChange={(e) => setNote(e.target.value)} style={{ resize: "vertical" }} /></div>
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => onPick(date, note)}>Snooze until {date}</button></div>
    </div></div>
  );
}

function ReassignModal({ count, busy, onClose, onDone }) {
  const [email, setEmail] = useState(""); const [mode, setMode] = useState("reassign");
  return (
    <div className="modal-overlay"><div className="modal">
      <h3>Reassign {count > 1 ? `${count} issues` : "issue"}</h3>
      <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 16 }}>Choose who should be nudged. For issues found by the DMS check this only changes who we message; the campaign lead in DMS stays as it is (if DMS later names a different lead, DMS wins).</p>
      <div className="form-field"><label>Their email</label><input placeholder="name@wldd.in" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
      <div className="form-field"><label>How</label>
        <div style={{ display: "flex", gap: 8 }}><button className={`btn btn-sm ${mode === "reassign" ? "btn-primary" : ""}`} onClick={() => setMode("reassign")}>Replace the owner</button><button className={`btn btn-sm ${mode === "coowner" ? "btn-primary" : ""}`} onClick={() => setMode("coowner")}>Add as co-owner</button></div></div>
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !email.includes("@")} onClick={() => onDone(email, mode)}>{busy ? "Saving…" : "Reassign"}</button></div>
    </div></div>
  );
}

function EditModal({ row, categories, busy, onClose, onSave }) {
  const [campaign, setCampaign] = useState(row.campaign_name || ""); const [text, setText] = useState(row.issue_text || ""); const [category, setCategory] = useState(row.category);
  return (
    <div className="modal-overlay"><div className="modal">
      <h3>Edit issue</h3>
      <div className="form-field"><label>Campaign</label><input value={campaign} onChange={(e) => setCampaign(e.target.value)} /></div>
      <div className="form-field"><label>Issue (what the person sees)</label><textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} style={{ resize: "vertical" }} /></div>
      <div className="form-field"><label>Category</label><select value={category} onChange={(e) => setCategory(e.target.value)}>{categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></div>
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={() => onSave({ campaign, issue_text: text, category })}>Save</button></div>
    </div></div>
  );
}

function ReconcileModal({ categories, onClose, post, onDone }) {
  const [category, setCategory] = useState(categories[0]?.key || "revenue_mismatch"); const [text, setText] = useState(""); const [sheet, setSheet] = useState(""); const [pv, setPv] = useState(null); const [busy, setBusy] = useState(false);
  async function run(apply) { setBusy(true); const r = await post({ action: "reconcile", category, csvText: sheet ? undefined : text, sheetUrl: sheet || undefined, apply }); setBusy(false); if (!r) return; if (apply) onDone(`🔄 Reconciled: ${r.resolved} resolved, ${r.added} added`); else setPv(r); }
  return (
    <div className="modal-overlay"><div className="modal" style={{ width: 560 }}>
      <h3>Reconcile a category</h3>
      <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 14 }}>Paste the COMPLETE current list for one category. Your issues in that category that are not on the list are resolved, and anything on the list that is not tracked yet is added to Outreach. You see the numbers before anything changes.</p>
      <div className="form-field"><label>Category</label><select value={category} onChange={(e) => { setCategory(e.target.value); setPv(null); }}>{categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></div>
      <div className="form-field"><label>Complete list</label><input placeholder="Google Sheet URL (optional)" value={sheet} onChange={(e) => { setSheet(e.target.value); setPv(null); }} style={{ marginBottom: 8 }} /><textarea rows={5} placeholder="name, email, campaign, issue (with a header row)" value={text} onChange={(e) => { setText(e.target.value); setPv(null); }} style={{ resize: "vertical" }} /></div>
      {pv && <div style={{ background: "#f8f9fb", border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, marginBottom: 12, fontSize: 13 }}><b>{pv.toResolve}</b> would be resolved · <b>{pv.toAdd}</b> would be added · <b>{pv.unchanged}</b> stay as they are</div>}
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !(text.trim() || sheet.trim())} onClick={() => run(false)}>Preview</button><button className="btn btn-primary" disabled={busy || !pv} onClick={() => run(true)}>Apply</button></div>
    </div></div>
  );
}

const DOT = { created: "#9ca3af", sent: "#3b82f6", reply: "#10b981", hold: "#06b6d4", resolved: "#7c3aed", flag: "#f59e0b" };
function Drawer({ id, row, categories, today, onClose, post, busy, nudge, reload, openCampaign }) {
  const [det, setDet] = useState(null); const [note, setNote] = useState(null);
  useEffect(() => { setDet(null); fetch(`/api/ledger/${id}`).then((r) => r.json()).then(setDet); }, [id]);
  const refresh = async () => { await reload(); setDet(await (await fetch(`/api/ledger/${id}`)).json()); };
  const i = det?.issue;
  const owner = det?.people?.find((p) => p.dms_user_id === i?.owner_dms_user_id);
  const tl = det ? [
    { at: i.first_seen_at, kind: "created", title: i.source === "manual" ? "Added by you" : "Found by the DMS check" },
    ...(det.messages || []).map((m) => ({ at: m.sent_at || m.created_at, kind: "sent", title: `${m.channel === "slack" ? "Slack DM" : "Email"} ${m.kind === "first" ? "sent" : "follow-up"}${m.status !== "sent" ? ` (${m.status})` : ""}${m.mode !== "live" ? ` · ${m.mode}` : ""}`, note: m.subject === "[legacy manual outreach]" ? "Sent by hand before the automation" : `To ${m.to_address || "…"}${m.cc_addresses?.length ? `, cc ${m.cc_addresses.join(", ")}` : ""}` })),
    ...(det.replies || []).map((r) => ({ at: r.messages_in?.received_at || r.created_at, kind: "reply", title: `Reply from ${r.messages_in?.sender_address || "?"}: ${INTENT[r.intent] || r.intent}${r.promised_date ? ` (${r.promised_date})` : ""}`, bubble: r.messages_in?.clean_text?.slice(0, 400) })),
    ...(i.hold_until ? [{ at: i.updated_at || i.first_seen_at, kind: "hold", title: `Snoozed until ${fmtDay(i.hold_until)}`, note: holdInfo(i)?.why }] : []),
    ...(i.cleared_at ? [{ at: i.cleared_at, kind: "resolved", title: i.resolved_by ? "Resolved by you" : "Closed: DMS stopped flagging it", note: i.clear_reason }] : []),
  ].sort((a, b) => new Date(a.at) - new Date(b.at)) : [];
  return (<>
    <div className="drawer-overlay" onClick={onClose} />
    <div className="drawer">
      <div className="drawer-header">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div>
            <div className="poc-name" style={{ fontSize: 15 }}>{owner?.name || row?.person?.name || "No owner"}</div>
            <div className="poc-email">{owner?.email || row?.person?.email || ""}{owner?.manager_email ? ` · manager ${owner.manager_email}` : ""}</div>
            <div style={{ marginTop: 8, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              {row?.campaign_name && <span className="campaign-pill" onClick={() => openCampaign(row.campaign_name)}>{row.campaign_name} ↗</span>}
              <CategoryChip category={row?.category} categories={categories} />
              {row && <LBadge palette={row.status.palette} label={row.status.label} />}
            </div>
          </div>
          <button className="btn btn-sm" onClick={onClose}>✕</button>
        </div>
      </div>
      <div className="drawer-body">
        {!det ? <p style={{ color: "#9ca3af" }}>Loading…</p> : (<>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 18 }}>
            {i.state !== "cleared" && <button className="btn btn-orange btn-sm" disabled={busy} onClick={() => nudge([{ ...i, id: i.id }]).then(refresh)}>{i.state === "draft" ? "Send now" : "🔁 Nudge now"}</button>}
            {i.state === "open" && i.hold_until >= today && <button className="btn btn-sm" disabled={busy} onClick={() => post({ action: "unsnooze", ids: [i.id] }).then(refresh)}>Wake up now</button>}
            {i.source === "manual" && i.state !== "cleared" && <button className="btn btn-purple btn-sm" disabled={busy} onClick={() => post({ action: "resolve", ids: [i.id] }).then(refresh)}>✓ Resolve</button>}
            {i.source === "manual" && i.state === "cleared" && <button className="btn btn-sm" disabled={busy} onClick={() => post({ action: "reopen", ids: [i.id] }).then(refresh)}>↩ Reopen</button>}
            {i.category === "zero_cost_services" && i.state === "open" && <button className="btn btn-red btn-sm" disabled={busy} onClick={() => confirm("Never nudge this campaign and service again?") && post({ action: "zero_cost_exclude", campaign_id: i.campaign_id, campaign_name: i.campaign_name, service: i.detail?.service }, "/api/nudges").then(refresh)}>🚫 Exclude for good</button>}
          </div>
          {i.hold_until && i.hold_until >= today && i.state === "open" && (() => { const h = holdInfo(i); return (
            <div style={{ background: "#ecfeff", border: "1px solid #a5f3fc", borderRadius: 10, padding: "12px 14px", marginBottom: 18 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#0e7490", marginBottom: 4 }}>💤 SNOOZED {h.by === "you" ? "BY YOU" : h.by === "their reply" ? "FROM THEIR REPLY" : ""}</div>
              <div style={{ fontSize: 13, color: "#164e63", lineHeight: 1.5 }}>{h.why}</div>
              <div style={{ fontSize: 12, color: "#0e7490", marginTop: 6 }}>No nudges through <b>{fmtDay(h.until)}</b>. Nudging resumes on <b>{fmtDay(h.resumes)}</b>.</div>
            </div>); })()}
          <div className="drawer-section"><div className="drawer-section-title">Issue</div><div className="msg-bubble" style={{ marginTop: 0, whiteSpace: "pre-wrap" }}>{describeIssue(i)}</div>{i.detail?.internal_note && <p style={{ fontSize: 12, color: "#6b7280", marginTop: 8 }}><b>DMS note:</b> {i.detail.internal_note}</p>}</div>
          <div className="drawer-section"><div className="drawer-section-title">Nudge ladder</div>
            <p style={{ fontSize: 13 }}><b>{i.nudge_count}</b> nudge{i.nudge_count === 1 ? "" : "s"} so far{i.false_done_claims ? ` · said “done” while still pending ${i.false_done_claims}×` : ""}. The manager is copied from an item's 4th nudge.</p>
            {(det.items || []).length > 0 && (det.items.length > 1 || det.items[0].item_key !== "main") && det.items.map((it) => (
              <div key={it.id} style={{ fontSize: 12, color: it.state === "open" ? "#374151" : "#9ca3af", marginTop: 4 }}>· {it.item_key === "main" ? "the campaign" : `item …${it.item_key.slice(-6)}`}: {it.nudge_count} nudge{it.nudge_count === 1 ? "" : "s"}{it.item_created_at ? `, added ${dmy(it.item_created_at)}` : ""}{it.state === "cleared" ? " (done)" : ""}</div>
            ))}
            {(det.owners || []).filter((o) => o.active).map((o) => <p key={o.id} style={{ fontSize: 12, marginTop: 4 }}>{o.role === "co_owner" ? "Also nudged:" : "Reassigned to:"} {det.people?.find((p) => p.dms_user_id === o.dms_user_id)?.name || o.dms_user_id}</p>)}
          </div>
          <div className="drawer-section"><div className="drawer-section-title">Timeline</div>
            {tl.map((t, k) => (
              <div key={k} className="timeline-item"><div className="timeline-dot" style={{ background: DOT[t.kind] }} /><div className="timeline-content">
                <div className="timeline-action">{t.title}</div><div className="timeline-ts">{when(t.at)}</div>
                {t.note && <div className="timeline-note">{t.note}</div>}{t.bubble && <div className="msg-bubble" style={{ fontSize: 12 }}>{t.bubble}</div>}
              </div></div>
            ))}
            {(det.review || []).filter((r) => r.status === "open").map((r) => <div key={r.id} style={{ fontSize: 12, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 8, padding: "8px 10px", marginTop: 6 }}>⚑ {KIND[r.kind] || r.kind}: {r.note}</div>)}
          </div>
          <div className="drawer-section"><div className="drawer-section-title">Notes</div>
            <textarea rows={3} value={note ?? i.notes ?? ""} onChange={(e) => setNote(e.target.value)} placeholder="Private notes (for example: lead says this is handled offline)" style={{ resize: "vertical" }} />
            <button className="btn btn-sm" style={{ marginTop: 6 }} disabled={busy || note === null} onClick={() => post({ action: "note", ids: [i.id], text: note }).then(() => setNote(null))}>Save note</button></div>
        </>)}
      </div>
    </div>
  </>);
}

function CampaignDrawer({ name, rows, categories, onClose, open }) {
  return (<>
    <div className="drawer-overlay" onClick={onClose} />
    <div className="drawer">
      <div className="drawer-header"><div style={{ display: "flex", justifyContent: "space-between" }}><div><div className="poc-name" style={{ fontSize: 15 }}>{name}</div><div className="poc-email">{rows.length} issue{rows.length === 1 ? "" : "s"} on this campaign</div></div><button className="btn btn-sm" onClick={onClose}>✕</button></div></div>
      <div className="drawer-body">
        {rows.map((r) => (
          <div key={r.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, marginBottom: 10, cursor: "pointer" }} onClick={() => open(r.id)}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}><CategoryChip category={r.category} categories={categories} /><LBadge palette={r.status.palette} label={r.status.label} /></div>
            <div className="issue-text">{describeIssue(r)}</div>
            <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>{r.person?.name || "No owner"} · {r.nudge_count || 0} nudge{r.nudge_count === 1 ? "" : "s"}</div>
          </div>
        ))}
      </div>
    </div>
  </>);
}
