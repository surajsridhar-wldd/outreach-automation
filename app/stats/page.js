"use client";
import { useEffect, useState } from "react";

export default function Stats() {
  const [stats, setStats] = useState([]);
  const [me, setMe] = useState(null);
  const [scope, setScope] = useState("mine");
  const [userMap, setUserMap] = useState({});

  useEffect(() => { fetch("/api/me").then((r) => r.json()).then(setMe); }, []);
  useEffect(() => {
    fetch(`/api/stats?scope=${scope === "all" ? "all" : "mine"}`).then((r) => r.json()).then((r) => {
      setStats(r.stats || []); setUserMap(r.userMap || {});
    });
  }, [scope]);

  return (
    <div>
      <h1>Frequency Mapper</h1>
      <p className="dim" style={{ marginBottom: 12 }}>
        Who you reach out to most, who needs the most follow-ups, and who responds slowest. Numbers are computed live from the event log — they can't drift.
      </p>
      {me?.role === "admin" && (
        <div className="row" style={{ marginBottom: 14 }}>
          <button className={`btn ${scope === "mine" ? "btn-blue" : ""}`} onClick={() => setScope("mine")}>My outreach</button>
          <button className={`btn ${scope === "all" ? "btn-purple" : ""}`} onClick={() => setScope("all")}>★ Global (admin)</button>
        </div>
      )}
      <table>
        <thead><tr>
          <th>POC</th>{scope === "all" && <th>OPS MEMBER</th>}<th>OUTREACHES</th><th>CAMPAIGNS</th><th>FOLLOW-UPS</th><th>REPLY RATE</th><th>AVG RESPONSE</th><th>LAST CONTACT</th>
        </tr></thead>
        <tbody>
          {stats.map((s, i) => (
            <tr key={i}>
              <td><div>{s.poc_name}</div><div className="faint">{s.poc_email}</div></td>
              {scope === "all" && <td className="dim">{userMap[s.user_id] || "—"}</td>}
              <td style={{ color: s.total_outreaches >= 5 ? "var(--red)" : s.total_outreaches >= 3 ? "var(--orange)" : "var(--text)" }}>{s.total_outreaches}{s.total_outreaches >= 5 && " ⚠"}</td>
              <td className="dim">{s.distinct_campaigns}</td>
              <td style={{ color: s.total_followups >= 3 ? "var(--orange)" : "var(--dim)" }}>{s.total_followups}</td>
              <td className="dim">{s.reply_rate_pct != null ? s.reply_rate_pct + "%" : "—"}</td>
              <td className="dim">{s.avg_response_hours != null ? s.avg_response_hours + "h" : "—"}</td>
              <td className="faint">{s.last_contacted ? new Date(s.last_contacted).toLocaleDateString() : "—"}</td>
            </tr>
          ))}
          {stats.length === 0 && <tr><td colSpan={8} className="dim" style={{ padding: 24, textAlign: "center" }}>No outreach yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
