"use client";
import { useEffect, useState, useCallback } from "react";

export default function ResolvedPage() {
  const [records, setRecords] = useState([]);
  const [expanded, setExpanded] = useState(new Set());
  const [selected, setSelected] = useState(new Set());
  const [filterCampaign, setFilterCampaign] = useState("");
  const [histories, setHistories] = useState({});
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/outreach?status=resolved,escalated").then(r => r.json());
    setRecords(r.records || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  function show(msg) { setToast(msg); setTimeout(() => setToast(null), 4000); }
  function toggle(id) { setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  function toggleAll() { setSelected(s => s.size === view.length ? new Set() : new Set(view.map(r => r.id))); }

  async function toggleExpand(id) {
    const next = new Set(expanded);
    if (next.has(id)) { next.delete(id); setExpanded(next); return; }
    next.add(id); setExpanded(next);
    if (!histories[id]) {
      const r = await fetch(`/api/outreach/${id}/history`).then(r => r.json());
      setHistories(h => ({ ...h, [id]: r.events || [] }));
    }
  }

  async function bulkDelete() {
    if (!confirm(`Delete ${selected.size} resolved record(s)?`)) return;
    setBusy(true);
    await fetch("/api/outreach/bulk-update", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ ids:[...selected], action:"delete" }) });
    setBusy(false); setSelected(new Set()); show("🗑 Deleted"); load();
  }

  const campaigns = [...new Set(records.map(r => r.contacts?.campaign).filter(Boolean))];
  const view = records.filter(r => !filterCampaign || r.contacts?.campaign === filterCampaign);

  const STATUS_COLORS = {
    resolved: "#7c3aed", escalated: "#2563eb",
  };

  const EVENT_LABELS = {
    created:"Created", sent:"Outreach sent", reply_checked:"Checked for reply",
    reply_classified:"Reply detected", followup_sent:"Follow-up sent",
    resolved:"Resolved", status_changed:"Status changed", note_added:"Note added", escalated_stalled:"Escalated (stalled)",
  };

  return (
    <div>
      <h1 style={{ fontSize:20, fontWeight:700, letterSpacing:"-.4px", marginBottom:4 }}>Resolved</h1>
      <p style={{ fontSize:13, color:"#6b7280", marginBottom:20 }}>
        All resolved and escalated outreach. Click ▼ to see the full history.
      </p>

      <div style={{ display:"flex", gap:10, marginBottom:12, alignItems:"center", flexWrap:"wrap" }}>
        {campaigns.length > 0 && (
          <select value={filterCampaign} onChange={e => setFilterCampaign(e.target.value)} style={{ width:"auto", minWidth:160 }}>
            <option value="">All campaigns</option>
            {campaigns.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        {view.length > 0 && (
          <label style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer", fontSize:13, fontWeight:500 }}>
            <input type="checkbox" style={{ width:"auto" }} checked={selected.size === view.length && view.length > 0} onChange={toggleAll} />
            Select all
          </label>
        )}
        {selected.size > 0 && (
          <button className="btn btn-red btn-sm" disabled={busy} onClick={bulkDelete}>🗑 Delete ({selected.size})</button>
        )}
        <span style={{ marginLeft:"auto", fontSize:12, color:"#9ca3af" }}>{view.length} records</span>
      </div>

      {view.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">✅</div>
          <h3>Nothing resolved yet</h3>
          <p>Resolved and escalated records appear here.</p>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead><tr>
              <th style={{ width:32 }}></th>
              <th style={{ width:32 }}></th>
              <th>POC</th><th>CAMPAIGN</th><th>STATUS</th><th>RESOLVED</th>
            </tr></thead>
            <tbody>
              {view.map(r => (
                <>
                  <tr key={r.id} className={expanded.has(r.id) ? "expanded" : ""}>
                    <td><div className="row-main" style={{ padding:"12px 8px 12px 14px", cursor:"default" }}>
                      <input type="checkbox" style={{ width:"auto" }} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                    </div></td>
                    <td><div className="row-main" style={{ padding:"12px 8px", cursor:"pointer" }} onClick={() => toggleExpand(r.id)}>
                      <span style={{ fontSize:11, color:"#9ca3af" }}>{expanded.has(r.id) ? "▲" : "▼"}</span>
                    </div></td>
                    <td><div className="row-main" style={{ cursor:"default" }}>
                      <div>
                        <div className="poc-name">{r.contacts?.name}</div>
                        <div className="poc-email">{r.contacts?.email || "—"}</div>
                      </div>
                    </div></td>
                    <td><div className="row-main" style={{ cursor:"default" }}>
                      {r.contacts?.campaign ? <span style={{ fontSize:11, fontWeight:500, background:"#eff6ff", color:"#2563eb", padding:"2px 8px", borderRadius:99 }}>{r.contacts.campaign}</span> : "—"}
                    </div></td>
                    <td><div className="row-main" style={{ cursor:"default" }}>
                      <span style={{ fontSize:11, fontWeight:600, padding:"3px 8px", borderRadius:99, background: r.status==="escalated"?"#dbeafe":"#ede9fe", color:STATUS_COLORS[r.status] }}>
                        {r.status === "escalated" ? "↗ Escalated" : "✓ Resolved"}
                      </span>
                    </div></td>
                    <td><div className="row-main" style={{ cursor:"default", fontSize:12, color:"#9ca3af" }}>
                      {r.last_action_at ? new Date(r.last_action_at).toLocaleDateString() : "—"}
                    </div></td>
                  </tr>
                  {expanded.has(r.id) && (
                    <tr key={r.id + "_detail"}>
                      <td colSpan={6}>
                        <div className="row-detail">
                          <div style={{ fontSize:12, color:"#6b7280", marginBottom:12 }}><strong>Issue:</strong> {r.contacts?.issue}</div>
                          {r.message_notes && <div style={{ fontSize:12, color:"#6b7280", marginBottom:12, fontStyle:"italic" }}>Note: {r.message_notes}</div>}
                          <div style={{ fontSize:11, fontWeight:700, color:"#9ca3af", letterSpacing:".8px", textTransform:"uppercase", marginBottom:10 }}>Timeline</div>
                          {(histories[r.id] || []).map(e => (
                            <div key={e.id} style={{ display:"flex", gap:10, marginBottom:10, alignItems:"flex-start" }}>
                              <div style={{ width:8, height:8, borderRadius:"50%", background:"#d1d5db", flexShrink:0, marginTop:4 }} />
                              <div>
                                <div style={{ fontSize:12, fontWeight:600 }}>{EVENT_LABELS[e.action] || e.action}</div>
                                <div style={{ fontSize:11, color:"#9ca3af" }}>{new Date(e.created_at).toLocaleString()}</div>
                                {e.payload?.summary && <div style={{ fontSize:11, color:"#6b7280", fontStyle:"italic" }}>"{e.payload.summary}"</div>}
                                {e.payload?.note && <div style={{ fontSize:11, color:"#6b7280" }}>Note: {e.payload.note}</div>}
                                {e.payload?.escalateTo?.name && <div style={{ fontSize:11, color:"#2563eb" }}>→ {e.payload.escalateTo.name}</div>}
                              </div>
                            </div>
                          ))}
                          {!histories[r.id] && <p style={{ fontSize:12, color:"#9ca3af" }}>Loading…</p>}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
