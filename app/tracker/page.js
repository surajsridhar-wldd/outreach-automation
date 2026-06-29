"use client";
import { useEffect, useState, useCallback } from "react";
import { Badge, DaysChip, days, SC, CampaignDrawer, EditModal, EscalateModal, BulkBar, SendProgressModal } from "@/components/shared";

const TABS = [
  { id:"outreach",   label:"Outreach",   statuses:["pending"],                          help:"Imported but not yet sent." },
  { id:"inflight",   label:"In Flight",  statuses:["sent","active","no_reply","followup","stalled"], help:"Sent. Waiting for reply or follow-up." },
  { id:"review",     label:"Review",     statuses:["needs_review"],                     help:"System found a reply but isn't sure it's related. You decide." },
  { id:"monitoring", label:"Snoozed", statuses:["monitoring","snoozed"],                       help:"Snoozed — hidden from In Flight until the snooze expires, then auto-resurfaced for follow-up. No follow-ups sent while snoozed. Re-imports of the same issue just refresh the date." },
  { id:"resolved",   label:"Resolved",   statuses:["resolved","escalated"],             help:"Closed out — either resolved by you or handed off." },
];

const STATE_HELP = {
  pending:      "Imported. No message sent yet.",
  sent:         "Message sent. Not yet checked for reply.",
  active:       "POC has replied. Conversation ongoing — you're managing it.",
  no_reply:     "Checked for reply. Nothing came back. Needs a follow-up.",
  followup:     "Follow-up sent. Waiting again.",
  stalled:      "3+ follow-ups sent with no response. Needs escalation.",
  needs_review: "System found a Slack DM but isn't confident it relates to your issue.",
  monitoring:   "Acknowledged. Will resolve in due time — no action needed from you right now.",
  resolved:     "You manually marked this done.",
  escalated:    "Handed off to someone else.",
};

