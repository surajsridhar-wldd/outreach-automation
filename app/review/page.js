"use client";
import { useEffect, useState } from "react";

export default function Review() {
  const [records, setRecords] = useState([]);
  const [toast, setToast] = useState(null);

  async function load() {
    const r = await fetch("/api/review").then(r => r.json());
    setRecords(r.records || []);
  }
  useEffect(() => { load(); }, []);
  function show(m) { setToast(m); setTimeout(() => setToast(null), 4000); }

  async function decide(id, decision) {
    await fetch("/api/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, decision }) });
    show("✅ Updated"); load();
  }

  return (
    <div>
      <div className="page-header">
        <h1>Needs Review</h1>
        <p>Replies the system wasn't confident about, plus auto-detected resolutions awaiting confirmation. The system never decides these on its own.</p>
      </div>

      {records.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">✨</div>
          <h3>Nothing to review</h3>
          <p>All reply detections were clear enough to handle automatically.</p>
        </div>
      ) : records.map(r => (
        <div key={r.id} className={`review-card ${r.status === "resolved_auto" ? "auto" : "ambiguous"}`}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
                <span className="poc-name">{r.contacts?.name}</span>
                {r.contacts?.campaign && <span className="campaign-pill">{r.contacts.campaign}</span>}
              </div>
              <div className="issue-text" style={{ marginBottom: 8 }}>{r.contacts?.issue}</div>
              <div style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                background: r.status === "resolved_auto" ? "#f5f3ff" : "#fffbeb",
                border: `1px solid ${r.status === "resolved_auto" ? "#ddd6fe" : "#fde68a"}`,
                borderRadius: 6, padding: "4px 10px", fontSize: 12,
                color: r.status === "resolved_auto" ? "#7c3aed" : "#92400e",
              }}>
                {r.status === "resolved_auto" ? "🤖 Looks like it's resolved" : "❓ Ambiguous reply"}
                {r.message_notes && <span style={{ color: "#6b7280" }}> — "{r.message_notes}"</span>}
                {r.reply_confidence != null && <span style={{ color: "#9ca3af" }}>({Math.round(r.reply_confidence * 100)}% confidence)</span>}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn btn-sm btn-purple" onClick={() => decide(r.id, "resolved")}>✓ Confirm Resolved</button>
              <button className="btn btn-sm btn-green" onClick={() => decide(r.id, "replied")}>It's a real reply</button>
              <button className="btn btn-sm" onClick={() => decide(r.id, "awaiting_reply")}>Not a real reply</button>
            </div>
          </div>
        </div>
      ))}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
