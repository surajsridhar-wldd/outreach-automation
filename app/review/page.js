"use client";
import { useEffect, useState } from "react";

export default function Review() {
  const [records, setRecords] = useState([]);
  const [toast, setToast] = useState(null);

  async function load() {
    const r = await fetch("/api/review").then((r) => r.json());
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
      <h1>Needs Review</h1>
      <p className="dim" style={{ marginBottom: 16 }}>
        Ambiguous replies the system wasn't confident about, plus auto-detected resolutions awaiting your confirmation. The system never decides these on its own.
      </p>
      {records.map((r) => (
        <div className="card" key={r.id}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <strong>{r.contacts?.name}</strong> <span className="faint">· {r.contacts?.campaign}</span>
              <div className="dim" style={{ marginTop: 4 }}>{r.contacts?.issue}</div>
              <div style={{ marginTop: 8, color: r.status === "resolved_auto" ? "var(--purple)" : "var(--orange)", fontSize: 12 }}>
                {r.status === "resolved_auto" ? "🤖 Looks resolved" : "❓ Ambiguous reply"}
                {r.message_notes && <span className="dim"> — "{r.message_notes}"</span>}
                {r.reply_confidence != null && <span className="faint"> ({Math.round(r.reply_confidence * 100)}% confident)</span>}
              </div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-purple" onClick={() => decide(r.id, "resolved")}>✓ Confirm Resolved</button>
              <button className="btn btn-green" onClick={() => decide(r.id, "replied")}>It's a reply</button>
              <button className="btn btn-grey" onClick={() => decide(r.id, "awaiting_reply")}>Not a real reply</button>
            </div>
          </div>
        </div>
      ))}
      {records.length === 0 && <p className="dim">Nothing needs review. ✨</p>}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
