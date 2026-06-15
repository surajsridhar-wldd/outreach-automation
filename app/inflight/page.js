"use client";
import { useEffect, useState, useCallback } from "react";
import { Badge, BulkBar, DaysChip, days, CampaignDrawer, EscalateModal, SC } from "@/components/shared";

const INFLIGHT_STATUSES = ["sent","active","no_reply","followup","stalled"];

export default function InFlightPage() {
  const [records, setRecords] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState({});
  const [toast, setToast] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [escalateModal, setEscalateModal] = useState(null);
  const [filterStatus, setFilterStatus] = useState("");
  const [filterCampaign, setFilterCampaign] = useState("");
  const [checkingIds, setCheckingIds] = useState(new Set());

  const load = useCallback(async () => {
    const r = await fetch(`/api/outreach?status=${INFLIGHT_STATUSES.join(",")}`).then(r => r.json());
    setRecords(r.records || []);
  }, []);

  useEffect(() => { load(); }, [load]);

  function show(msg, type = "info") { setToast({ msg, type }); setTimeout(() => setToast(null), 5000); }
  function toggle(id) { setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }

  const campaigns = [...new Set(records.map(r => r.contacts?.campaign).filter(Boolean))];
  const view = records
    .filter(r => !filterStatus || r.status === filterStatus)
    .filter(r => !filterCampaign || r.contacts?.campaign === filterCampaign);

  function toggleAll() { setSelected(s => s.size === view.length ? new Set() : new Set(view.map(r => r.id))); }

  const selCheckable = [...selected].filter(id => ["sent","active","no_reply","followup","stalled"].includes(records.find(r=>r.id===id)?.status));
  const selNoReply = [...selected].filter(id => ["no_reply","stalled"].includes(records.find(r=>r.id===id)?.status));

  async function checkReplies(ids) {
    setCheckingIds(s => new Set([...s, ...ids]));
    const r = await fetch("/api/outreach/bulk-update", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ ids, action:"check_reply" }) }).then(r => r.json());
    setCheckingIds(s => { const n = new Set(s); ids.forEach(id => n.delete(id)); return n; });
    setSelected(new Set());
    const active = r.results?.filter(x => x.newStatus === "active").length || 0;
    const review = r.results?.filter(x => x.newStatus === "needs_review").length || 0;
    const noRep = r.results?.filter(x => x.newStatus === "no_reply").length || 0;
    show(`✅ Checked: ${active} active · ${noRep} no reply${review ? ` · ${review} needs review` : ""}`);
    load();
  }

  async function sendFollowups(ids) {
    setBusy(b => ({ ...b, fu: true }));
    const r = await fetch("/api/followups/send", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ ids }) }).then(r => r.json());
    setBusy(b => ({ ...b, fu: false }));
    setSelected(new Set());
    const ok = r.results?.filter(x => x.ok).length || 0;
    show(`✅ ${ok} follow-up(s) sent`);
    load();
  }

  async function resolveOne(id) {
    await fetch(`/api/outreach/${id}`, { method:"PATCH", headers:{"content-type":"application/json"}, body:JSON.stringify({ status:"resolved" }) });
    show("✅ Resolved"); load();
  }

  async function bulkResolve() {
    setBusy(b => ({ ...b, resolve: true }));
    await fetch("/api/outreach/bulk-update", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ ids:[...selected], action:"resolve" }) });
    setBusy(b => ({ ...b, resolve: false }));
    setSelected(new Set()); show("✅ Resolved"); load();
  }

  const counts = {};
  records.forEach(r => counts[r.status] = (counts[r.status] || 0) + 1);

  return (
    <div>
      <h1 style={{ fontSize:20, fontWeight:700, letterSpacing:"-.4px", marginBottom:4 }}>In Flight</h1>
      <p style={{ fontSize:13, color:"#6b7280", marginBottom:20 }}>
        All outreach that's been sent. Active means they replied. No Reply means silence. Click a campaign name to see full details.
      </p>

      {/* Status stat strip */}
      <div className="stat-grid" style={{ marginBottom:20 }}>
        {[
          { key:"sent",     label:"Sent",         color:"#2563eb" },
          { key:"active",   label:"Active",        color:"#059669" },
          { key:"no_reply", label:"No Reply",      color:"#ef4444" },
          { key:"followup", label:"Follow-up Sent",color:"#f97316" },
          { key:"stalled",  label:"Stalled",       color:"#dc2626" },
        ].map(({ key, label, color }) => (counts[key] > 0) && (
          <div key={key} className="stat-card" onClick={() => setFilterStatus(filterStatus === key ? "" : key)}>
            <div className="stat-num" style={{ color }}>{counts[key]}</div>
            <div className="stat-label">{label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display:"flex", gap:10, marginBottom:12, flexWrap:"wrap", alignItems:"center" }}>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ width:"auto", minWidth:160 }}>
          <option value="">All statuses</option>
          {INFLIGHT_STATUSES.map(s => <option key={s} value={s}>{SC[s]?.label || s}</option>)}
        </select>
        {campaigns.length > 0 && (
          <select value={filterCampaign} onChange={e => setFilterCampaign(e.target.value)} style={{ width:"auto", minWidth:160 }}>
            <option value="">All campaigns</option>
            {campaigns.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        {(filterStatus || filterCampaign) && (
          <button className="btn btn-sm" onClick={() => { setFilterStatus(""); setFilterCampaign(""); }}>✕ Clear</button>
        )}
        <span style={{ marginLeft:"auto", fontSize:12, color:"#9ca3af" }}>{view.length} records</span>
      </div>

      {/* Select all */}
      {view.length > 0 && (
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
          <label style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer", fontSize:13, fontWeight:500 }}>
            <input type="checkbox" style={{ width:"auto" }} checked={selected.size === view.length && view.length > 0} onChange={toggleAll} />
            Select all ({view.length})
          </label>
        </div>
      )}

      <BulkBar selected={selected.size}>
        {selCheckable.length > 0 && (
          <button className="btn btn-green btn-sm" disabled={checkingIds.size > 0} onClick={() => checkReplies(selCheckable)}>
            🔍 Check Replies ({selCheckable.length})
          </button>
        )}
        {selNoReply.length > 0 && (
          <button className="btn btn-orange btn-sm" disabled={busy.fu} onClick={() => sendFollowups(selNoReply)}>
            🔁 Follow-up ({selNoReply.length})
          </button>
        )}
        {selected.size > 0 && (
          <button className="btn btn-purple btn-sm" disabled={busy.resolve} onClick={bulkResolve}>
            ✓ Resolve ({selected.size})
          </button>
        )}
        {selected.size > 0 && (
          <button className="btn btn-sm" style={{ background:"rgba(255,255,255,.1)",color:"rgba(255,255,255,.8)",border:"1px solid rgba(255,255,255,.2)", marginLeft:"auto" }}
            onClick={() => setEscalateModal([...selected])}>
            ↗ Escalate ({selected.size})
          </button>
        )}
      </BulkBar>

      {view.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">📬</div>
          <h3>{filterStatus || filterCampaign ? "No records match filters" : "Nothing in flight"}</h3>
          <p>{!filterStatus && !filterCampaign ? "Send outreach from the Outreach tab first." : ""}</p>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead><tr>
              <th style={{ width:32 }}></th>
              <th>POC</th><th>CAMPAIGN</th><th>STATUS</th><th>DAYS</th><th>FU</th><th>ACTIONS</th>
            </tr></thead>
            <tbody>
              {view.map(r => {
                const checking = checkingIds.has(r.id);
                return (
                  <tr key={r.id}>
                    <td><div className="row-main" style={{ padding:"12px 8px 12px 14px", cursor:"default" }}>
                      <input type="checkbox" style={{ width:"auto" }} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                    </div></td>
                    <td><div className="row-main" style={{ cursor:"default" }}>
                      <div>
                        <div className="poc-name">{r.contacts?.name}</div>
                        <div className="poc-email">{r.contacts?.email || "—"}</div>
                      </div>
                    </div></td>
                    <td><div className="row-main" style={{ cursor:"default" }}>
                      {r.contacts?.campaign ? (
                        <span className="campaign-pill" onClick={() => setDrawer(r.contacts.campaign)}>{r.contacts.campaign} ↗</span>
                      ) : "—"}
                    </div></td>
                    <td><div className="row-main" style={{ cursor:"default" }}>
                      <Badge status={r.status} />
                      {r.message_notes && <span style={{ fontSize:11, color:"#6b7280", marginLeft:6, fontStyle:"italic" }}>{r.message_notes}</span>}
                    </div></td>
                    <td><div className="row-main" style={{ cursor:"default" }}><DaysChip d={days(r.reached_out_at)} /></div></td>
                    <td><div className="row-main" style={{ cursor:"default", fontSize:12, fontWeight:600, color:r.followups > 0 ? "#d97706" : "#9ca3af" }}>{r.followups || 0}</div></td>
                    <td><div className="row-main" style={{ cursor:"default", gap:6 }}>
                      {["sent","active","no_reply","followup","stalled"].includes(r.status) && (
                        <button className="btn btn-green btn-sm" disabled={checking} onClick={() => checkReplies([r.id])}>
                          {checking ? "…" : "🔍 Check"}
                        </button>
                      )}
                      {["no_reply","stalled"].includes(r.status) && (
                        <button className="btn btn-orange btn-sm" disabled={busy.fu} onClick={() => sendFollowups([r.id])}>🔁</button>
                      )}
                      <button className="btn btn-purple btn-sm" onClick={() => resolveOne(r.id)}>✓</button>
                      <button className="btn btn-sm" onClick={() => setEscalateModal([r.id])}>↗</button>
                    </div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {drawer && <CampaignDrawer campaign={drawer} onClose={() => setDrawer(null)} onStatusChange={async (id, status) => { await fetch(`/api/outreach/${id}`, { method:"PATCH", headers:{"content-type":"application/json"}, body:JSON.stringify({ status }) }); setDrawer(null); load(); }} />}
      {escalateModal && <EscalateModal ids={escalateModal} records={records} onClose={() => setEscalateModal(null)} onDone={load} />}
      {toast && <div className="toast" style={{ background: toast.type==="error" ? "#dc2626" : "#1e293b" }}>{toast.msg}</div>}
    </div>
  );
}
