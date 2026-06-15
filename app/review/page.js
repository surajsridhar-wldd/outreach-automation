"use client";
import { useEffect, useState, useCallback } from "react";

export default function ReviewPage() {
  const [records, setRecords] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/review").then(r => r.json());
    setRecords(r.records || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  function show(msg) { setToast(msg); setTimeout(() => setToast(null), 4000); }
  function toggle(id) { setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  function toggleAll() { setSelected(s => s.size === records.length ? new Set() : new Set(records.map(r => r.id))); }

  async function decide(ids, decision) {
    setBusy(true);
    for (const id of ids) {
      await fetch("/api/review", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ id, decision }) });
    }
    setBusy(false);
    setSelected(new Set());
    show(decision === "resolved" ? "✅ Marked resolved" : decision === "declined" ? "↩ Moved back to follow-up" : "✅ Updated");
    load();
  }

  if (records.length === 0) return (
    <div>
      <h1 style={{ fontSize:20, fontWeight:700, letterSpacing:"-.4px", marginBottom:4 }}>Review</h1>
      <p style={{ fontSize:13, color:"#6b7280", marginBottom:24 }}>Ambiguous replies that need your judgment before any action is taken.</p>
      <div className="empty">
        <div className="empty-icon">✨</div>
        <h3>Nothing to review</h3>
        <p>All replies were clear enough to handle automatically.</p>
      </div>
    </div>
  );

  return (
    <div>
      <h1 style={{ fontSize:20, fontWeight:700, letterSpacing:"-.4px", marginBottom:4 }}>Review</h1>
      <p style={{ fontSize:13, color:"#6b7280", marginBottom:16 }}>
        Replies the system detected but wasn't confident about. <strong>You decide what happens next.</strong> Nothing moves without your confirmation.
      </p>

      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12 }}>
        <label style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer", fontSize:13, fontWeight:500 }}>
          <input type="checkbox" style={{ width:"auto" }} checked={selected.size === records.length && records.length > 0} onChange={toggleAll} />
          Select all ({records.length})
        </label>
        {selected.size > 0 && (
          <div style={{ display:"flex", gap:8, marginLeft:16 }}>
            <button className="btn btn-purple btn-sm" disabled={busy} onClick={() => decide([...selected], "resolved")}>✓ Resolve all selected</button>
            <button className="btn btn-red btn-sm" disabled={busy} onClick={() => decide([...selected], "declined")}>↩ Return to follow-up</button>
          </div>
        )}
      </div>

      {records.map(r => {
        const msgs = r.reply_messages || [];
        return (
          <div key={r.id} style={{ background:"#fff", border:"1px solid #e5e7eb", borderLeft:"4px solid #f59e0b", borderRadius:10, padding:20, marginBottom:12 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:16, marginBottom:12 }}>
              <div style={{ flex:1 }}>
                <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:4, flexWrap:"wrap" }}>
                  <input type="checkbox" style={{ width:"auto" }} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                  <span style={{ fontWeight:700, fontSize:14 }}>{r.contacts?.name}</span>
                  <span style={{ fontSize:12, color:"#9ca3af" }}>{r.contacts?.email}</span>
                  {r.contacts?.campaign && <span style={{ fontSize:11, fontWeight:500, background:"#eff6ff", color:"#2563eb", padding:"2px 8px", borderRadius:99 }}>{r.contacts.campaign}</span>}
                </div>
                <div style={{ fontSize:12, color:"#6b7280", marginBottom:8 }}><strong>Issue:</strong> {r.contacts?.issue}</div>
                {r.message_notes && <div style={{ fontSize:12, color:"#6b7280", fontStyle:"italic" }}>Summary: "{r.message_notes}"</div>}
              </div>
              <div style={{ display:"flex", gap:8, flexWrap:"wrap", flexShrink:0 }}>
                <button className="btn btn-sm btn-purple" disabled={busy} onClick={() => decide([r.id], "resolved")}>✓ Resolved</button>
                <button className="btn btn-sm btn-green" disabled={busy} onClick={() => decide([r.id], "replied")}>Active (still ongoing)</button>
                <button className="btn btn-sm btn-red" disabled={busy} onClick={() => decide([r.id], "declined")}>↩ Not a reply</button>
              </div>
            </div>

            {msgs.length > 0 && (
              <div style={{ background:"#f8f9fb", borderRadius:8, padding:12 }}>
                <div style={{ fontSize:11, fontWeight:700, color:"#9ca3af", letterSpacing:".5px", textTransform:"uppercase", marginBottom:8 }}>
                  {msgs.length} message{msgs.length !== 1 ? "s" : ""} received
                </div>
                {msgs.map((msg, i) => (
                  <div key={i} style={{ display:"flex", gap:10, marginBottom:8 }}>
                    <span style={{ fontSize:11, color:"#9ca3af", minWidth:20 }}>#{i+1}</span>
                    <div style={{ background:"#fff", border:"1px solid #e5e7eb", borderRadius:8, padding:"8px 12px", fontSize:13, color:"#374151", flex:1, lineHeight:1.5 }}>{msg}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
