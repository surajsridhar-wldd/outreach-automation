"use client";
import { useEffect, useState } from "react";

export default function Followups() {
  const [records, setRecords] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  async function load() {
    const r = await fetch("/api/followups/queue").then(r => r.json());
    setRecords(r.records || []);
  }
  useEffect(() => { load(); }, []);
  function show(m) { setToast(m); setTimeout(() => setToast(null), 5000); }
  function toggle(id) { setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }

  async function send(ids) {
    setBusy(true);
    const r = await fetch("/api/followups/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) }).then(r => r.json());
    setBusy(false);
    setSelected(new Set());
    const ok = r.results?.filter(x => x.ok).length || 0;
    const failed = r.results?.filter(x => !x.ok) || [];
    show(`✅ ${ok} follow-up(s) sent${failed.length ? ` · ⚠ ${failed[0].error}` : ""}`);
    load();
  }

  return (
    <div>
      <div className="page-header">
        <h1>Follow-ups Due</h1>
        <p>POCs who haven't replied since outreach was sent. After 3 follow-ups a record becomes Stalled.</p>
      </div>

      {records.length > 0 && (
        <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
          <button className="btn btn-orange" disabled={busy} onClick={() => send(records.map(r => r.id))}>
            🔁 Send All Follow-ups ({records.length})
          </button>
          {selected.size > 0 && (
            <button className="btn btn-orange" disabled={busy} onClick={() => send([...selected])}>
              Send Selected ({selected.size})
            </button>
          )}
          {selected.size > 0 && (
            <button className="btn" onClick={() => setSelected(new Set())}>Clear selection</button>
          )}
        </div>
      )}

      {records.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">🎉</div>
          <h3>No follow-ups due</h3>
          <p>The daily check runs every morning. Everyone has replied or been resolved.</p>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 32 }}></th>
                <th>POC</th>
                <th>CAMPAIGN</th>
                <th>ISSUE</th>
                <th>CHANNEL</th>
                <th>SENT</th>
                <th>FU #</th>
              </tr>
            </thead>
            <tbody>
              {records.map(r => (
                <tr key={r.id}>
                  <td><input type="checkbox" style={{ width: "auto" }} checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                  <td>
                    <div className="poc-name">{r.contacts?.name}</div>
                    <div className="poc-email">{r.contacts?.email}</div>
                  </td>
                  <td>{r.contacts?.campaign && <span className="campaign-pill">{r.contacts.campaign}</span>}</td>
                  <td><div className="issue-text">{r.contacts?.issue}</div></td>
                  <td><span style={{ fontSize: 12, color: "#6b7280" }}>{r.channel === "slack" ? "💬 Slack" : "📧 Email"}</span></td>
                  <td style={{ fontSize: 12, color: "#6b7280" }}>{r.reached_out_at ? new Date(r.reached_out_at).toLocaleDateString() : "—"}</td>
                  <td style={{ fontSize: 12, fontWeight: 600, color: r.followups >= 2 ? "#dc2626" : "#d97706" }}>{r.followups}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
