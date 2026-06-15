"use client";
import { useEffect, useState, useCallback } from "react";

const SC = {
  pending:        { label:"Pending",           color:"#374151", bg:"#f3f4f6", border:"#e5e7eb", dot:"#9ca3af" },
  sent:           { label:"Sent",              color:"#1d4ed8", bg:"#eff6ff", border:"#bfdbfe", dot:"#3b82f6" },
  awaiting_reply: { label:"Awaiting Reply",    color:"#1d4ed8", bg:"#eff6ff", border:"#bfdbfe", dot:"#3b82f6" },
  replied:        { label:"Replied",           color:"#065f46", bg:"#ecfdf5", border:"#a7f3d0", dot:"#10b981" },
  needs_review:   { label:"Needs Review",      color:"#92400e", bg:"#fffbeb", border:"#fde68a", dot:"#f59e0b" },
  followup:       { label:"Follow-up Sent",    color:"#92400e", bg:"#fff7ed", border:"#fed7aa", dot:"#f97316" },
  resolved_auto:  { label:"Confirm Resolved",  color:"#5b21b6", bg:"#f5f3ff", border:"#ddd6fe", dot:"#8b5cf6" },
  resolved:       { label:"Resolved",          color:"#4c1d95", bg:"#ede9fe", border:"#c4b5fd", dot:"#7c3aed" },
  no_reply:       { label:"No Reply",          color:"#991b1b", bg:"#fef2f2", border:"#fecaca", dot:"#ef4444" },
  stalled:        { label:"Stalled",           color:"#7f1d1d", bg:"#fef2f2", border:"#fca5a5", dot:"#dc2626" },
};

function Badge({ status }) {
  const c = SC[status] || SC.pending;
  return <span className="badge" style={{ color:c.color, background:c.bg, border:`1px solid ${c.border}` }}><span className="badge-dot" style={{ background:c.dot }}/>{c.label}</span>;
}

function days(d) { if (!d) return null; return Math.floor((Date.now()-new Date(d).getTime())/86400000); }
function DaysChip({ d }) {
  if (d===null||d===undefined) return <span style={{color:"#9ca3af"}}>—</span>;
  if (d===0) return <span style={{color:"#9ca3af",fontSize:12}}>Today</span>;
  const cls = d>14?"days-crit":d>7?"days-warn":d>3?"days-warn":"days-ok";
  return <span className={cls}>{d}d{d>7?" ⚠":""}</span>;
}

const ACTIVE = ["sent","awaiting_reply","followup","no_reply","stalled"];
const NEEDS_ACTION = ["replied","needs_review","resolved_auto"];
const EVENT_COLORS = { created:"#9ca3af",sent:"#3b82f6",reply_checked:"#f59e0b",reply_classified:"#10b981",followup_sent:"#f97316",resolved:"#7c3aed",status_changed:"#6b7280",note_added:"#6b7280",escalated_stalled:"#ef4444" };

