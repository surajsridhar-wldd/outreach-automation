"use client";
import { useEffect, useState } from "react";

export default function Stats() {
  const [stats, setStats] = useState([]);
  const [me, setMe] = useState(null);
  const [scope, setScope] = useState("mine");
  const [userMap, setUserMap] = useState({});

  useEffect(() => { fetch("/api/me").then(r => r.json()).then(setMe); }, []);
  useEffect(() => {
    fetch(`/api/stats?scope=${scope === "all" ? "all" : "mine"}`).then(r => r.json()).then(r => {
      setStats(r.stats || []); setUserMap(r.userMap || {});
    });
  }, [scope]);

  return (
    <div>
      <div className="page-header">
        <h1>Frequency Mapper</h1>
        <p>Who you reach out to most, who needs the most follow-ups, and average response times. Computed live from your event log.</p>
      </div>

      {me?.role === "admin" && (
        <div className="tabs" style={{ marginBottom: 20 }}>
          <button className={`tab-btn ${scope === "mine" ? "active" : ""}`} onClick={() => setScope("mine")}>My outreach</button>
          <button className={`tab-btn ${scope === "all" ? "active" : ""}`} onClick={() => setScope("all")}>★ Global (all users)</button>
        </div>
      )}

      {stats.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">📊</div>
          <h3>No data yet</h3>
          <p>Send some outreach and the frequency stats will appear here.</p>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>POC</th>
                {scope === "all" && <th>OPS MEMBER</th>}
                <th>OUTREACHES</th>
                <th>CAMPAIGNS</th>
                <th>FOLLOW-UPS</th>
                <th>REPLY RATE</th>
                <th>AVG RESPONSE</th>
                <th>LAST CONTACT</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s, i) => (
                <tr key={i}>
                  <td>
                    <div className="poc-name">{s.poc_name}</div>
                    <div className="poc-email">{s.poc_email}</div>
                  </td>
                  {scope === "all" && <td style={{ fontSize: 12, color: "#6b7280" }}>{userMap[s.user_id] || "—"}</td>}
                  <td>
                    <span style={{ fontWeight: 700, fontSize: 15, color: s.total_outreaches >= 5 ? "#dc2626" : s.total_outreaches >= 3 ? "#d97706" : "#059669" }}>
                      {s.total_outreaches}
                    </span>
                    {s.total_outreaches >= 5 && <span style={{ fontSize: 11, color: "#dc2626", marginLeft: 4 }}>⚠ high</span>}
                  </td>
                  <td style={{ fontSize: 12, color: "#6b7280" }}>{s.distinct_campaigns}</td>
                  <td style={{ fontWeight: 600, color: s.total_followups >= 3 ? "#d97706" : "#6b7280", fontSize: 13 }}>{s.total_followups}</td>
                  <td style={{ fontSize: 12, color: "#6b7280" }}>{s.reply_rate_pct != null ? `${s.reply_rate_pct}%` : "—"}</td>
                  <td style={{ fontSize: 12, color: "#6b7280" }}>{s.avg_response_hours != null ? `${s.avg_response_hours}h` : "—"}</td>
                  <td style={{ fontSize: 12, color: "#9ca3af" }}>{s.last_contacted ? new Date(s.last_contacted).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
