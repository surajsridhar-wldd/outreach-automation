"use client";
import { useEffect, useState, useCallback } from "react";

const STATUS_CONFIG = {
  pending:        { label: "Pending",          color: "#374151", bg: "#f3f4f6", border: "#e5e7eb", dot: "#9ca3af" },
  sent:           { label: "Sent",             color: "#1d4ed8", bg: "#eff6ff", border: "#bfdbfe", dot: "#3b82f6" },
  awaiting_reply: { label: "Awaiting Reply",   color: "#1d4ed8", bg: "#eff6ff", border: "#bfdbfe", dot: "#3b82f6" },
  replied:        { label: "Replied",          color: "#065f46", bg: "#ecfdf5", border: "#a7f3d0", dot: "#10b981" },
  needs_review:   { label: "Needs Review",     color: "#92400e", bg: "#fffbeb", border: "#fde68a", dot: "#f59e0b" },
  followup:       { label: "Follow-up Sent",   color: "#92400e", bg: "#fff7ed", border: "#fed7aa", dot: "#f97316" },
  resolved_auto:  { label: "Confirm Resolved", color: "#5b21b6", bg: "#f5f3ff", border: "#ddd6fe", dot: "#8b5cf6" },
  resolved:       { label: "Resolved",         color: "#4c1d95", bg: "#ede9fe", border: "#c4b5fd", dot: "#7c3aed" },
  no_reply:       { label: "No Reply",         color: "#991b1b", bg: "#fef2f2", border: "#fecaca", dot: "#ef4444" },
  stalled:        { label: "Stalled",          color: "#7f1d1d", bg: "#fef2f2", border: "#fca5a5", dot: "#dc2626" },
};

function Badge({ status }) {
  const c = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
  return (
    <span className="badge" style={{ color: c.color, background: c.bg, border: `1px solid ${c.border}` }}>
      <span className="badge-dot" style={{ background: c.dot }} />
      {c.label}
    </span>
  );
}

function days(d) {
  if (!d) return null;
  return Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
}

function DaysChip({ d }) {
  if (d === null || d === undefined) return <span style={{ color: "#9ca3af" }}>—</span>;
  if (d === 0) return <span style={{ color: "#9ca3af", fontSize: 12 }}>Today</span>;
  const cls = d > 14 ? "days-crit" : d > 7 ? "days-warn" : d > 3 ? "days-warn" : "days-ok";
  return <span className={cls}>{d}d{d > 7 ? " ⚠" : ""}</span>;
}

const ACTIVE_STATUSES = ["sent","awaiting_reply","followup","replied","needs_review","resolved_auto","no_reply","stalled"];