export default function Tracker() {
  const [records, setRecords]         = useState([]);
  const [section, setSection]         = useState("outreach"); // outreach | followups | review | import | resolved
  const [selected, setSelected]       = useState(new Set());
  const [channel, setChannel]         = useState("slack");
  const [busy, setBusy]               = useState({});
  const [toast, setToast]             = useState(null);
  const [csvText, setCsvText]         = useState("");
  const [sheetUrl, setSheetUrl]       = useState("");
  const [drawer, setDrawer]           = useState(null);
  const [checkingIds, setCheckingIds] = useState(new Set());
  const [filterStatus, setFilterStatus]     = useState("");
  const [filterCampaign, setFilterCampaign] = useState("");
  const [sortBy, setSortBy]           = useState("created_at");
  const [sortDir, setSortDir]         = useState("desc");

  const [reviewRecords, setReviewRecords] = useState([]);

  const loadReview = useCallback(async () => {
    const r = await fetch("/api/review").then(r => r.json());
    setReviewRecords(r.records || []);
  }, []);

  useEffect(() => { if (section === "review") loadReview(); }, [section, loadReview]);

  const load = useCallback(async () => {
    const r = await fetch("/api/outreach").then(r=>r.json());
    setRecords(r.records||[]);
  },[]);
  useEffect(()=>{ load(); },[load]);

  function show(msg,type="info"){ setToast({msg,type}); setTimeout(()=>setToast(null),5000); }

  // Counts
  const counts = {};
  records.forEach(r=>counts[r.status]=(counts[r.status]||0)+1);
  const pendingCount   = counts["pending"]||0;
  const followupCount  = counts["no_reply"]||0;
  const reviewCount    = (counts["replied"]||0)+(counts["needs_review"]||0)+(counts["resolved_auto"]||0);
  const resolvedCount  = counts["resolved"]||0;

  const campaigns = [...new Set(records.map(r=>r.contacts?.campaign).filter(Boolean))];

  // Section → records mapping
  function sectionRecords() {
    let base;
    if (section==="outreach")  base = records.filter(r=>r.status==="pending"||ACTIVE.includes(r.status));
    else if (section==="followups") base = records.filter(r=>r.status==="no_reply"||r.status==="stalled");
    else if (section==="review")    base = reviewRecords; // uses enriched data from /api/review
    else if (section==="resolved")  base = records.filter(r=>r.status==="resolved");
    else return [];

    if (filterStatus)   base = base.filter(r=>r.status===filterStatus);
    if (filterCampaign) base = base.filter(r=>r.contacts?.campaign===filterCampaign);

    return [...base].sort((a,b)=>{
      let av,bv;
      if (sortBy==="days")      { av=days(a.reached_out_at)??-1; bv=days(b.reached_out_at)??-1; }
      else if (sortBy==="followups") { av=a.followups; bv=b.followups; }
      else { av=new Date(a.created_at).getTime(); bv=new Date(b.created_at).getTime(); }
      return sortDir==="desc"?bv-av:av-bv;
    });
  }

  const view = sectionRecords();
  const selectableIds = view.map(r=>r.id); // all rows selectable
  const selPending    = [...selected].filter(id=>records.find(r=>r.id===id)?.status==="pending");
  const selCheckable  = [...selected].filter(id=>["sent","awaiting_reply","followup","no_reply"].includes(records.find(r=>r.id===id)?.status));
  const selResolvable = [...selected].filter(id=>!["resolved"].includes(records.find(r=>r.id===id)?.status));

  function toggleAll(){ setSelected(s=>s.size===selectableIds.length?new Set():new Set(selectableIds)); }
  function toggle(id){ setSelected(s=>{const n=new Set(s);n.has(id)?n.delete(id):n.add(id);return n;}); }
  function sortToggle(col){ if(sortBy===col)setSortDir(d=>d==="desc"?"asc":"desc");else{setSortBy(col);setSortDir("desc");} }
  function SSort({col}){ return <span style={{fontSize:10,marginLeft:2}}>{sortBy===col?(sortDir==="desc"?"↓":"↑"):""}</span>; }

  // Actions
  async function doImport(){
    setBusy(b=>({...b,import:true}));
    const body=sheetUrl.trim()?{sheetUrl:sheetUrl.trim()}:{csvText};
    const r=await fetch("/api/contacts/import",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(r=>r.json());
    setBusy(b=>({...b,import:false}));
    if(r.error)return show("⚠ "+r.error,"error");
    setCsvText("");setSheetUrl("");
    show(`✅ Imported ${r.created} POC(s)`);
    setSection("outreach");load();
  }

  async function bulkSend(){
    setBusy(b=>({...b,send:true}));
    const r=await fetch("/api/outreach/bulk-send",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ids:selPending,channel})}).then(r=>r.json());
    setBusy(b=>({...b,send:false}));setSelected(new Set());
    if(r.error)return show("⚠ "+r.error,"error");
    const ok=r.results?.filter(x=>x.ok).length||0;
    const failed=r.results?.filter(x=>!x.ok)||[];
    show(`✅ Sent ${ok}${failed.length?` · ⚠ ${failed[0].error}`:""}`);
    load();
  }

  async function checkReply(id){
    setCheckingIds(s=>new Set([...s,id]));
    const r=await fetch("/api/outreach/bulk-update",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ids:[id],action:"check_reply"})}).then(r=>r.json());
    setCheckingIds(s=>{const n=new Set(s);n.delete(id);return n;});
    const res=r.results?.[0];
    if(res?.error)show(`⚠ ${res.error}`,"error");
    else show(`✅ ${res?.newStatus?.replace(/_/g," ")||"checked"}`);
    load();
  }

  async function sendFollowup(ids){
    setBusy(b=>({...b,fu:true}));
    const r=await fetch("/api/followups/send",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ids})}).then(r=>r.json());
    setBusy(b=>({...b,fu:false}));setSelected(new Set());
    const ok=r.results?.filter(x=>x.ok).length||0;
    const failed=r.results?.filter(x=>!x.ok)||[];
    show(`✅ ${ok} follow-up(s) sent${failed.length?` · ⚠ ${failed[0].error}`:""}`);
    load();
  }

  async function bulkDelete() {
    const ids = [...selected];
    if (!confirm(`Delete ${ids.length} record(s)? This cannot be undone.`)) return;
    setBusy(b=>({...b,del:true}));
    await fetch("/api/outreach/bulk-update", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ ids, action:"delete" }) });
    setBusy(b=>({...b,del:false}));
    setSelected(new Set());
    show(`🗑 Deleted ${ids.length} record(s)`);
    load();
  }

  async function deleteOne(id) {
    if (!confirm("Delete this outreach? This cannot be undone.")) return;
    const r = await fetch(`/api/outreach/${id}`, { method: "DELETE" }).then(r => r.json());
    if (r.error) show("⚠ " + r.error, "error");
    else show("🗑 Deleted"); load();
  }

  async function resolveOne(id){
    await fetch(`/api/outreach/${id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({status:"resolved"})});
    show("✅ Resolved");load();
  }

  async function bulkResolve(){
    setBusy(b=>({...b,resolve:true}));
    await fetch("/api/outreach/bulk-update",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ids:selResolvable,action:"resolve"})});
    setBusy(b=>({...b,resolve:false}));setSelected(new Set());show("✅ Resolved");load();
  }

  async function bulkCheck(){
    setBusy(b=>({...b,check:true}));
    await fetch("/api/outreach/bulk-update",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ids:selCheckable,action:"check_reply"})});
    setBusy(b=>({...b,check:false}));setSelected(new Set());show("✅ Replies checked");load();
  }

  async function decideReview(id,decision){
    await fetch("/api/review",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id,decision})});
    show(decision==="declined"?"↩ Moved back to follow-up queue":"✅ Updated");
    load(); loadReview();
  }

  async function openDrawer(rec){
    setDrawer({record:rec,events:null});
    const r=await fetch(`/api/outreach/${rec.id}/history`).then(r=>r.json());
    setDrawer({record:rec,events:r.events||[]});
  }

  const navSections = [
    { id:"import",    label:"➕ Import",      badge:null },
    { id:"outreach",  label:"Outreach",       badge: pendingCount > 0 ? { n: pendingCount, color:"#2563eb" } : null },
    { id:"followups", label:"Follow-ups",     badge: followupCount > 0 ? { n: followupCount, color:"#ef4444" } : null },
    { id:"review",    label:"Review",         badge: reviewCount > 0 ? { n: reviewCount, color:"#7c3aed" } : null },
    { id:"resolved",  label:"Resolved",       badge: resolvedCount > 0 ? { n: resolvedCount, color:"#6b7280" } : null },
  ];

  return (
    <div>
      {/* Stat strip */}
      <div className="stat-grid" style={{ marginBottom:20 }}>
        {[
          {key:"pending",  label:"Pending",     color:"#2563eb"},
          {key:"sent",     label:"Sent",        color:"#3b82f6"},
          {key:"no_reply", label:"No Reply",    color:"#ef4444"},
          {key:"replied",  label:"Replied",     color:"#059669"},
          {key:"resolved_auto",label:"Confirm?",color:"#7c3aed"},
          {key:"resolved", label:"Resolved",    color:"#6b7280"},
        ].map(({key,label,color})=>(
          <div key={key} className="stat-card" style={{cursor:"pointer"}}
            onClick={()=>{ setFilterStatus(key); setSection(key==="pending"||ACTIVE.includes(key)?"outreach":key==="no_reply"?"followups":NEEDS_ACTION.includes(key)?"review":"resolved"); }}>
            <div className="stat-num" style={{color}}>{counts[key]||0}</div>
            <div className="stat-label">{label}</div>
          </div>
        ))}
      </div>

      {/* Section tabs */}
      <div className="tabs">
        {navSections.map(s=>(
          <button key={s.id} className={`tab-btn ${section===s.id?"active":""}`}
            onClick={()=>{ setSection(s.id); setSelected(new Set()); setFilterStatus(""); setFilterCampaign(""); }}>
            {s.label}
            {s.badge && <span style={{ background:s.badge.color, color:"#fff", borderRadius:99, fontSize:10, fontWeight:700, padding:"1px 6px", marginLeft:4 }}>{s.badge.n}</span>}
          </button>
        ))}
      </div>

      {/* ── IMPORT ── */}
      {section==="import" && (
        <div className="import-card">
          <h2 style={{fontSize:15,fontWeight:600,marginBottom:4}}>Import POCs from a table</h2>
          <p style={{fontSize:13,color:"#6b7280",marginBottom:20}}>Paste tab-separated or CSV data. Columns: <strong>Campaign</strong>, <strong>POC Name</strong>, <strong>Email</strong>, <strong>Issue</strong>.</p>
          <div className="example-box">{"Campaign\tPOC Name\tEmail (optional)\tIssue\nAudible Views\tKirsten Menezes\t\tCampaign crossed posting end date on DMS\nQ2 GST Recon\tPriya Sharma\tpriya@corp.in\tMissing GST entries for March"}</div>
          <p style={{fontSize:12,color:"#9ca3af",marginBottom:12}}>Email is optional for Slack outreach — we'll find them by name in your workspace. Required only for email outreach.</p>
          <div style={{marginBottom:12}}>
            <label>Google Sheet URL (optional)</label>
            <input placeholder="https://docs.google.com/spreadsheets/d/…" value={sheetUrl} onChange={e=>setSheetUrl(e.target.value)}/>
          </div>
          <div style={{marginBottom:16}}>
            <label>Or paste table directly</label>
            <textarea rows={6} placeholder="Paste your table here…" value={csvText} onChange={e=>setCsvText(e.target.value)} style={{resize:"vertical"}}/>
          </div>
          <button className="btn btn-primary" disabled={busy.import||(!csvText.trim()&&!sheetUrl.trim())} onClick={doImport}>
            {busy.import?"Importing…":"Import POCs →"}
          </button>
        </div>
      )}

      {/* ── FOLLOW-UPS SECTION ── */}
      {section==="followups" && (
        <div>
          <div style={{display:"flex",gap:10,marginBottom:16,alignItems:"center"}}>
            <p style={{fontSize:13,color:"#6b7280",flex:1}}>POCs with no reply. After 3 follow-ups a record becomes Stalled.</p>
            {view.length>0&&<>
              <button className="btn btn-orange" disabled={busy.fu} onClick={()=>sendFollowup(view.map(r=>r.id))}>
                {busy.fu?"Sending…":`🔁 Send All Follow-ups (${view.length})`}
              </button>
              {selected.size>0&&<button className="btn btn-orange" disabled={busy.fu} onClick={()=>sendFollowup([...selected])}>Send Selected ({selected.size})</button>}
            </>}
          </div>
          {view.length===0?(
            <div className="empty"><div className="empty-icon">🎉</div><h3>No follow-ups due</h3><p>Everyone has replied or been resolved.</p></div>
          ):(
            <div className="tbl-wrap">
              <table>
                <thead><tr><th style={{width:32}}></th><th>POC</th><th>CAMPAIGN</th><th>ISSUE</th><th>CHANNEL</th><th>SENT</th><th>FU #</th><th>ACTIONS</th></tr></thead>
                <tbody>
                  {view.map(r=>(
                    <tr key={r.id}>
                      <td><input type="checkbox" style={{width:"auto"}} checked={selected.has(r.id)} onChange={()=>toggle(r.id)}/></td>
                      <td><div className="poc-name">{r.contacts?.name}</div><div className="poc-email">{r.contacts?.email}</div></td>
                      <td>{r.contacts?.campaign&&<span className="campaign-pill">{r.contacts.campaign}</span>}</td>
                      <td><div className="issue-text">{r.contacts?.issue}</div></td>
                      <td style={{fontSize:12,color:"#6b7280"}}>{r.channel==="slack"?"💬 Slack":"📧 Email"}</td>
                      <td style={{fontSize:12,color:"#6b7280"}}>{r.reached_out_at?new Date(r.reached_out_at).toLocaleDateString():"—"}</td>
                      <td style={{fontSize:12,fontWeight:600,color:r.followups>=2?"#dc2626":"#d97706"}}>{r.followups}</td>
                      <td><div style={{display:"flex",gap:6}}>
                        <button className="btn btn-sm btn-green" onClick={()=>checkReply(r.id)} disabled={checkingIds.has(r.id)}>{checkingIds.has(r.id)?"…":"🔍 Check"}</button>
                        <button className="btn btn-sm btn-purple" onClick={()=>resolveOne(r.id)}>✓ Resolve</button>
                      </div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── REVIEW SECTION ── */}
      {section==="review" && (
        <ReviewSection
          records={view}
          onDecide={decideReview}
          onDrawer={openDrawer}
        />
      )}

      {/* ── OUTREACH + RESOLVED ── */}
      {(section==="outreach"||section==="resolved") && (
        <>
          {/* Filters */}
          <div style={{display:"flex",gap:10,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
            <select value={filterStatus} onChange={e=>setFilterStatus(e.target.value)} style={{width:"auto",minWidth:160}}>
              <option value="">All statuses</option>
              {Object.entries(SC).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
            </select>
            {campaigns.length>0&&(
              <select value={filterCampaign} onChange={e=>setFilterCampaign(e.target.value)} style={{width:"auto",minWidth:160}}>
                <option value="">All campaigns</option>
                {campaigns.map(c=><option key={c} value={c}>{c}</option>)}
              </select>
            )}
            {(filterStatus||filterCampaign)&&<button className="btn btn-sm" onClick={()=>{setFilterStatus("");setFilterCampaign("");}}>✕ Clear</button>}
            <span style={{marginLeft:"auto",fontSize:12,color:"#9ca3af"}}>{view.length} record{view.length!==1?"s":""}</span>
          </div>

          {/* Bulk bar */}
          {selectableIds.length>0&&(
            <div className="bulk-bar">
              <label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer"}}>
                <input type="checkbox" style={{width:"auto",accentColor:"#fff"}} checked={selected.size===selectableIds.length&&selectableIds.length>0} onChange={toggleAll}/>
                <span style={{fontSize:13,color:"#fff",fontWeight:500}}>{selected.size>0?`${selected.size} selected`:`Select all (${selectableIds.length})`}</span>
              </label>
              {selPending.length>0&&<>
                <div className="channel-toggle">
                  <button className={`ch-btn ${channel==="slack"?"active":""}`} onClick={()=>setChannel("slack")}>💬 Slack</button>
                  <button className={`ch-btn ${channel==="email"?"active":""}`} onClick={()=>setChannel("email")}>📧 Email</button>
                </div>
                <button className="btn btn-primary btn-sm" disabled={busy.send} onClick={bulkSend}>{busy.send?"Sending…":`Send ${selPending.length} via ${channel}`}</button>
              </>}
              {selCheckable.length>0&&<button className="btn btn-sm" style={{background:"rgba(255,255,255,.15)",color:"#fff",border:"1px solid rgba(255,255,255,.2)"}} disabled={busy.check} onClick={bulkCheck}>{busy.check?"…":`🔍 Check Replies (${selCheckable.length})`}</button>}
              {selResolvable.length>0&&<button className="btn btn-sm" style={{background:"rgba(255,255,255,.1)",color:"rgba(255,255,255,.8)",border:"1px solid rgba(255,255,255,.15)"}} disabled={busy.resolve} onClick={bulkResolve}>{busy.resolve?"…":`✓ Resolve (${selResolvable.length})`}</button>}
              {selected.size>0&&<button className="btn btn-sm" style={{background:"rgba(220,38,38,.3)",color:"#fca5a5",border:"1px solid rgba(220,38,38,.4)",marginLeft:"auto"}} disabled={busy.del} onClick={bulkDelete}>{busy.del?"…":`🗑 Delete (${selected.size})`}</button>}
            </div>
          )}

          {/* Table */}
          {view.length===0?(
            <div className="empty">
              <div className="empty-icon">{section==="resolved"?"✅":"📬"}</div>
              <h3>{filterStatus||filterCampaign?"No records match filters":section==="resolved"?"Nothing resolved yet":"No outreach yet"}</h3>
              <p>{!filterStatus&&!filterCampaign&&section!=="resolved"?"Import a table and send outreach to get started.":""}</p>
            </div>
          ):(
            <div className="tbl-wrap">
              <table>
                <thead><tr>
                  <th style={{width:32}}></th>
                  <th>POC</th><th>CAMPAIGN</th><th>ISSUE</th><th>STATUS</th>
                  <th style={{cursor:"pointer",userSelect:"none"}} onClick={()=>sortToggle("days")}>DAYS<SSort col="days"/></th>
                  <th style={{cursor:"pointer",userSelect:"none"}} onClick={()=>sortToggle("followups")}>FU<SSort col="followups"/></th>
                  <th>ACTIONS</th>
                </tr></thead>
                <tbody>
                  {view.map(r=>{
                    const canSel=selectableIds.includes(r.id);
                    const d=days(r.reached_out_at);
                    const checking=checkingIds.has(r.id);
                    const needsConfirm=r.status==="resolved_auto"||r.status==="replied"||r.status==="needs_review";
                    return(
                      <tr key={r.id} style={{background:needsConfirm?"#fafaf5":undefined}}>
                        <td style={{width:32}}>{canSel&&<input type="checkbox" style={{width:"auto"}} checked={selected.has(r.id)} onChange={()=>toggle(r.id)}/>}</td>
                        <td><div className="poc-name">{r.contacts?.name}</div><div className="poc-email">{r.contacts?.email}</div></td>
                        <td>{r.contacts?.campaign&&<span className="campaign-pill">{r.contacts.campaign}</span>}</td>
                        <td><div className="issue-text">{r.contacts?.issue}</div>{r.message_notes&&<div style={{fontSize:11,color:"#6b7280",marginTop:4,fontStyle:"italic"}}>💬 {r.message_notes}</div>}</td>
                        <td><Badge status={r.status}/></td>
                        <td><DaysChip d={d}/></td>
                        <td style={{color:r.followups>0?"#d97706":"#9ca3af",fontWeight:600,fontSize:12}}>{r.followups||0}</td>
                        <td>
                          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                            {["sent","awaiting_reply","followup","no_reply"].includes(r.status)&&<button className="btn btn-sm btn-green" disabled={checking} onClick={()=>checkReply(r.id)}>{checking?"…":"🔍 Check"}</button>}
                            {needsConfirm&&<button className="btn btn-sm btn-purple" onClick={()=>setSection("review")}>Review →</button>}
                            {!["resolved","resolved_auto","replied","needs_review"].includes(r.status)&&<button className="btn btn-sm" style={{color:"#6b7280"}} onClick={()=>resolveOne(r.id)}>✓</button>}
                            <button className="btn btn-sm" onClick={()=>openDrawer(r)}>History</button>
                            <button className="btn btn-sm" style={{color:"#ef4444",borderColor:"#fecaca"}} onClick={()=>deleteOne(r.id)} title="Delete this outreach">🗑</button>
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
      {drawer&&(
        <div className="drawer">
          <div className="drawer-header">
            <div><h3>{drawer.record.contacts?.name}</h3><div style={{fontSize:12,color:"#6b7280"}}>{drawer.record.contacts?.email}</div></div>
            <button className="btn btn-sm" onClick={()=>setDrawer(null)}>✕ Close</button>
          </div>
          <div className="drawer-body">
            <div style={{background:"#f8f9fb",borderRadius:8,padding:"10px 12px",marginBottom:16}}>
              <div style={{fontSize:11,fontWeight:600,color:"#9ca3af",marginBottom:4,textTransform:"uppercase",letterSpacing:".4px"}}>Issue</div>
              <div style={{fontSize:13,color:"#374151"}}>{drawer.record.contacts?.issue}</div>
              {drawer.record.contacts?.campaign&&<span className="campaign-pill" style={{marginTop:6,display:"inline-block"}}>{drawer.record.contacts.campaign}</span>}
            </div>
            {drawer.events===null?<p style={{color:"#9ca3af",fontSize:13}}>Loading…</p>:drawer.events.length===0?<p style={{color:"#9ca3af",fontSize:13}}>No events yet.</p>:
              drawer.events.map(e=>(
                <div className="event-item" key={e.id}>
                  <span className="event-dot" style={{background:EVENT_COLORS[e.action]||"#9ca3af"}}/>
                  <div>
                    <div className="event-action">{e.action.replace(/_/g," ")}</div>
                    <div className="event-ts">{new Date(e.created_at).toLocaleString()}</div>
                    {e.new_status&&<div style={{fontSize:11,color:"#6b7280"}}>→ {e.new_status.replace(/_/g," ")}</div>}
                    {e.payload?.summary&&<div className="event-note">"{e.payload.summary}"</div>}
                  </div>
                </div>
              ))
            }
          </div>
        </div>
      )}

      {toast&&<div className="toast" style={{background:toast.type==="error"?"#dc2626":"#111827"}}>{toast.msg}</div>}
    </div>
  );
}

function ReviewSection({ records, onDecide, onDrawer }) {
  const statusLabel = {
    resolved_auto: { icon:"🤖", text:"System thinks this is resolved", color:"#7c3aed", border:"#ddd6fe", accent:"#7c3aed" },
    replied:       { icon:"✅", text:"Reply detected",                  color:"#065f46", border:"#a7f3d0", accent:"#10b981" },
    needs_review:  { icon:"❓", text:"Ambiguous — needs your call",     color:"#92400e", border:"#fde68a", accent:"#f59e0b" },
  };

  if (records.length === 0) return (
    <div className="empty"><div className="empty-icon">✨</div><h3>Nothing to review</h3><p>All reply detections were clear enough to handle automatically.</p></div>
  );

  return (
    <div>
      <p style={{fontSize:13,color:"#6b7280",marginBottom:16}}>
        Replies the system detected or wasn't confident about. <strong>You make the final call</strong> — nothing moves to Resolved without your confirmation.
      </p>
      {records.map(r => {
        const s = statusLabel[r.status] || statusLabel.needs_review;
        const msgs = r.reply_messages || [];
        return (
          <div key={r.id} style={{background:"#fff",border:`1px solid ${s.border}`,borderLeft:`4px solid ${s.accent}`,borderRadius:10,padding:20,marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:16,marginBottom:12}}>
              <div>
                <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}>
                  <span style={{fontWeight:700,fontSize:14}}>{r.contacts?.name}</span>
                  <span style={{fontSize:12,color:"#9ca3af"}}>{r.contacts?.email}</span>
                  {r.contacts?.campaign&&<span className="campaign-pill">{r.contacts.campaign}</span>}
                </div>
                <div style={{fontSize:12,color:"#6b7280",marginBottom:8}}><strong>Issue:</strong> {r.contacts?.issue}</div>
                <div style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:12,fontWeight:600,color:s.color,background:s.border+"44",padding:"3px 10px",borderRadius:99}}>
                  {s.icon} {s.text}
                  {r.reply_confidence!=null&&<span style={{fontWeight:400,color:"#9ca3af"}}>({Math.round(r.reply_confidence*100)}% confidence)</span>}
                </div>
                {r.message_notes&&<div style={{fontSize:12,color:"#6b7280",marginTop:6,fontStyle:"italic"}}>💬 Summary: "{r.message_notes}"</div>}
              </div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap",flexShrink:0}}>
                <button className="btn btn-sm btn-purple" onClick={()=>onDecide(r.id,"resolved")}>✓ Mark Resolved</button>
                {r.status==="needs_review"&&<button className="btn btn-sm btn-green" onClick={()=>onDecide(r.id,"replied")}>👍 It's a reply</button>}
                <button className="btn btn-sm btn-red" onClick={()=>onDecide(r.id,"declined")}>↩ Not resolved</button>
                <button className="btn btn-sm" onClick={()=>onDrawer(r)}>History</button>
              </div>
            </div>
            {msgs.length > 0 ? (
              <div style={{background:"#f8f9fb",borderRadius:8,padding:12}}>
                <div style={{fontSize:11,fontWeight:600,color:"#9ca3af",letterSpacing:".5px",textTransform:"uppercase",marginBottom:8}}>
                  {msgs.length} message{msgs.length!==1?"s":""} received
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  {msgs.map((msg,i)=>(
                    <div key={i} style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                      <span style={{fontSize:11,color:"#9ca3af",minWidth:20,marginTop:1}}>#{i+1}</span>
                      <div style={{background:"#fff",border:"1px solid #e5e7eb",borderRadius:8,padding:"8px 12px",fontSize:13,color:"#374151",flex:1,lineHeight:1.5}}>
                        {msg}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{background:"#f8f9fb",borderRadius:8,padding:"10px 12px",fontSize:12,color:"#9ca3af",fontStyle:"italic"}}>
                No message text available. Try checking replies again to re-capture.
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