export default function TrackerPage() {
  const [tab, setTab]               = useState("outreach");
  const [records, setRecords]       = useState({});  // { tabId: [...] }
  const [selected, setSelected]     = useState(new Set());
  const [channel, setChannel]       = useState("slack");
  const [busy, setBusy]             = useState({});
  const [toast, setToast]           = useState(null);
  const [csvText, setCsvText]       = useState("");
  const [sheetUrl, setSheetUrl]     = useState("");
  const [importing, setImporting]   = useState(false);
  const [progress, setProgress]     = useState(null);
  const [drawer, setDrawer]         = useState(null);       // campaign name string → CampaignDrawer
  const [pocDrawer, setPocDrawer]   = useState(null);       // record → POC detail drawer
  const [editRec, setEditRec]       = useState(null);
  const [escalateIds, setEscalateIds] = useState(null);
  const [checkingIds, setCheckingIds] = useState(new Set());
  const [histories, setHistories]   = useState({});         // { outreach_id: events[] }
  const [filterCampaign, setFilterCampaign] = useState("");
  const [search, setSearch] = useState("");
  const [followupChannelIds, setFollowupChannelIds] = useState(null); // ids pending channel choice for follow-up
  const [tagging, setTagging]       = useState(null);       // null | 'running' | 'done'  — categorization marker
  const [filterStatus, setFilterStatus] = useState("");

  const loadTab = useCallback(async (t) => {
    const tabDef = TABS.find(x => x.id === t);
    if (!tabDef) return;
    const r = await fetch(`/api/outreach?status=${tabDef.statuses.join(",")}`).then(r => r.json());
    setRecords(prev => ({ ...prev, [t]: r.records || [] }));
  }, []);

  useEffect(() => { loadTab(tab); }, [tab, loadTab]);

  // Refetch the active tab whenever the window regains focus or becomes visible —
  // covers leaving the tab open, sending messages via another window/device, then coming back.
  useEffect(() => {
    function onFocus() { loadTab(tab); }
    function onVisible() { if (document.visibilityState === "visible") loadTab(tab); }
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tab, loadTab]);

  const currentRecs = records[tab] || [];
  const campaigns = [...new Set(currentRecs.map(r => r.contacts?.campaign).filter(Boolean))];
  const searchLower = search.trim().toLowerCase();
  const view = currentRecs
    .filter(r => !filterCampaign || r.contacts?.campaign === filterCampaign)
    .filter(r => !filterStatus || r.status === filterStatus)
    .filter(r => !searchLower ||
      (r.contacts?.name||"").toLowerCase().includes(searchLower) ||
      (r.contacts?.campaign||"").toLowerCase().includes(searchLower) ||
      (r.contacts?.email||"").toLowerCase().includes(searchLower) ||
      (r.contacts?.issue||"").toLowerCase().includes(searchLower)
    );

  function show(msg, type="info") { setToast({ msg, type }); setTimeout(() => setToast(null), 5000); }
  function toggle(id) { setSelected(s => { const n = new Set(s); n.has(id)?n.delete(id):n.add(id); return n; }); }
  function toggleAll() { setSelected(s => s.size===view.length?new Set():new Set(view.map(r=>r.id))); }
  function reload() {
    // Refresh every tab's cached data, not just the active one, so badge counts
    // and lists are accurate the instant you switch tabs after any action.
    TABS.forEach(t => loadTab(t.id));
    setSelected(new Set());
  }

  // Load history for POC drawer
  async function openPocDrawer(rec) {
    // Open immediately with what we have, then refetch fresh in the background
    setPocDrawer({ rec, events: null });
    await refreshPocDrawer(rec.id);
  }

  async function refreshPocDrawer(id) {
    const [recRes, histRes] = await Promise.all([
      fetch(`/api/outreach/${id}`).then(r => r.json()),
      fetch(`/api/outreach/${id}/history`).then(r => r.json()),
    ]);
    if (recRes?.record) {
      setHistories(h => ({ ...h, [id]: histRes.events || [] }));
      setPocDrawer(prev => (prev && prev.rec.id === id) ? { rec: recRes.record, events: histRes.events || [] } : prev);
    }
  }

  // Actions
  async function doImport() {
    setImporting(true);
    const body = sheetUrl.trim() ? { sheetUrl:sheetUrl.trim() } : { csvText };
    const r = await fetch("/api/contacts/import",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(r=>r.json());
    setImporting(false);
    if (r.error) return show("⚠ "+r.error,"error");
    setCsvText(""); setSheetUrl("");
    const parts = [`✅ Imported ${r.created}`];
    if (r.followup_queued) parts.push(`${r.followup_queued} queued for follow-up (same issue)`);
    if (r.skipped) parts.push(`${r.skipped} skipped`);
    show(parts.join(' · '));
    loadTab("outreach");
    // Browser-triggered batched categorization. The marker waits on this before send.
    if (r.untaggedCount > 0) runTagging();
  }

  async function runTagging() {
    setTagging("running");
    try {
      // Loop in case there are more than one batch-run worth of records.
      let guard = 0;
      while (guard++ < 10) {
        const res = await fetch("/api/tag-pending",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}).then(r=>r.json());
        if (!res || res.error) break;
        if ((res.untaggedCount || 0) === 0) break;
      }
      setTagging("done");
      loadTab("outreach");
      // Clear the "done" marker after a short while.
      setTimeout(() => setTagging(null), 6000);
    } catch {
      setTagging(null);
    }
  }

  async function bulkSend() {
    const ids = [...selected];
    setProgress({ total:ids.length, results:[] });
    setBusy(b=>({...b,send:true}));
    const r = await fetch("/api/outreach/bulk-send",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ids,channel})}).then(r=>r.json());
    setBusy(b=>({...b,send:false}));
    setProgress({ total:ids.length, results:r.results||[] });
    reload();
  }

  async function checkReplies(ids) {
    setCheckingIds(s => new Set([...s,...ids]));
    const r = await fetch("/api/outreach/bulk-update",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ids,action:"check_reply"})}).then(r=>r.json());
    setCheckingIds(s=>{ const n=new Set(s); ids.forEach(id=>n.delete(id)); return n; });
    setSelected(new Set());
    const active=(r.results||[]).filter(x=>x.newStatus==="active").length;
    const review=(r.results||[]).filter(x=>x.newStatus==="needs_review").length;
    const noRep=(r.results||[]).filter(x=>x.newStatus==="no_reply").length;
    show(`✅ ${active} active · ${noRep} no reply${review?` · ${review} → Review tab`:""}`);
    // Reload current and adjacent tabs
    ["inflight","review"].forEach(t => loadTab(t));
    reload();
    // If the drawer is open for one of these records, refresh it with the new live status
    if (pocDrawer && ids.includes(pocDrawer.rec.id)) refreshPocDrawer(pocDrawer.rec.id);
  }

  async function sendFollowups(ids, channel) {
    setBusy(b=>({...b,fu:true}));
    const r = await fetch("/api/followups/send",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ids, channel})}).then(r=>r.json());
    setBusy(b=>({...b,fu:false}));
    setSelected(new Set());
    setFollowupChannelIds(null);
    const ok = (r.results||[]).filter(x=>x.ok).length;
    const failed = (r.results||[]).filter(x=>!x.ok);
    show(`✅ ${ok} follow-up(s) sent via ${channel||"original channel"}${failed.length?` · ⚠ ${failed[0].error}`:""}`);
    reload();
    if (pocDrawer && ids.includes(pocDrawer.rec.id)) refreshPocDrawer(pocDrawer.rec.id);
  }

  async function bulkResolve(ids) {
    await fetch("/api/outreach/bulk-update",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ids,action:"resolve"})});
    setSelected(new Set()); show("✅ Resolved"); reload(); loadTab("resolved");
    if (pocDrawer && ids.includes(pocDrawer.rec.id)) refreshPocDrawer(pocDrawer.rec.id);
  }

  async function bulkMonitor(ids) {
    const note = prompt("Optional note (e.g. 'waiting on finance team to confirm closing cost'):") || "";
    await fetch("/api/outreach/bulk-update",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ids,action:"monitor",payload:{note}})});
    setSelected(new Set()); show("👁 Moved to Monitoring — no follow-ups will be sent"); reload(); loadTab("monitoring");
    if (pocDrawer && ids.includes(pocDrawer.rec.id)) refreshPocDrawer(pocDrawer.rec.id);
  }

  async function patchOne(id, status) {
    await fetch(`/api/outreach/${id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({status})});
    reload(); loadTab("resolved"); loadTab("inflight");
    show("✅ Updated");
    if (pocDrawer?.rec.id === id) refreshPocDrawer(id);
  }

  async function decideReview(id, decision) {
    await fetch("/api/review",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id,decision})});
    show(decision==="resolved"?"✅ Resolved":decision==="declined"?"↩ Back to follow-up":"✅ Marked active");
    reload(); loadTab("inflight"); loadTab("resolved");
    if (pocDrawer?.rec.id === id) refreshPocDrawer(id);
  }

  async function bulkDelete(ids) {
    if (!confirm(`Delete ${ids.length} record(s)?`)) return;
    await fetch("/api/outreach/bulk-update",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ids,action:"delete"})});
    setSelected(new Set()); show("🗑 Deleted"); reload();
  }

  // Tab-specific selectable set
  const selCheckable  = [...selected].filter(id=>["sent","active","no_reply","followup","stalled"].includes(currentRecs.find(r=>r.id===id)?.status));
  const selNoReply    = [...selected].filter(id=>["active","no_reply","stalled","followup"].includes(currentRecs.find(r=>r.id===id)?.status));
  const selPending    = [...selected].filter(id=>currentRecs.find(r=>r.id===id)?.status==="pending");
  const selResolvable = [...selected].filter(id=>!["resolved","escalated"].includes(currentRecs.find(r=>r.id===id)?.status));

  // Counts for tab badges
  const tabCounts = {};
  Object.entries(records).forEach(([t, recs]) => tabCounts[t] = recs.length);

  // Stat counts within current tab
  const counts = {};
  currentRecs.forEach(r => counts[r.status]=(counts[r.status]||0)+1);

  const EVENT_LABELS = {
    created:"Created", sent:"Outreach sent", reply_checked:"Checked for reply",
    reply_classified:"Reply detected", followup_sent:"Follow-up sent",
    resolved:"Resolved", status_changed:"Status updated", note_added:"Note added",
    escalated_stalled:"Reassigned (stalled)",
  };

  const TIMELINE_COLORS = {
    created:"#9ca3af", sent:"#3b82f6", reply_checked:"#f59e0b",
    reply_classified:"#10b981", followup_sent:"#f97316",
    resolved:"#7c3aed", status_changed:"#6b7280", escalated_stalled:"#ef4444",
  };

  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:20 }}>
        <h1 style={{ fontSize:20, fontWeight:700, letterSpacing:"-.4px" }}>Tracker</h1>
        <button className="btn btn-sm" onClick={reload}>↻ Refresh</button>
      </div>

      {/* Tabs */}
      <div className="tabs">
        {TABS.map(t => {
          // Load count from all records fetched
          const cnt = (records[t.id]||[]).length;
          const urgent = t.id==="review" && cnt>0;
          return (
            <button key={t.id} className={`tab-btn ${tab===t.id?"active":""}`}
              onClick={() => { setTab(t.id); setSelected(new Set()); setFilterCampaign(""); setFilterStatus(""); }}>
              {t.label}
              {cnt>0 && <span className="tab-count" style={urgent?{background:"#f59e0b",color:"#fff"}:{}}>{cnt}</span>}
            </button>
          );
        })}
      </div>

      {/* State explanation */}
      <p style={{ fontSize:12, color:"#9ca3af", marginBottom:12 }}>
        {TABS.find(t=>t.id===tab)?.help}
      </p>

      {/* Search bar — always visible */}
      <div style={{ marginBottom:16 }}>
        <input
          placeholder="🔍 Search by POC name, campaign, email, or issue…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ maxWidth:420 }}
        />
      </div>

      {/* ── OUTREACH TAB ── */}
      {tab==="outreach" && (
        <>
          {/* Import */}
          <div className="import-box" style={{ marginBottom:20 }}>
            <div style={{ fontWeight:600, fontSize:14, marginBottom:10 }}>Import POCs</div>
            <div className="example-box">{"Campaign\tPOC Name\tEmail (optional)\tIssue\none8 x journey\tKirsten Menezes\t\tCampaign crossed its posting end date on DMS…"}</div>
            <p style={{ fontSize:11, color:"#9ca3af", marginBottom:10 }}>Email optional for Slack. Duplicates (same name + campaign with active outreach) auto-skipped.</p>
            <input placeholder="Google Sheet URL (optional)" value={sheetUrl} onChange={e=>setSheetUrl(e.target.value)} style={{ marginBottom:8 }}/>
            <textarea rows={4} placeholder="Or paste tab-separated / CSV table…" value={csvText} onChange={e=>setCsvText(e.target.value)} style={{ resize:"vertical", marginBottom:10 }}/>
            <button className="btn btn-primary" disabled={importing||(!csvText.trim()&&!sheetUrl.trim())} onClick={doImport}>
              {importing?"Importing…":"Import →"}
            </button>
          </div>

          {/* Categorization marker — wait for ✓ checked before sending */}
          {tagging==="running" && (
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16, padding:"10px 14px", background:"#fffbeb", border:"1px solid #fde68a", borderRadius:8, fontSize:13, color:"#92400e" }}>
              <span className="spinner" style={{ width:14, height:14, border:"2px solid #fcd34d", borderTopColor:"transparent", borderRadius:"50%", display:"inline-block", animation:"spin 0.7s linear infinite" }} />
              Categorizing imported records with Claude… please wait before sending so every record is checked against your in-flight list.
            </div>
          )}
          {tagging==="done" && (
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16, padding:"10px 14px", background:"#ecfdf5", border:"1px solid #a7f3d0", borderRadius:8, fontSize:13, color:"#065f46" }}>
              ✓ All imported records categorized and checked — safe to send.
            </div>
          )}

          {view.length===0 ? (
            <div className="empty"><div className="empty-icon">📋</div><h3>No pending outreach</h3><p>Import a table above. Once sent, records move to In Flight automatically.</p></div>
          ) : (
            <>
              <SelectAllRow total={view.length} selected={selected.size} onToggle={toggleAll} />
              <BulkBar selected={selected.size}>
                <div className="channel-toggle">
                  <button className={`ch-btn ${channel==="slack"?"active":""}`} onClick={()=>setChannel("slack")}>💬 Slack</button>
                  <button className={`ch-btn ${channel==="email"?"active":""}`} onClick={()=>setChannel("email")}>📧 Email</button>
                </div>
                {selPending.length>0 && <button className="btn btn-primary btn-sm" disabled={busy.send||tagging==="running"} onClick={bulkSend} title={tagging==="running"?"Wait for categorization to finish":""}>{busy.send?"Sending…":tagging==="running"?"Checking…":`Send ${selPending.length}`}</button>}
                <button className="btn btn-red btn-sm" style={{ marginLeft:"auto" }} onClick={()=>bulkDelete([...selected])}>🗑 Delete</button>
              </BulkBar>
              <div className="tbl-wrap">
                <table>
                  <thead><tr><th style={{width:32}}></th><th>POC</th><th>CAMPAIGN</th><th>ISSUE</th><th>ACTIONS</th></tr></thead>
                  <tbody>
                    {view.map(r=>(
                      <tr key={r.id}>
                        <td><Chk checked={selected.has(r.id)} onChange={()=>toggle(r.id)}/></td>
                        <td><Cell><div className="poc-name">{r.contacts?.name}</div><div className="poc-email">{r.contacts?.email||<span style={{color:"#f97316",fontSize:11}}>No email — Slack only</span>}</div></Cell></td>
                        <td><Cell>{r.contacts?.campaign?<span className="campaign-pill" onClick={()=>setDrawer(r.contacts.campaign)}>{r.contacts.campaign} ↗</span>:"—"}</Cell></td>
                        <td><Cell><div className="issue-text">{r.contacts?.issue}</div></Cell></td>
                        <td><Cell gap>
                          <button className="btn btn-sm" onClick={()=>setEditRec(r)}>✏ Edit</button>
                          <button className="btn btn-sm" style={{color:"#6b7280"}} onClick={()=>openPocDrawer(r)}>Details</button>
                          <button className="btn btn-red btn-sm" onClick={()=>bulkDelete([r.id])}>🗑</button>
                        </Cell></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {/* ── IN FLIGHT TAB ── */}
      {tab==="inflight" && (
        <>
          {/* Button legend */}
          <div style={{display:"flex",gap:12,flexWrap:"wrap",alignItems:"center",marginBottom:12,padding:"8px 12px",background:"#f8f9fb",border:"1px solid #e5e7eb",borderRadius:8,fontSize:12,color:"#6b7280"}}>
            <span style={{fontWeight:600,color:"#374151",marginRight:4}}>Buttons:</span>
            <span title="Check if the POC has replied">🔍 Check Reply</span>
            <span style={{color:"#d1d5db"}}>·</span>
            <span title="Send a follow-up message (available for active, no reply, follow-up, stalled)">🔁 Follow-up</span>
            <span style={{color:"#d1d5db"}}>·</span>
            <span title="Move to Monitoring — no auto follow-ups sent">👁 Monitor</span>
            <span style={{color:"#d1d5db"}}>·</span>
            <span title="Mark as resolved / closed">✓ Resolve</span>
            <span style={{color:"#d1d5db"}}>·</span>
            <span title="Reassign this issue to a different person — sends them a message automatically">↗ Reassign</span>
            <span style={{color:"#d1d5db"}}>·</span>
            <span title="Edit contact details (name, email, issue, campaign)">✏ Edit</span>
            <span style={{color:"#d1d5db"}}>·</span>
            <span title="Open full POC details and timeline">Details</span>
          </div>
          <FilterBar campaigns={campaigns} statusOptions={["sent","active","no_reply","followup","stalled"]}
            filterCampaign={filterCampaign} setFilterCampaign={setFilterCampaign}
            filterStatus={filterStatus} setFilterStatus={setFilterStatus}
            count={view.length} onClear={()=>{setFilterCampaign("");setFilterStatus("");}} />
          <SelectAllRow total={view.length} selected={selected.size} onToggle={toggleAll} />
          <BulkBar selected={selected.size}>
            {selCheckable.length>0 && <button className="btn btn-green btn-sm" disabled={checkingIds.size>0} onClick={()=>checkReplies(selCheckable)}>🔍 Check Replies ({selCheckable.length})</button>}
            {selNoReply.length>0 && <button className="btn btn-orange btn-sm" disabled={busy.fu} onClick={()=>setFollowupChannelIds(selNoReply)}>🔁 Follow-up ({selNoReply.length})</button>}
            {selResolvable.length>0 && <button className="btn btn-sm" style={{background:"#ecfeff",color:"#0e7490",border:"1px solid #a5f3fc"}} onClick={()=>bulkMonitor([...selected])}>👁 Monitor</button>}
            {selResolvable.length>0 && <button className="btn btn-purple btn-sm" onClick={()=>bulkResolve([...selected])}>✓ Resolve ({selResolvable.length})</button>}
            {selected.size>0 && <button className="btn btn-sm" style={{background:"rgba(255,255,255,.1)",color:"rgba(255,255,255,.8)",border:"1px solid rgba(255,255,255,.2)",marginLeft:"auto"}} onClick={()=>setEscalateIds([...selected])}>↗ Reassign</button>}
          </BulkBar>

          {view.length===0 ? (
            <div className="empty"><div className="empty-icon">📬</div><h3>{filterStatus||filterCampaign?"No records match filters":"Nothing in flight"}</h3><p>{!filterStatus&&!filterCampaign?"Send outreach from the Outreach tab first.":""}</p></div>
          ) : (
            <div className="tbl-wrap">
              <table>
                <thead><tr><th style={{width:32}}></th><th>POC</th><th>CAMPAIGN</th><th>STATUS</th><th>DAYS</th><th>FU</th><th>ACTIONS</th></tr></thead>
                <tbody>
                  {view.map(r=>{
                    const checking=checkingIds.has(r.id);
                    return (
                      <tr key={r.id}>
                        <td><Chk checked={selected.has(r.id)} onChange={()=>toggle(r.id)}/></td>
                        <td><Cell onClick={()=>openPocDrawer(r)} clickable><div className="poc-name">{r.contacts?.name}</div><div className="poc-email">{r.contacts?.email||"—"}</div></Cell></td>
                        <td><Cell>{r.contacts?.campaign?<span className="campaign-pill" onClick={()=>setDrawer(r.contacts.campaign)}>{r.contacts.campaign} ↗</span>:"—"}</Cell></td>
                        <td><Cell>
                          <Badge status={r.status}/>
                          {r.message_notes&&<div style={{fontSize:11,color:"#6b7280",marginTop:4,fontStyle:"italic"}}>{r.message_notes}</div>}
                          <div style={{fontSize:10,color:"#9ca3af",marginTop:2}}>{STATE_HELP[r.status]}</div>
                        </Cell></td>
                        <td><Cell><DaysChip d={days(r.reached_out_at)}/></Cell></td>
                        <td><Cell><span style={{fontSize:12,fontWeight:600,color:r.followups>0?"#d97706":"#9ca3af"}}>{r.followups||0}</span></Cell></td>
                        <td><Cell gap>
                          {["sent","active","no_reply","followup","stalled"].includes(r.status)&&<button className="btn btn-green btn-sm" disabled={checking} onClick={()=>checkReplies([r.id])} title="Check for reply">{checking?"…":"🔍"}</button>}
                          {["active","no_reply","stalled","followup"].includes(r.status)&&<button className="btn btn-orange btn-sm" disabled={busy.fu} onClick={()=>setFollowupChannelIds([r.id])} title="Send follow-up">🔁</button>}
                          <button className="btn btn-sm" style={{background:"#ecfeff",color:"#0e7490",border:"1px solid #a5f3fc",fontSize:11}} onClick={()=>bulkMonitor([r.id])} title="Acknowledge — no action needed right now">👁</button>
                          <button className="btn btn-purple btn-sm" onClick={()=>patchOne(r.id,"resolved")} title="Mark resolved">✓</button>
                          <button className="btn btn-sm" style={{fontSize:11}} onClick={()=>setEscalateIds([r.id])} title="Reassign to someone else">↗</button>
                          <button className="btn btn-sm" onClick={()=>setEditRec(r)}>✏</button>
                          <button className="btn btn-sm" style={{color:"#6b7280"}} onClick={()=>openPocDrawer(r)}>Details</button>
                        </Cell></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── REVIEW TAB ── */}
      {tab==="review" && (
        <>
          <div style={{background:"#fffbeb",border:"1px solid #fde68a",borderRadius:8,padding:"10px 14px",marginBottom:16,fontSize:13,color:"#92400e"}}>
            ⚠ The system found replies for these but wasn't confident they're related to the issue. Could be unrelated Slack messages. Read the message and decide.
          </div>
          <SelectAllRow total={view.length} selected={selected.size} onToggle={toggleAll} />
          {selected.size>0 && (
            <div style={{display:"flex",gap:8,marginBottom:12}}>
              <button className="btn btn-purple btn-sm" onClick={()=>{ [...selected].forEach(id=>decideReview(id,"resolved")); }}>✓ Resolve all selected</button>
              <button className="btn btn-red btn-sm" onClick={()=>{ [...selected].forEach(id=>decideReview(id,"declined")); }}>↩ Not a reply (all selected)</button>
            </div>
          )}
          {view.length===0 ? (
            <div className="empty"><div className="empty-icon">✨</div><h3>Nothing to review</h3><p>All replies were clear enough to classify automatically.</p></div>
          ) : view.map(r=>{
            const msgs = r.reply_messages||[];
            return (
              <div key={r.id} style={{background:"#fff",border:"1px solid #fde68a",borderLeft:"4px solid #f59e0b",borderRadius:10,padding:18,marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:16,marginBottom:12}}>
                  <div style={{flex:1}}>
                    <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4,flexWrap:"wrap"}}>
                      <Chk checked={selected.has(r.id)} onChange={()=>toggle(r.id)}/>
                      <span className="poc-name">{r.contacts?.name}</span>
                      <span style={{fontSize:12,color:"#9ca3af"}}>{r.contacts?.email}</span>
                      {r.contacts?.campaign&&<span className="campaign-pill" onClick={()=>setDrawer(r.contacts.campaign)}>{r.contacts.campaign}</span>}
                    </div>
                    <div style={{fontSize:12,color:"#6b7280",marginBottom:6}}><strong>Issue:</strong> {r.contacts?.issue}</div>
                    {r.message_notes&&<div style={{fontSize:12,color:"#6b7280",fontStyle:"italic"}}>Summary: "{r.message_notes}"</div>}
                  </div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap",flexShrink:0}}>
                    <button className="btn btn-purple btn-sm" onClick={()=>decideReview(r.id,"resolved")}>✓ Resolved</button>
                    <button className="btn btn-green btn-sm" onClick={()=>decideReview(r.id,"replied")}>Active (ongoing)</button>
                    <button className="btn btn-red btn-sm" onClick={()=>decideReview(r.id,"declined")}>↩ Not a reply</button>
                    <button className="btn btn-sm" onClick={()=>openPocDrawer(r)}>Details</button>
                  </div>
                </div>
                {msgs.length>0&&(
                  <div style={{background:"#f8f9fb",borderRadius:8,padding:12}}>
                    <div style={{fontSize:10,fontWeight:700,color:"#9ca3af",letterSpacing:1,textTransform:"uppercase",marginBottom:8}}>
                      {msgs.length} message{msgs.length!==1?"s":""} received
                    </div>
                    {msgs.map((m,i)=>(
                      <div key={i} style={{display:"flex",gap:10,marginBottom:8}}>
                        <span style={{fontSize:11,color:"#9ca3af",minWidth:20}}>#{i+1}</span>
                        <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,padding:"8px 12px",fontSize:13,lineHeight:1.5,flex:1}}>{m}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      {/* ── MONITORING TAB ── */}
      {tab==="monitoring" && (
        <>
          <div style={{background:"#ecfeff",border:"1px solid #a5f3fc",borderRadius:8,padding:"10px 14px",marginBottom:16,fontSize:13,color:"#0e7490"}}>
            👁 These are acknowledged — you're waiting on something out of your control (their side, another team, the system). No follow-ups go out automatically. If the same person + campaign issue comes up again in a future import, it just refreshes the date here — it won't create a duplicate or re-send anything.
          </div>
          <SelectAllRow total={view.length} selected={selected.size} onToggle={toggleAll} />
          {selected.size>0 && (
            <div style={{display:"flex",gap:8,marginBottom:12}}>
              <button className="btn btn-purple btn-sm" onClick={()=>bulkResolve([...selected])}>✓ Resolve selected</button>
              <button className="btn btn-sm" onClick={()=>setEscalateIds([...selected])}>↗ Reassign selected</button>
            </div>
          )}
          {view.length===0 ? (
            <div className="empty"><div className="empty-icon">👁</div><h3>Nothing being monitored</h3><p>Move a record here when you're waiting on something with no clear timeline yet.</p></div>
          ) : (
            <div className="tbl-wrap">
              <table>
                <thead><tr><th style={{width:32}}></th><th>POC</th><th>CAMPAIGN</th><th>NOTE</th><th>LAST SEEN</th><th>ACTIONS</th></tr></thead>
                <tbody>
                  {view.map(r=>(
                    <tr key={r.id}>
                      <td><Chk checked={selected.has(r.id)} onChange={()=>toggle(r.id)}/></td>
                      <td><Cell onClick={()=>openPocDrawer(r)} clickable><div className="poc-name">{r.contacts?.name}</div><div className="poc-email">{r.contacts?.email||"—"}</div></Cell></td>
                      <td><Cell>{r.contacts?.campaign?<span className="campaign-pill" onClick={()=>setDrawer(r.contacts.campaign)}>{r.contacts.campaign} ↗</span>:"—"}</Cell></td>
                      <td><Cell><div style={{fontSize:12,color:"#6b7280",fontStyle:"italic",maxWidth:240}}>{r.message_notes||"—"}</div></Cell></td>
                      <td><Cell><span style={{fontSize:12,color:"#9ca3af"}}>{r.last_action_at?new Date(r.last_action_at).toLocaleDateString():"—"}</span></Cell></td>
                      <td><Cell gap>
                        <button className="btn btn-purple btn-sm" onClick={()=>bulkResolve([r.id])}>✓</button>
                        <button className="btn btn-sm" onClick={()=>setEscalateIds([r.id])} title="Reassign to someone else">↗</button>
                        <button className="btn btn-sm" onClick={()=>openPocDrawer(r)}>Details</button>
                      </Cell></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── RESOLVED TAB ── */}
      {tab==="resolved" && (
        <>
          <FilterBar campaigns={campaigns} statusOptions={["resolved","escalated"]}
            filterCampaign={filterCampaign} setFilterCampaign={setFilterCampaign}
            filterStatus={filterStatus} setFilterStatus={setFilterStatus}
            count={view.length} onClear={()=>{setFilterCampaign("");setFilterStatus("");}} />
          <SelectAllRow total={view.length} selected={selected.size} onToggle={toggleAll} />
          {selected.size>0&&<div style={{marginBottom:10}}><button className="btn btn-red btn-sm" onClick={()=>bulkDelete([...selected])}>🗑 Delete selected</button></div>}

          {view.length===0 ? (
            <div className="empty"><div className="empty-icon">✅</div><h3>Nothing resolved yet</h3></div>
          ) : (
            <div className="tbl-wrap">
              <table>
                <thead><tr><th style={{width:32}}></th><th>POC</th><th>CAMPAIGN</th><th>STATUS</th><th>CLOSED</th><th>ACTIONS</th></tr></thead>
                <tbody>
                  {view.map(r=>(
                    <tr key={r.id}>
                      <td><Chk checked={selected.has(r.id)} onChange={()=>toggle(r.id)}/></td>
                      <td><Cell onClick={()=>openPocDrawer(r)} clickable><div className="poc-name">{r.contacts?.name}</div><div className="poc-email">{r.contacts?.email||"—"}</div></Cell></td>
                      <td><Cell>{r.contacts?.campaign?<span className="campaign-pill" onClick={()=>setDrawer(r.contacts.campaign)}>{r.contacts.campaign} ↗</span>:"—"}</Cell></td>
                      <td><Cell><Badge status={r.status}/>{r.message_notes&&<div style={{fontSize:11,color:"#6b7280",marginTop:4,fontStyle:"italic"}}>{r.message_notes}</div>}</Cell></td>
                      <td><Cell><span style={{fontSize:12,color:"#9ca3af"}}>{r.last_action_at?new Date(r.last_action_at).toLocaleDateString():"—"}</span></Cell></td>
                      <td><Cell gap>
                        <button className="btn btn-sm" onClick={()=>openPocDrawer(r)}>Details</button>
                        <button className="btn btn-red btn-sm" onClick={()=>bulkDelete([r.id])}>🗑</button>
                      </Cell></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── POC Detail Drawer (all tabs) ── */}
      {pocDrawer && (
        <>
          <div className="drawer-overlay" onClick={()=>setPocDrawer(null)}/>
          <div className="drawer">
            <div className="drawer-header">
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                <div>
                  <div style={{fontSize:10,fontWeight:700,color:"#9ca3af",letterSpacing:1,textTransform:"uppercase",marginBottom:4}}>POC Details</div>
                  <div style={{fontSize:18,fontWeight:700}}>{pocDrawer.rec.contacts?.name}</div>
                  {pocDrawer.rec.contacts?.email&&<div style={{fontSize:13,color:"#6b7280"}}>{pocDrawer.rec.contacts.email}</div>}
                </div>
                <button className="btn btn-sm" onClick={()=>setPocDrawer(null)}>✕</button>
              </div>
              <div style={{marginTop:12}}>
                <Badge status={pocDrawer.rec.status}/>
                <div style={{fontSize:12,color:"#9ca3af",marginTop:4}}>{STATE_HELP[pocDrawer.rec.status]}</div>
              </div>
            </div>
            <div className="drawer-body">
              <div className="drawer-section">
                <div className="drawer-section-title">Issue</div>
                <div style={{background:"#f8f9fb",borderRadius:8,padding:"10px 12px",fontSize:13,color:"#374151",lineHeight:1.5}}>{pocDrawer.rec.contacts?.issue}</div>
              </div>
              {pocDrawer.rec.contacts?.campaign&&(
                <div className="drawer-section">
                  <div className="drawer-section-title">Campaign</div>
                  <span className="campaign-pill" onClick={()=>{setPocDrawer(null);setDrawer(pocDrawer.rec.contacts.campaign);}}>{pocDrawer.rec.contacts.campaign} — view all ↗</span>
                </div>
              )}
              {/* Replies */}
              {pocDrawer.rec.reply_messages?.length>0&&(
                <div className="drawer-section">
                  <div className="drawer-section-title">Replies from POC</div>
                  {pocDrawer.rec.reply_messages.map((m,i)=>(
                    <div key={i} className="msg-bubble">{m}</div>
                  ))}
                </div>
              )}
              {/* Edit details — always available, any status */}
              <div className="drawer-section">
                <div className="drawer-section-title">Contact Details</div>
                <button className="btn btn-sm" onClick={()=>setEditRec(pocDrawer.rec)}>✏ Edit Name / Email / Campaign / Issue</button>
                {!pocDrawer.rec.contacts?.email && (
                  <p style={{fontSize:11,color:"#f97316",marginTop:6}}>No email on file — add one here to enable email outreach and follow-ups.</p>
                )}
              </div>
              {/* Quick actions */}
              {!["resolved","escalated"].includes(pocDrawer.rec.status)&&(
                <div className="drawer-section">
                  <div className="drawer-section-title">Quick Actions</div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    {["sent","active","no_reply","followup","stalled"].includes(pocDrawer.rec.status)&&(
                      <button className="btn btn-green btn-sm" disabled={checkingIds.has(pocDrawer.rec.id)} onClick={()=>checkReplies([pocDrawer.rec.id])}>🔍 Check Reply</button>
                    )}
                    {["active","no_reply","stalled","followup"].includes(pocDrawer.rec.status)&&(
                      <button className="btn btn-orange btn-sm" onClick={()=>{setFollowupChannelIds([pocDrawer.rec.id]);setPocDrawer(null);}}>🔁 Follow-up</button>
                    )}
                    <button className="btn btn-purple btn-sm" onClick={()=>patchOne(pocDrawer.rec.id,"resolved")}>✓ Resolve</button>
                    <button className="btn btn-sm" style={{background:"#ecfeff",color:"#0e7490",border:"1px solid #a5f3fc"}} onClick={()=>bulkMonitor([pocDrawer.rec.id])}>👁 Monitor</button>
                    <button className="btn btn-sm" onClick={()=>{setEscalateIds([pocDrawer.rec.id]);setPocDrawer(null);}}>↗ Reassign</button>
                  </div>
                </div>
              )}
              {/* Timeline */}
              <div className="drawer-section">
                <div className="drawer-section-title">Timeline</div>
                {pocDrawer.events===null?(
                  <p style={{fontSize:12,color:"#9ca3af"}}>Loading…</p>
                ):pocDrawer.events.length===0?(
                  <p style={{fontSize:12,color:"#9ca3af"}}>No events yet.</p>
                ):pocDrawer.events.map(e=>{
                  const dotColor = {created:"#9ca3af",sent:"#3b82f6",reply_checked:"#f59e0b",reply_classified:"#10b981",followup_sent:"#f97316",resolved:"#7c3aed",status_changed:"#6b7280",escalated_stalled:"#ef4444"}[e.action]||"#d1d5db";
                  return (
                    <div key={e.id} className="timeline-item">
                      <div className="timeline-dot" style={{background:dotColor,boxShadow:`0 0 0 3px ${dotColor}33`}}/>
                      <div className="timeline-content">
                        <div className="timeline-action">{e.action.replace(/_/g," ")}</div>
                        <div className="timeline-ts">{new Date(e.created_at).toLocaleString()}</div>
                        {e.new_status&&<div style={{fontSize:11,color:"#6b7280"}}>→ {e.new_status.replace(/_/g," ")}</div>}
                        {e.payload?.summary&&<div className="timeline-note">"{e.payload.summary}"</div>}
                        {e.payload?.note&&<div className="timeline-note">Note: {e.payload.note}</div>}
                        {e.payload?.escalateTo?.name&&<div style={{fontSize:11,color:"#2563eb"}}>→ {e.payload.escalateTo.name}</div>}
                        {e.payload?.messages?.length>0&&(
                          <div style={{marginTop:6}}>
                            {e.payload.messages.map((m,i)=><div key={i} className="msg-bubble" style={{fontSize:12,marginTop:4}}>{m}</div>)}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}

      {/* Campaign Drawer */}
      {drawer&&<CampaignDrawer campaign={drawer} onClose={()=>setDrawer(null)} onStatusChange={async(id,status)=>{await patchOne(id,status);setDrawer(null);}}/>}

      {/* Edit modal (outreach tab only) */}
      {editRec&&<EditModal contact={editRec.contacts} onClose={()=>setEditRec(null)} onSaved={()=>{loadTab(tab);if(pocDrawer?.rec.id===editRec.id)openPocDrawer({...editRec});}}/>}

      {/* Reassign modal */}
      {escalateIds&&<EscalateModal ids={escalateIds} records={currentRecs} onClose={()=>setEscalateIds(null)} onDone={()=>{reload();loadTab("outreach");}}/>}

      {/* Follow-up channel picker */}
      {followupChannelIds && (
        <div className="modal-overlay">
          <div className="modal" style={{ width:380 }}>
            <h3>Send Follow-up Via</h3>
            <p style={{ fontSize:13, color:"#6b7280", marginBottom:18 }}>
              Choose a channel for this follow-up. If they're not checking Slack, email is a good way to keep them accountable.
            </p>
            <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom:18 }}>
              <button className="btn btn-sm" style={{ justifyContent:"flex-start", padding:"12px 14px" }} disabled={busy.fu} onClick={()=>sendFollowups(followupChannelIds, "slack")}>💬 Slack DM</button>
              <button className="btn btn-sm" style={{ justifyContent:"flex-start", padding:"12px 14px" }} disabled={busy.fu} onClick={()=>sendFollowups(followupChannelIds, "email")}>📧 Email</button>
            </div>
            <div style={{ display:"flex", justifyContent:"flex-end" }}>
              <button className="btn" onClick={()=>setFollowupChannelIds(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Send progress */}
      <SendProgressModal progress={progress} onClose={()=>setProgress(null)}/>

      {toast&&<div className="toast" style={{background:toast.type==="error"?"#dc2626":"#1e293b"}}>{toast.msg}</div>}
    </div>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────
function Chk({ checked, onChange }) {
  return <div style={{padding:"12px 8px 12px 14px"}}><input type="checkbox" style={{width:"auto"}} checked={checked} onChange={onChange}/></div>;
}

function Cell({ children, gap, onClick, clickable }) {
  return (
    <div className="row-main" style={{ cursor:clickable?"pointer":"default", gap:gap?6:undefined }} onClick={onClick}>
      {children}
    </div>
  );
}

function SelectAllRow({ total, selected, onToggle }) {
  if (total === 0) return null;
  return (
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
      <label style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",fontSize:13,fontWeight:500}}>
        <input type="checkbox" style={{width:"auto"}} checked={selected===total&&total>0} onChange={onToggle}/>
        {selected>0?`${selected} selected`:`Select all (${total})`}
      </label>
    </div>
  );
}

function FilterBar({ campaigns, statusOptions, filterCampaign, setFilterCampaign, filterStatus, setFilterStatus, count, onClear }) {
  return (
    <div style={{display:"flex",gap:10,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
      <select value={filterStatus} onChange={e=>setFilterStatus(e.target.value)} style={{width:"auto",minWidth:160}}>
        <option value="">All statuses</option>
        {statusOptions.map(s=><option key={s} value={s}>{SC[s]?.label||s}</option>)}
      </select>
      {campaigns.length>0&&(
        <select value={filterCampaign} onChange={e=>setFilterCampaign(e.target.value)} style={{width:"auto",minWidth:160}}>
          <option value="">All campaigns</option>
          {campaigns.map(c=><option key={c} value={c}>{c}</option>)}
        </select>
      )}
      {(filterStatus||filterCampaign)&&<button className="btn btn-sm" onClick={onClear}>✕ Clear</button>}
      <span style={{marginLeft:"auto",fontSize:12,color:"#9ca3af"}}>{count} records</span>
    </div>
  );
}
