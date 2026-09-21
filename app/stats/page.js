"use client";
import { useEffect, useState, useMemo, useCallback } from "react";
import Link from "next/link";
import { CategoryChip } from "@/components/shared";

// Frequency: one view of how often people are chased and how well it works, across everything in the tracker
// (issues the DMS check finds and the ones you add by hand, automatic and manual nudges together).

const when = (t) => (t ? new Date(t).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" }) : "—");
const num = (v, suffix = "") => (v == null ? "—" : `${v}${suffix}`);

const COLS = [
  ["name", "POC"], ["open", "OPEN"], ["nudges", "NUDGES SENT"], ["openAfter3", "STILL OPEN AFTER 3"], ["falseDone", "FALSE “DONE”"],
  ["replyRate", "REPLY RATE"], ["avgResponseHours", "AVG RESPONSE"], ["avgDaysToClear", "AVG DAYS TO CLEAR"], ["resolved", "RESOLVED"], ["holds", "SNOOZES"], ["reassignedAway", "HANDED OVER"], ["lastContacted", "LAST NUDGE"],
];

export default function Frequency() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState({ key: null, dir: -1 });
  const [showWeekly, setShowWeekly] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/frequency"); const j = await r.json();
    if (!r.ok) return setErr(j.error || "Could not load");
    setErr(null); setD(j);
  }, []);
  useEffect(() => { load(); const f = () => document.visibilityState === "visible" && load(); document.addEventListener("visibilitychange", f); return () => document.removeEventListener("visibilitychange", f); }, [load]);

  const people = useMemo(() => {
    if (!d) return [];
    const ql = q.trim().toLowerCase();
    const list = d.byPerson.filter((p) => !ql || [p.name, p.email, p.manager].some((x) => (x || "").toLowerCase().includes(ql)));
    if (!sort.key) return list;
    return [...list].sort((a, b) => { const x = a[sort.key], y = b[sort.key]; if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (typeof x === "string" ? x.localeCompare(y) : x - y) * sort.dir; });
  }, [d, q, sort]);

  function exportCsv() {
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["POC", "Email", "Manager", ...COLS.slice(1).map((c) => c[1])].map(esc).join(",")];
    for (const p of people) rows.push([p.name, p.email, p.manager, ...COLS.slice(1).map(([k]) => (k === "lastContacted" ? (p[k] ? p[k].slice(0, 10) : "") : p[k]))].map(esc).join(","));
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" })); a.download = `frequency-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  }

  if (err) return <div><div className="page-header"><h1>Frequency</h1><p>{err}</p></div><p style={{ fontSize: 13 }}>This view is for admins. <Link href="/tracker-legacy">Open the old tracker</Link>.</p></div>;
  if (!d) return <div className="empty"><h3>Loading…</h3></div>;
  const c = d.cards;
  const cards = [
    ["Open issues", c.open, `${c.nudgedOpen} nudged · ${c.notYetNudged} yet to nudge`, "#2563eb"],
    ["Nudges sent, last 7 days", c.nudgesLast7, "emails and DMs", "#d97706"],
    ["Resolved, last 30 days", c.resolvedLast30, `avg ${num(c.avgDaysToClear, " days")} to clear`, "#7c3aed"],
    ["Said “done”, still pending", c.falseDone, "times, across everyone", c.falseDone ? "#dc2626" : "#9ca3af"],
  ];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 8 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-.4px" }}>Frequency</h1>
        <div style={{ display: "flex", gap: 8 }}><button className="btn btn-sm" onClick={load}>↻ Refresh</button><button className="btn btn-green btn-sm" onClick={exportCsv}>⬇ Download CSV</button></div>
      </div>
      <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 20 }}>How often people are chased and how well it works, for everything in the Tracker: issues the DMS check finds and the ones you add by hand, automatic and manual nudges together. The people with the most still open after 3 nudges come first.</p>

      <div className="stat-grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))" }}>
        {cards.map(([label, n, sub, col]) => <div key={label} className="stat-card" style={{ cursor: "default" }}><div className="stat-num" style={{ color: col }}>{n}</div><div className="stat-label">{label}</div><div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>{sub}</div></div>)}
      </div>

      <h2 style={{ fontSize: 15, fontWeight: 700, margin: "6px 0 4px" }}>By category</h2>
      <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 10 }}>Which problem types take longest to clear and how many nudges it takes.</p>
      <div style={{ marginBottom: 28 }}><p className="scroll-hint">← swipe the table sideways →</p><div className="tbl-wrap"><table>
        <thead><tr><th>CATEGORY</th><th>OPEN</th><th>CLEARED</th><th>NUDGES SENT</th><th>AVG NUDGES TO CLEAR</th><th>AVG DAYS TO CLEAR</th><th>AVG AGE OF OPEN</th></tr></thead>
        <tbody>{d.byCategory.map((x) => <tr key={x.category}>
          <td><div className="row-main" style={{ cursor: "default" }}><CategoryChip category={x.category} categories={[{ tag: x.category, name: x.label }]} /></div></td>
          <td><div className="row-main" style={{ cursor: "default", fontWeight: 700 }}>{x.open}</div></td><td><div className="row-main" style={{ cursor: "default" }}>{x.cleared}</div></td><td><div className="row-main" style={{ cursor: "default" }}>{x.nudges}</div></td>
          <td><div className="row-main" style={{ cursor: "default" }}>{num(x.avgNudgesToClear)}</div></td><td><div className="row-main" style={{ cursor: "default" }}>{num(x.avgDaysToClear)}</div></td><td><div className="row-main" style={{ cursor: "default" }}>{num(x.avgOpenAge, " days")}</div></td>
        </tr>)}</tbody></table></div></div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <div><h2 style={{ fontSize: 15, fontWeight: 700 }}>By person</h2><p style={{ fontSize: 12, color: "#6b7280" }}>Click a column to sort.</p></div>
        <input placeholder="🔍 Search person, email or manager…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 300 }} />
      </div>
      <div style={{ marginBottom: 28 }}><p className="scroll-hint">← swipe the table sideways to see every column →</p><div className="tbl-wrap"><table style={{ minWidth: 1100 }}>
        <thead><tr><th>#</th>{COLS.map(([k, l]) => <th key={k} style={{ cursor: "pointer" }} onClick={() => setSort((s) => ({ key: k, dir: s.key === k ? -s.dir : (k === "name" ? 1 : -1) }))}>{l}{sort.key === k ? (sort.dir === 1 ? " ▲" : " ▼") : ""}</th>)}</tr></thead>
        <tbody>
          {people.map((p, i) => (
            <tr key={p.id}>
              <td><div className="row-main" style={{ cursor: "default", color: "#9ca3af", fontSize: 12 }}>{i + 1}</div></td>
              <td><div className="row-main" style={{ cursor: "default", minWidth: 200 }}><div className="poc-block"><div className="poc-name">{p.name}</div><div className="poc-email">{p.email}{p.manager ? ` · ${p.manager}` : ""}</div></div></div></td>
              <td><div className="row-main" style={{ cursor: "default", fontWeight: 700 }}>{p.open}</div></td>
              <td><div className="row-main" style={{ cursor: "default" }}><span style={{ fontSize: 16, fontWeight: 700, color: p.nudges >= 8 ? "#dc2626" : p.nudges >= 4 ? "#d97706" : "#059669" }}>{p.nudges}</span></div></td>
              <td><div className="row-main" style={{ cursor: "default", color: p.openAfter3 ? "#dc2626" : "#9ca3af", fontWeight: 600 }}>{p.openAfter3}</div></td>
              <td><div className="row-main" style={{ cursor: "default", color: p.falseDone ? "#dc2626" : "#9ca3af", fontWeight: 600 }}>{p.falseDone}</div></td>
              <td><div className="row-main" style={{ cursor: "default", color: "#6b7280" }}>{num(p.replyRate, "%")}</div></td>
              <td><div className="row-main" style={{ cursor: "default", color: "#6b7280" }}>{num(p.avgResponseHours, "h")}</div></td>
              <td><div className="row-main" style={{ cursor: "default", color: "#6b7280" }}>{num(p.avgDaysToClear)}</div></td>
              <td><div className="row-main" style={{ cursor: "default", color: "#7c3aed", fontWeight: 600 }}>{p.resolved}</div></td>
              <td><div className="row-main" style={{ cursor: "default", color: "#0e7490" }}>{p.holds}</div></td>
              <td><div className="row-main" style={{ cursor: "default", color: "#2563eb" }}>{p.reassignedAway}</div></td>
              <td><div className="row-main" style={{ cursor: "default", color: "#9ca3af" }}>{when(p.lastContacted)}</div></td>
            </tr>
          ))}
          {!people.length && <tr><td colSpan={13}><div className="row-main" style={{ cursor: "default", color: "#9ca3af" }}>Nobody matches.</div></td></tr>}
        </tbody></table></div></div>

      <button className="btn btn-sm" onClick={() => setShowWeekly((v) => !v)}>{showWeekly ? "Hide" : "Show"} new vs cleared per week</button>
      {showWeekly && <div style={{ marginTop: 10 }}><div className="tbl-wrap"><table><thead><tr><th>WEEK STARTING</th><th>CATEGORY</th><th>NEW ISSUES</th><th>SINCE CLEARED</th></tr></thead><tbody>
        {d.weekly.map((w, i) => <tr key={i}><td><div className="row-main" style={{ cursor: "default" }}>{String(w.week).slice(0, 10)}</div></td><td><div className="row-main" style={{ cursor: "default" }}>{w.label}</div></td><td><div className="row-main" style={{ cursor: "default" }}>{w.new_issues}</div></td><td><div className="row-main" style={{ cursor: "default" }}>{w.cleared_since}</div></td></tr>)}
      </tbody></table></div></div>}
    </div>
  );
}
