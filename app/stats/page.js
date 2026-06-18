"use client";
import { useEffect, useState, useCallback } from "react";

export default function StatsPage() {
  const [stats, setStats] = useState([]);
  const [me, setMe] = useState(null);
  const [scope, setScope] = useState("mine");
  const [downloading, setDownloading] = useState(false);

  useEffect(() => { fetch("/api/me").then(r => r.json()).then(setMe); }, []);

  const load = useCallback(() => {
    fetch(`/api/stats?scope=${scope}`).then(r => r.json()).then(d => setStats(d.stats || []));
  }, [scope]);

  useEffect(() => { load(); }, [load]);

  // Re-fetch whenever the tab regains focus or becomes visible again —
  // covers the case where outreach was sent elsewhere and you switch back here.
  useEffect(() => {
    function onFocus() { load(); }
    function onVisible() { if (document.visibilityState === "visible") load(); }
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  async function download() {
    setDownloading(true);
    const res = await fetch(`/api/stats?scope=${scope}&format=xlsx`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `frequency-tracker-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setDownloading(false);
  }

  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:4 }}>
        <h1 style={{ fontSize:20, fontWeight:700, letterSpacing:"-.4px" }}>Frequency Tracker</h1>
        <div style={{ display:"flex", gap:8 }}>
          <button className="btn btn-sm" onClick={load}>↻ Refresh</button>
          <button className="btn btn-green btn-sm" disabled={downloading || !stats.length} onClick={download}>
            {downloading ? "Downloading…" : "⬇ Download CSV"}
          </button>
        </div>
      </div>
      <p style={{ fontSize:13, color:"#6b7280", marginBottom:20 }}>
        One row per POC — aggregated across all campaigns. POCs with the most outreaches or follow-ups are shown first.
      </p>

      {me?.role === "admin" && (
        <div className="tabs" style={{ marginBottom:20 }}>
          <button className={`tab-btn ${scope==="mine"?"active":""}`} onClick={() => setScope("mine")}>My outreach</button>
          <button className={`tab-btn ${scope==="all"?"active":""}`} onClick={() => setScope("all")}>★ Global (all users)</button>
        </div>
      )}

      {stats.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">📊</div>
          <h3>No data yet</h3>
          <p>Send some outreach and frequency stats will appear here.</p>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead><tr>
              <th>#</th>
              <th>POC</th>
              {scope === "all" && <th>OPS MEMBER</th>}
              <th>OUTREACHES</th>
              <th>CAMPAIGNS</th>
              <th>FOLLOW-UPS</th>
              <th>REPLY RATE</th>
              <th>AVG RESPONSE</th>
              <th>RESOLVED</th>
              <th>ESCALATED</th>
              <th>LAST CONTACT</th>
            </tr></thead>
            <tbody>
              {stats.map((s, i) => (
                <tr key={i}>
                  <td><div className="row-main" style={{ cursor:"default", color:"#9ca3af", fontSize:12 }}>{i+1}</div></td>
                  <td><div className="row-main" style={{ cursor:"default" }}>
                    <div>
                      <div className="poc-name">{s.poc_name}</div>
                      {s.poc_email && <div className="poc-email">{s.poc_email}</div>}
                      {s.campaigns_list && <div style={{ fontSize:11, color:"#9ca3af", marginTop:2 }}>{s.campaigns_list}</div>}
                    </div>
                  </div></td>
                  {scope === "all" && <td><div className="row-main" style={{ cursor:"default", fontSize:12, color:"#6b7280" }}>{s.user_name || "—"}</div></td>}
                  <td><div className="row-main" style={{ cursor:"default" }}>
                    <span style={{ fontSize:18, fontWeight:700, color: s.total_outreaches >= 5 ? "#dc2626" : s.total_outreaches >= 3 ? "#d97706" : "#059669" }}>
                      {s.total_outreaches}
                    </span>
                    {s.total_outreaches >= 5 && <span style={{ fontSize:10, color:"#dc2626", marginLeft:4 }}>HIGH ⚠</span>}
                  </div></td>
                  <td><div className="row-main" style={{ cursor:"default", fontSize:12, color:"#6b7280" }}>{s.distinct_campaigns}</div></td>
                  <td><div className="row-main" style={{ cursor:"default" }}>
                    <span style={{ fontSize:14, fontWeight:600, color: s.total_followups >= 3 ? "#d97706" : "#6b7280" }}>{s.total_followups}</span>
                  </div></td>
                  <td><div className="row-main" style={{ cursor:"default", fontSize:12, color:"#6b7280" }}>{s.reply_rate_pct != null ? `${s.reply_rate_pct}%` : "—"}</div></td>
                  <td><div className="row-main" style={{ cursor:"default", fontSize:12, color:"#6b7280" }}>{s.avg_response_hours != null ? `${s.avg_response_hours}h` : "—"}</div></td>
                  <td><div className="row-main" style={{ cursor:"default", fontSize:12, color:"#7c3aed", fontWeight:600 }}>{s.resolved_count}</div></td>
                  <td><div className="row-main" style={{ cursor:"default", fontSize:12, color:"#2563eb", fontWeight:600 }}>{s.escalated_count}</div></td>
                  <td><div className="row-main" style={{ cursor:"default", fontSize:12, color:"#9ca3af" }}>
                    {s.last_contacted ? new Date(s.last_contacted).toLocaleDateString() : "—"}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