export default function Tracker() {
  const [records, setRecords]   = useState([]);
  const [tab, setTab]           = useState("active");
  const [selected, setSelected] = useState(new Set());
  const [channel, setChannel]   = useState("slack");
  const [busy, setBusy]         = useState({});
  const [toast, setToast]       = useState(null);
  const [csvText, setCsvText]   = useState("");
  const [sheetUrl, setSheetUrl] = useState("");
  const [drawer, setDrawer]     = useState(null);
  const [checkingIds, setCheckingIds] = useState(new Set());

  // Filters
  const [filterStatus,   setFilterStatus]   = useState("");
  const [filterCampaign, setFilterCampaign] = useState("");
  const [sortBy,         setSortBy]         = useState("created_at"); // created_at | days | followups
  const [sortDir,        setSortDir]        = useState("desc");

  const load = useCallback(async () => {
    const r = await fetch("/api/outreach").then(r => r.json());
    setRecords(r.records || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  function show(msg, type = "info") { setToast({ msg, type }); setTimeout(() => setToast(null), 5000); }

  // Derived data
  const pendingRecs = records.filter(r => r.status === "pending");
  const activeRecs  = records.filter(r => ACTIVE_STATUSES.includes(r.status));
  const doneRecs    = records.filter(r => r.status === "resolved");

  // All campaigns for filter dropdown
  const campaigns = [...new Set(records.map(r => r.contacts?.campaign).filter(Boolean))];

  // Apply filters + sort to current tab view
  function applyFilters(list) {
    let out = [...list];
    if (filterStatus)   out = out.filter(r => r.status === filterStatus);
    if (filterCampaign) out = out.filter(r => r.contacts?.campaign === filterCampaign);
    out.sort((a, b) => {
      let av, bv;
      if (sortBy === "days")      { av = days(a.reached_out_at) ?? -1; bv = days(b.reached_out_at) ?? -1; }
      else if (sortBy === "followups") { av = a.followups; bv = b.followups; }
      else                        { av = new Date(a.created_at).getTime(); bv = new Date(b.created_at).getTime(); }
      return sortDir === "desc" ? bv - av : av - bv;
    });
    return out;
  }

  const rawView   = tab === "pending" ? pendingRecs : tab === "active" ? activeRecs : doneRecs;
  const view      = tab === "import"  ? [] : applyFilters(rawView);

  const selectableIds  = view.filter(r => ["pending","sent","awaiting_reply","followup","no_reply"].includes(r.status)).map(r => r.id);
  const selPending     = [...selected].filter(id => records.find(r => r.id === id)?.status === "pending");
  const selCheckable   = [...selected].filter(id => ["sent","awaiting_reply","followup","no_reply"].includes(records.find(r => r.id === id)?.status));
  const selResolvable  = [...selected].filter(id => !["resolved"].includes(records.find(r => r.id === id)?.status));

  function toggleAll() { setSelected(s => s.size === selectableIds.length ? new Set() : new Set(selectableIds)); }
  function toggle(id)  { setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  function sortToggle(col) { if (sortBy === col) setSortDir(d => d === "desc" ? "asc" : "desc"); else { setSortBy(col); setSortDir("desc"); } }
  function SortIcon({ col }) { return sortBy === col ? (sortDir === "desc" ? " ↓" : " ↑") : ""; }

  // Actions
  async function doImport() {
    setBusy(b => ({ ...b, import: true }));
    const body = sheetUrl.trim() ? { sheetUrl: sheetUrl.trim() } : { csvText };
    const r = await fetch("/api/contacts/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
    setBusy(b => ({ ...b, import: false }));
    if (r.error) return show("⚠ " + r.error, "error");
    setCsvText(""); setSheetUrl("");
    show(`✅ Imported ${r.created} POC(s)`);
    setTab("active"); load();
  }

  async function bulkSend() {
    setBusy(b => ({ ...b, send: true }));
    const r = await fetch("/api/outreach/bulk-send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: selPending, channel }) }).then(r => r.json());
    setBusy(b => ({ ...b, send: false }));
    setSelected(new Set());
    if (r.error) return show("⚠ " + r.error, "error");
    const ok = r.results?.filter(x => x.ok).length || 0;
    const failed = r.results?.filter(x => !x.ok) || [];
    show(`✅ Sent ${ok}${failed.length ? ` · ⚠ ${failed[0].error}` : ""}`);
    load();
  }

  async function checkReply(id) {
    setCheckingIds(s => new Set([...s, id]));
    const r = await fetch("/api/outreach/bulk-update", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [id], action: "check_reply" }),
    }).then(r => r.json());
    setCheckingIds(s => { const n = new Set(s); n.delete(id); return n; });
    const result = r.results?.[0];
    if (result?.error) show(`⚠ ${result.error}`, "error");
    else show(`✅ ${result?.newStatus?.replace(/_/g," ") || "checked"}`);
    load();
  }

  async function resolveOne(id) {
    await fetch(`/api/outreach/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "resolved" }) });
    show("✅ Resolved"); load();
  }

  async function bulkResolve() {
    setBusy(b => ({ ...b, resolve: true }));
    await fetch("/api/outreach/bulk-update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: selResolvable, action: "resolve" }) });
    setBusy(b => ({ ...b, resolve: false }));
    setSelected(new Set()); show("✅ Resolved"); load();
  }

  async function bulkCheck() {
    setBusy(b => ({ ...b, check: true }));
    await fetch("/api/outreach/bulk-update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: selCheckable, action: "check_reply" }) });
    setBusy(b => ({ ...b, check: false }));
    setSelected(new Set()); show("✅ Reply check complete"); load();
  }

  async function openDrawer(rec) {
    setDrawer({ record: rec, events: null });
    const r = await fetch(`/api/outreach/${rec.id}/history`).then(r => r.json());
    setDrawer({ record: rec, events: r.events || [] });
  }

  // Stat counts
  const counts = {};
  records.forEach(r => counts[r.status] = (counts[r.status] || 0) + 1);
  const needsConfirm = (counts["resolved_auto"] || 0) + (counts["replied"] || 0);

  const EVENT_COLORS = {
    created:"#9ca3af",sent:"#3b82f6",reply_checked:"#f59e0b",
    reply_classified:"#10b981",followup_sent:"#f97316",resolved:"#7c3aed",
    status_changed:"#6b7280",note_added:"#6b7280",escalated_stalled:"#ef4444",
  };

  return (
    <div>
      {/* Stats */}
      <div className="stat-grid">
        {[
          { key:"pending",  label:"Pending",  color:"#374151" },
          { key:"sent",     label:"Sent",     color:"#2563eb" },
          { key:"no_reply", label:"No Reply", color:"#dc2626" },
          { key:"replied",  label:"Replied",  color:"#059669" },
          { key:"resolved_auto", label:"Confirm?", color:"#7c3aed" },
          { key:"resolved", label:"Resolved", color:"#6b7280" },
        ].map(({ key, label, color }) => (
          <div key={key} className="stat-card" style={{ cursor: "pointer" }}
            onClick={() => { setFilterStatus(key); setTab(key === "pending" ? "pending" : key === "resolved" ? "done" : "active"); }}>
            <div className="stat-num" style={{ color }}>{counts[key] || 0}</div>
            <div className="stat-label">{label}</div>
          </div>
        ))}
      </div>

      {/* Confirm-resolved banner */}
      {needsConfirm > 0 && (
        <div style={{ background: "#f5f3ff", border: "1px solid #ddd6fe", borderRadius: 10, padding: "12px 16px", marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <span style={{ fontWeight: 600, color: "#5b21b6", fontSize: 13 }}>
              {needsConfirm} POC{needsConfirm !== 1 ? "s" : ""} replied or auto-resolved
            </span>
            <span style={{ color: "#7c3aed", fontSize: 13 }}> — confirm each one to mark as Resolved</span>
          </div>
          <button className="btn btn-sm btn-purple"
            onClick={() => { setFilterStatus("replied"); setTab("active"); }}>
            Review Now →
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="tabs">
        <button className={`tab-btn ${tab==="import"?"active":""}`}   onClick={() => { setTab("import");  setSelected(new Set()); }}>➕ Import</button>
        <button className={`tab-btn ${tab==="pending"?"active":""}`}  onClick={() => { setTab("pending"); setSelected(new Set()); setFilterStatus(""); }}>
          Needs Outreach <span className="tab-count">{pendingRecs.length}</span>
        </button>
        <button className={`tab-btn ${tab==="active"?"active":""}`}   onClick={() => { setTab("active");  setSelected(new Set()); setFilterStatus(""); }}>
          Active <span className="tab-count">{activeRecs.length}</span>
        </button>
        <button className={`tab-btn ${tab==="done"?"active":""}`}     onClick={() => { setTab("done");    setSelected(new Set()); setFilterStatus(""); }}>
          Resolved <span className="tab-count">{doneRecs.length}</span>
        </button>
      </div>

      {/* Import Tab */}
      {tab === "import" && (
        <div className="import-card">
          <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Import POCs from a table</h2>
          <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 20 }}>
            Paste tab-separated or CSV data. Required columns: <strong>Campaign</strong>, <strong>POC Name</strong>, <strong>Email</strong>, <strong>Issue</strong>.
          </p>
          <div className="example-box">{"Campaign\tPOC Name\tEmail\tIssue\nQ2 GST Recon\tPriya Sharma\tpriya@corp.in\tMissing GST entries for March"}</div>
          <div style={{ marginBottom: 12 }}>
            <label>Google Sheet URL (optional)</label>
            <input placeholder="https://docs.google.com/spreadsheets/d/…" value={sheetUrl} onChange={e => setSheetUrl(e.target.value)} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label>Or paste table directly</label>
            <textarea rows={6} placeholder="Paste your table here…" value={csvText} onChange={e => setCsvText(e.target.value)} style={{ resize: "vertical" }} />
          </div>
          <button className="btn btn-primary" disabled={busy.import || (!csvText.trim() && !sheetUrl.trim())} onClick={doImport}>
            {busy.import ? "Importing…" : "Import POCs →"}
          </button>
        </div>
      )}

      {/* List tabs */}
      {tab !== "import" && (
        <>
          {/* Filters row */}
          <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ width: "auto", minWidth: 160 }}>
              <option value="">All statuses</option>
              {Object.entries(STATUS_CONFIG).map(([k,v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            {campaigns.length > 0 && (
              <select value={filterCampaign} onChange={e => setFilterCampaign(e.target.value)} style={{ width: "auto", minWidth: 160 }}>
                <option value="">All campaigns</option>
                {campaigns.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
            {(filterStatus || filterCampaign) && (
              <button className="btn btn-sm" onClick={() => { setFilterStatus(""); setFilterCampaign(""); }}>✕ Clear filters</button>
            )}
            <span style={{ marginLeft: "auto", fontSize: 12, color: "#9ca3af" }}>{view.length} record{view.length !== 1 ? "s" : ""}</span>
          </div>

          {/* Bulk bar */}
          {selectableIds.length > 0 && (
            <div className="bulk-bar">
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" style={{ width: "auto", accentColor: "#fff" }}
                  checked={selected.size === selectableIds.length && selectableIds.length > 0}
                  onChange={toggleAll} />
                <span style={{ fontSize: 13, color: "#fff", fontWeight: 500 }}>
                  {selected.size > 0 ? `${selected.size} selected` : `Select all (${selectableIds.length})`}
                </span>
              </label>
              {selPending.length > 0 && <>
                <div className="channel-toggle">
                  <button className={`ch-btn ${channel==="slack"?"active":""}`} onClick={() => setChannel("slack")}>💬 Slack</button>
                  <button className={`ch-btn ${channel==="email"?"active":""}`} onClick={() => setChannel("email")}>📧 Email</button>
                </div>
                <button className="btn btn-primary btn-sm" disabled={busy.send} onClick={bulkSend}>
                  {busy.send ? "Sending…" : `Send ${selPending.length} via ${channel}`}
                </button>
              </>}
              {selCheckable.length > 0 && (
                <button className="btn btn-sm" style={{ background:"rgba(255,255,255,.15)", color:"#fff", border:"1px solid rgba(255,255,255,.2)" }}
                  disabled={busy.check} onClick={bulkCheck}>
                  {busy.check ? "Checking…" : `🔍 Check Replies (${selCheckable.length})`}
                </button>
              )}
              {selResolvable.length > 0 && (
                <button className="btn btn-sm" style={{ background:"rgba(255,255,255,.1)", color:"rgba(255,255,255,.8)", border:"1px solid rgba(255,255,255,.15)", marginLeft:"auto" }}
                  disabled={busy.resolve} onClick={bulkResolve}>
                  {busy.resolve ? "…" : `✓ Mark Resolved (${selResolvable.length})`}
                </button>
              )}
            </div>
          )}

          {/* Table */}
          {view.length === 0 ? (
            <div className="empty">
              <div className="empty-icon">{tab==="pending"?"📋":tab==="active"?"📬":"✅"}</div>
              <h3>{filterStatus || filterCampaign ? "No records match your filters" : tab==="pending" ? "No pending POCs" : tab==="active" ? "No active outreach" : "Nothing resolved yet"}</h3>
              <p>{!filterStatus && !filterCampaign && tab==="pending" ? "Import a table to add POCs." : !filterStatus && !filterCampaign && tab==="active" ? "Send outreach from Needs Outreach tab." : ""}</p>
            </div>
          ) : (
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ width:32 }}></th>
                    <th>POC</th>
                    <th style={{ cursor:"pointer" }} onClick={() => setFilterCampaign("")}>CAMPAIGN</th>
                    <th>ISSUE</th>
                    <th style={{ cursor:"pointer" }} onClick={() => setFilterStatus("")}>STATUS</th>
                    <th style={{ cursor:"pointer", userSelect:"none" }} onClick={() => sortToggle("days")}>DAYS<SortIcon col="days" /></th>
                    <th style={{ cursor:"pointer", userSelect:"none" }} onClick={() => sortToggle("followups")}>FU<SortIcon col="followups" /></th>
                    <th>ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {view.map(r => {
                    const canSelect  = selectableIds.includes(r.id);
                    const d          = days(r.reached_out_at);
                    const isChecking = checkingIds.has(r.id);
                    const needsConfirmRow = r.status === "resolved_auto" || r.status === "replied";
                    return (
                      <tr key={r.id} style={{ background: needsConfirmRow ? "#fafaf7" : undefined }}>
                        <td style={{ width:32 }}>
                          {canSelect && <input type="checkbox" style={{ width:"auto" }} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />}
                        </td>
                        <td>
                          <div className="poc-name">{r.contacts?.name}</div>
                          <div className="poc-email">{r.contacts?.email}</div>
                        </td>
                        <td>{r.contacts?.campaign && <span className="campaign-pill">{r.contacts.campaign}</span>}</td>
                        <td>
                          <div className="issue-text">{r.contacts?.issue}</div>
                          {r.message_notes && <div style={{ fontSize:11, color:"#6b7280", marginTop:4, fontStyle:"italic" }}>💬 {r.message_notes}</div>}
                        </td>
                        <td><Badge status={r.status} /></td>
                        <td><DaysChip d={d} /></td>
                        <td style={{ color: r.followups>0?"#d97706":"#9ca3af", fontWeight:600, fontSize:12 }}>{r.followups||0}</td>
                        <td>
                          <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                            {["sent","awaiting_reply","followup","no_reply"].includes(r.status) && (
                              <button className="btn btn-sm btn-green" disabled={isChecking} onClick={() => checkReply(r.id)}>
                                {isChecking ? "…" : "🔍 Check"}
                              </button>
                            )}
                            {needsConfirmRow && (
                              <button className="btn btn-sm btn-purple" onClick={() => resolveOne(r.id)} title="Confirm and mark as Resolved">
                                ✓ Resolve
                              </button>
                            )}
                            {!["resolved","resolved_auto","replied"].includes(r.status) && (
                              <button className="btn btn-sm" style={{ color:"#6b7280" }} onClick={() => resolveOne(r.id)}>✓</button>
                            )}
                            <button className="btn btn-sm" onClick={() => openDrawer(r)}>History</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* History Drawer */}
      {drawer && (
        <div className="drawer">
          <div className="drawer-header">
            <div>
              <h3>{drawer.record.contacts?.name}</h3>
              <div style={{ fontSize:12, color:"#6b7280" }}>{drawer.record.contacts?.email}</div>
            </div>
            <button className="btn btn-sm" onClick={() => setDrawer(null)}>✕ Close</button>
          </div>
          <div className="drawer-body">
            <div style={{ background:"#f8f9fb", borderRadius:8, padding:"10px 12px", marginBottom:16 }}>
              <div style={{ fontSize:11, fontWeight:600, color:"#9ca3af", marginBottom:4, textTransform:"uppercase", letterSpacing:".4px" }}>Issue</div>
              <div style={{ fontSize:13, color:"#374151" }}>{drawer.record.contacts?.issue}</div>
              {drawer.record.contacts?.campaign && (
                <span className="campaign-pill" style={{ marginTop:6, display:"inline-block" }}>{drawer.record.contacts.campaign}</span>
              )}
            </div>
            {drawer.events === null ? (
              <p style={{ color:"#9ca3af", fontSize:13 }}>Loading…</p>
            ) : drawer.events.length === 0 ? (
              <p style={{ color:"#9ca3af", fontSize:13 }}>No events yet.</p>
            ) : drawer.events.map(e => (
              <div className="event-item" key={e.id}>
                <span className="event-dot" style={{ background: EVENT_COLORS[e.action]||"#9ca3af" }} />
                <div>
                  <div className="event-action">{e.action.replace(/_/g," ")}</div>
                  <div className="event-ts">{new Date(e.created_at).toLocaleString()}</div>
                  {e.new_status && <div style={{ fontSize:11, color:"#6b7280" }}>Status → {e.new_status.replace(/_/g," ")}</div>}
                  {e.payload?.summary && <div className="event-note">"{e.payload.summary}"</div>}
                  {e.payload?.messages && <div style={{ fontSize:11, color:"#6b7280", marginTop:2 }}>Messages seen: {e.payload.messages.length}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {toast && <div className="toast" style={{ background: toast.type==="error"?"#dc2626":"#111827" }}>{toast.msg}</div>}
    </div>
  );
}
