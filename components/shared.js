"use client";
import { useState, useEffect } from "react";

export const SC = {
  pending:      { label:"Pending",          color:"#374151", bg:"#f3f4f6", border:"#e5e7eb", dot:"#9ca3af" },
  sent:         { label:"Sent",             color:"#1d4ed8", bg:"#eff6ff", border:"#bfdbfe", dot:"#3b82f6" },
  active:       { label:"Active",           color:"#065f46", bg:"#ecfdf5", border:"#a7f3d0", dot:"#10b981" },
  no_reply:     { label:"No Reply",         color:"#991b1b", bg:"#fef2f2", border:"#fecaca", dot:"#ef4444" },
  followup:     { label:"Follow-up Sent",   color:"#92400e", bg:"#fff7ed", border:"#fed7aa", dot:"#f97316" },
  stalled:      { label:"Stalled",          color:"#7f1d1d", bg:"#fef2f2", border:"#fca5a5", dot:"#dc2626" },
  needs_review: { label:"Needs Review",     color:"#92400e", bg:"#fffbeb", border:"#fde68a", dot:"#f59e0b" },
  monitoring:   { label:"Snoozed",         color:"#0e7490", bg:"#ecfeff", border:"#a5f3fc", dot:"#06b6d4" },
  snoozed:      { label:"Snoozed",         color:"#0e7490", bg:"#ecfeff", border:"#a5f3fc", dot:"#06b6d4" },
  resolved:     { label:"Resolved",         color:"#4c1d95", bg:"#ede9fe", border:"#c4b5fd", dot:"#7c3aed" },
  escalated:    { label:"Reassigned",       color:"#1e40af", bg:"#dbeafe", border:"#93c5fd", dot:"#2563eb" },
};

export function Badge({ status }) {
  const c = SC[status] || SC.pending;
  return (
    <span className="badge" style={{ color:c.color, background:c.bg, border:`1px solid ${c.border}` }}>
      <span className="badge-dot" style={{ background:c.dot }} />
      {c.label}
    </span>
  );
}

export function days(d) {
  if (!d) return null;
  return Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
}

export function DaysChip({ d }) {
  if (d === null || d === undefined) return <span style={{ color:"#9ca3af" }}>—</span>;
  if (d === 0) return <span style={{ fontSize:12, color:"#9ca3af" }}>Today</span>;
  const color = d > 14 ? "#dc2626" : d > 7 ? "#d97706" : d > 3 ? "#d97706" : "#059669";
  return <span style={{ fontSize:12, fontWeight:600, color }}>{d}d{d > 7 ? " ⚠" : ""}</span>;
}

// ── Campaign Drawer ───────────────────────────────────────────────────────────
export function CampaignDrawer({ campaign, onClose, onStatusChange }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!campaign) return;
    setData(null);
    fetch(`/api/campaign?name=${encodeURIComponent(campaign)}`)
      .then(r => r.json()).then(setData).catch(console.error);
  }, [campaign]);

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-header">
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
            <div>
              <div style={{ fontSize:10, fontWeight:700, color:"#9ca3af", letterSpacing:1, textTransform:"uppercase", marginBottom:4 }}>Campaign</div>
              <div style={{ fontSize:18, fontWeight:700, letterSpacing:"-.3px" }}>{campaign}</div>
            </div>
            <button className="btn btn-sm" onClick={onClose}>✕</button>
          </div>
          {data?.stats && (
            <div style={{ display:"flex", gap:16, marginTop:16, flexWrap:"wrap" }}>
              {[
                { label:"Total",      n:data.stats.total,      color:"#374151" },
                { label:"Active",     n:data.stats.active,     color:"#059669" },
                { label:"No Reply",   n:data.stats.no_reply,   color:"#ef4444" },
                { label:"Resolved",   n:data.stats.resolved,   color:"#7c3aed" },
                { label:"Reassigned", n:data.stats.escalated,  color:"#2563eb" },
              ].map(({ label, n, color }) => (
                <div key={label} style={{ textAlign:"center" }}>
                  <div style={{ fontSize:22, fontWeight:700, color, lineHeight:1 }}>{n}</div>
                  <div style={{ fontSize:10, color:"#9ca3af", fontWeight:700, textTransform:"uppercase", letterSpacing:.5, marginTop:2 }}>{label}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="drawer-body">
          {!data ? (
            <p style={{ color:"#9ca3af", fontSize:13 }}>Loading…</p>
          ) : (data.records || []).length === 0 ? (
            <p style={{ color:"#9ca3af", fontSize:13 }}>No records for this campaign.</p>
          ) : (data.records || []).map(rec => (
            <POCCard key={rec.id} rec={rec} onStatusChange={async (id, status) => { await onStatusChange(id, status); setData(null); fetch(`/api/campaign?name=${encodeURIComponent(campaign)}`).then(r=>r.json()).then(setData); }} />
          ))}
        </div>
      </div>
    </>
  );
}

function POCCard({ rec, onStatusChange }) {
  const [open, setOpen] = useState(false);
  const c = SC[rec.status] || SC.pending;
  const msgs = rec.reply_messages || [];

  return (
    <div style={{ border:`1px solid ${c.border}`, borderLeft:`3px solid ${c.dot}`, borderRadius:10, marginBottom:10, overflow:"hidden", background:"#fff" }}>
      <div style={{ padding:"12px 14px", display:"flex", alignItems:"center", gap:10, cursor:"pointer" }} onClick={() => setOpen(o => !o)}>
        <div style={{ flex:1 }}>
          <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:2 }}>
            <span className="poc-name">{rec.contacts?.name}</span>
            <Badge status={rec.status} />
          </div>
          {rec.contacts?.email && <div className="poc-email">{rec.contacts.email}</div>}
          <div className="issue-text" style={{ marginTop:4 }}>{rec.contacts?.issue}</div>
        </div>
        <span style={{ fontSize:10, color:"#9ca3af" }}>{open ? "▲" : "▼"}</span>
      </div>

      {open && (
        <div style={{ background:"#fafafa", borderTop:`1px solid ${c.border}`, padding:"12px 14px" }}>
          {msgs.length > 0 && (
            <div style={{ marginBottom:12 }}>
              <div style={{ fontSize:10, fontWeight:700, color:"#9ca3af", letterSpacing:1, textTransform:"uppercase", marginBottom:8 }}>Replies</div>
              {msgs.map((m, i) => (
                <div key={i} className="msg-bubble">{m}</div>
              ))}
            </div>
          )}
          {rec.message_notes && !msgs.length && (
            <div style={{ fontSize:12, color:"#6b7280", fontStyle:"italic", marginBottom:12 }}>💬 {rec.message_notes}</div>
          )}
          <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
            {rec.status !== "resolved" && <button className="btn btn-xs btn-purple" onClick={() => onStatusChange(rec.id, "resolved")}>✓ Resolve</button>}
            {rec.status !== "escalated" && <button className="btn btn-xs btn-green" onClick={() => onStatusChange(rec.id, "escalated")}>↗ Reassign</button>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Edit Contact Modal ────────────────────────────────────────────────────────
export function EditModal({ contact, onClose, onSaved }) {
  const [form, setForm] = useState({ name:contact.name||"", email:contact.email||"", campaign:contact.campaign||"", issue:contact.issue||"" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save() {
    if (!contact?.id) { setError("Internal error: contact ID missing — please refresh the page and try again."); return; }
    setBusy(true);
    const r = await fetch(`/api/contacts/${contact.id}`, { method:"PATCH", headers:{"content-type":"application/json"}, body:JSON.stringify(form) }).then(r => r.json());
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    onSaved(); onClose();
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>Edit Contact</h3>
        {error && <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:8, padding:"8px 12px", fontSize:12, color:"#dc2626", marginBottom:12 }}>{error}</div>}
        {["name","email","campaign"].map(k => (
          <div className="form-field" key={k}>
            <label>{k.charAt(0).toUpperCase()+k.slice(1)}</label>
            <input value={form[k]} onChange={e => setForm(f => ({ ...f, [k]:e.target.value }))} />
          </div>
        ))}
        <div className="form-field">
          <label>Issue</label>
          <textarea rows={4} value={form.issue} onChange={e => setForm(f => ({ ...f, issue:e.target.value }))} style={{ resize:"vertical" }} />
        </div>
        <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{busy?"Saving…":"Save"}</button>
        </div>
      </div>
    </div>
  );
}

// ── Reassign Modal (formerly Escalate) ────────────────────────────────────────
export function EscalateModal({ ids, records, onClose, onDone }) {
  const [note, setNote] = useState("");
  const [toName, setToName] = useState("");
  const [toEmail, setToEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { ok, warning }

  async function submit() {
    if (!note.trim() || !toName.trim()) return;
    setBusy(true);
    const r = await fetch("/api/outreach/bulk-update", {
      method:"POST", headers:{"content-type":"application/json"},
      body:JSON.stringify({ ids, action:"reassign", payload:{ note, toName, toEmail } }),
    }).then(r => r.json());
    setBusy(false);

    const warnings = (r.results || []).filter(x => x.warning).map(x => x.warning);
    if (warnings.length) {
      setResult({ ok: true, warning: warnings.join("; ") });
    } else {
      onDone(); onClose();
    }
  }

  if (result) {
    return (
      <div className="modal-overlay">
        <div className="modal">
          <h3>Reassigned</h3>
          <div style={{ background:"#fffbeb", border:"1px solid #fde68a", borderRadius:8, padding:"10px 12px", fontSize:13, color:"#92400e", marginBottom:16 }}>
            ⚠ {result.warning}
          </div>
          <p style={{ fontSize:13, color:"#6b7280" }}>The original record is marked as Reassigned. The new contact record is in the Outreach tab — send manually when ready.</p>
          <button className="btn btn-primary" style={{ width:"100%" }} onClick={() => { onDone(); onClose(); }}>Done</button>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>Reassign to Someone Else</h3>
        <p style={{ fontSize:13, color:"#6b7280", marginBottom:16 }}>
          The original record will be marked <strong>Reassigned</strong>. A new outreach record will be created for the person below and a message will be sent to them automatically on the same channel.
        </p>
        <div className="form-field">
          <label>Why are you reassigning? *</label>
          <textarea rows={3} placeholder="e.g. Kirsten said this belongs to the finance team — they need to update the DMS entry" value={note} onChange={e => setNote(e.target.value)} style={{ resize:"vertical" }} />
        </div>
        <div className="form-field">
          <label>Reassign to (name) *</label>
          <input placeholder="Ravi Kumar" value={toName} onChange={e => setToName(e.target.value)} />
        </div>
        <div className="form-field">
          <label>Their email (required for email outreach)</label>
          <input placeholder="ravi@corp.in" value={toEmail} onChange={e => setToEmail(e.target.value)} />
        </div>
        <p style={{ fontSize:11, color:"#9ca3af", marginBottom:16 }}>
          A message will be sent to {toName||"them"} immediately via the same channel as the original outreach (Slack or email). If Slack lookup fails, the new record is created as pending so you can send manually.
        </p>
        <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !note.trim() || !toName.trim()} onClick={submit}>
            {busy ? "Reassigning…" : "Reassign & Send →"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Bulk Bar ──────────────────────────────────────────────────────────────────
export function BulkBar({ selected, children }) {
  if (!selected) return null;
  return (
    <div className="bulk-bar">
      <span style={{ fontSize:13, color:"#fff", fontWeight:600, minWidth:80 }}>{selected} selected</span>
      {children}
    </div>
  );
}

// ── Send Progress Modal ───────────────────────────────────────────────────────
export function SendProgressModal({ progress, onClose }) {
  if (!progress) return null;
  const done = progress.results.length;
  const total = progress.total;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const ok = progress.results.filter(r => r.ok).length;
  const failed = progress.results.filter(r => !r.ok).length;
  const inProgress = done < total;

  return (
    <div className="modal-overlay">
      <div className="progress-modal">
        <div style={{ fontWeight:700, fontSize:16, marginBottom:4 }}>{inProgress ? "Sending outreach…" : "Send complete"}</div>
        <div style={{ fontSize:13, color:"#6b7280" }}>
          {inProgress ? `Processing ${total} message${total!==1?"s":""}…` : `${ok} sent · ${failed} failed`}
        </div>
        <div className="progress-bar-track">
          <div className="progress-bar-fill" style={{ width:`${pct}%`, background:inProgress?"#3b82f6":failed>0?"#f97316":"#10b981" }} />
        </div>
        {done > 0 && (
          <div style={{ maxHeight:240, overflowY:"auto", marginBottom:16 }}>
            {progress.results.map((r,i) => (
              <div key={i} className="result-row" style={{ background:r.ok?"#f0fdf4":"#fef2f2" }}>
                <span>{r.ok?"✅":"❌"}</span>
                <span style={{ flex:1, fontWeight:500, color:r.ok?"#065f46":"#991b1b" }}>{r.name || r.id}</span>
                {!r.ok && <span style={{ fontSize:11, color:"#ef4444", maxWidth:200, textAlign:"right" }}>{r.error}</span>}
              </div>
            ))}
          </div>
        )}
        {!inProgress && <button className="btn btn-primary" style={{ width:"100%" }} onClick={onClose}>Done</button>}
      </div>
    </div>
  );
}

// ── Reconcile Modal (category-scoped, dry-run first) ──────────────────────────
export function ReconcileModal({ categories, onClose, onDone }) {
  const [category, setCategory] = useState("");
  const [csvText, setCsvText] = useState("");
  const [complete, setComplete] = useState(false);
  const [preview, setPreview] = useState(null); // dry-run result
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function runDryRun() {
    setError(null);
    if (!category) { setError("Pick a category first."); return; }
    if (!complete) { setError("Tick the box confirming this is the complete list for the category."); return; }
    setBusy(true);
    const r = await fetch("/api/reconcile", {
      method:"POST", headers:{"content-type":"application/json"},
      body:JSON.stringify({ category, csvText, complete, dryRun:true }),
    }).then(r=>r.json());
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    setPreview(r);
  }

  async function confirmApply() {
    setBusy(true);
    const r = await fetch("/api/reconcile", {
      method:"POST", headers:{"content-type":"application/json"},
      body:JSON.stringify({ category, csvText, complete, dryRun:false }),
    }).then(r=>r.json());
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    onDone(r); onClose();
  }

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth:640 }}>
        <h3>Reconcile a category</h3>
        <p style={{ fontSize:13, color:"#6b7280", marginBottom:16 }}>
          Paste the <strong>current complete list</strong> of open issues for ONE category. Anything still open in that category but missing from your list will be auto-resolved (it dropped off your source = fixed). Only the chosen category is touched.
        </p>
        {error && <div style={{ background:"#fef2f2", border:"1px solid #fecaca", borderRadius:8, padding:"8px 12px", fontSize:12, color:"#dc2626", marginBottom:12 }}>{error}</div>}

        {!preview ? (
          <>
            <div className="form-field">
              <label>Category</label>
              <select value={category} onChange={e=>setCategory(e.target.value)}>
                <option value="">Select a category…</option>
                {categories.map(c => <option key={c.id} value={c.tag}>{c.name}</option>)}
              </select>
            </div>
            <div className="form-field">
              <label>Paste rows (Campaign · Name · Email · Issue)</label>
              <textarea rows={8} placeholder="Paste the complete current list for this category…" value={csvText} onChange={e=>setCsvText(e.target.value)} style={{ resize:"vertical" }} />
            </div>
            <div className="toggle-row" style={{ marginBottom:16, background:"#fffbeb", border:"1px solid #fde68a", borderRadius:8, padding:"10px 12px" }}>
              <input type="checkbox" id="complete" checked={complete} onChange={e=>setComplete(e.target.checked)} />
              <label htmlFor="complete" style={{ fontSize:13 }}>This is the <strong>complete</strong> current list of open issues for this category. Records absent from it are resolved.</label>
            </div>
            <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
              <button className="btn" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" disabled={busy} onClick={runDryRun}>{busy?"Checking…":"Preview →"}</button>
            </div>
          </>
        ) : (
          <>
            <div style={{ display:"flex", gap:12, marginBottom:16, flexWrap:"wrap" }}>
              <PreviewStat n={preview.summary.matched} label="Still open (matched)" color="#059669" />
              <PreviewStat n={preview.summary.toCreate} label="New → will create" color="#1d4ed8" />
              <PreviewStat n={preview.summary.toResolve} label="Will auto-resolve" color="#dc2626" />
            </div>
            {preview.toResolve.length > 0 && (
              <div style={{ marginBottom:16 }}>
                <div style={{ fontSize:11, fontWeight:700, color:"#9ca3af", letterSpacing:1, textTransform:"uppercase", marginBottom:6 }}>Will be auto-resolved</div>
                <div style={{ maxHeight:180, overflowY:"auto", border:"1px solid #fecaca", borderRadius:8 }}>
                  {preview.toResolve.map(r => (
                    <div key={r.id} style={{ padding:"8px 12px", borderBottom:"1px solid #fee2e2", fontSize:12 }}>
                      <strong>{r.name}</strong> · {r.campaign} <div style={{ color:"#6b7280" }}>{r.issue}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div style={{ fontSize:12, color:"#6b7280", marginBottom:16 }}>🔒 Records in all other categories are untouched.</div>
            <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
              <button className="btn" onClick={()=>setPreview(null)}>← Back</button>
              <button className="btn btn-primary" disabled={busy} onClick={confirmApply}>{busy?"Applying…":`Confirm — resolve ${preview.summary.toResolve}, create ${preview.summary.toCreate}`}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PreviewStat({ n, label, color }) {
  return (
    <div style={{ flex:1, minWidth:120, textAlign:"center", border:`1px solid ${color}22`, borderRadius:8, padding:"12px 8px", background:`${color}08` }}>
      <div style={{ fontSize:24, fontWeight:700, color }}>{n}</div>
      <div style={{ fontSize:11, color:"#6b7280", marginTop:2 }}>{label}</div>
    </div>
  );
}

// ── Snooze Modal (day picker) ─────────────────────────────────────────────────
export function SnoozeModal({ ids, onClose, onDone }) {
  const [days, setDays] = useState(7);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const presets = [3, 7, 14, 30];

  async function submit() {
    setBusy(true);
    await fetch("/api/outreach/bulk-update", {
      method:"POST", headers:{"content-type":"application/json"},
      body:JSON.stringify({ ids, action:"snooze", payload:{ days, note } }),
    });
    setBusy(false);
    onDone(); onClose();
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>Snooze {ids.length > 1 ? `${ids.length} records` : "record"}</h3>
        <p style={{ fontSize:13, color:"#6b7280", marginBottom:16 }}>
          Hidden from In Flight until the snooze expires, then auto-resurfaced for follow-up. No follow-ups sent while snoozed.
        </p>
        <div className="form-field">
          <label>Snooze for</label>
          <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:8 }}>
            {presets.map(p => (
              <button key={p} className={`btn btn-sm ${days===p?"btn-primary":""}`} onClick={()=>setDays(p)}>{p} days</button>
            ))}
            <button className={`btn btn-sm ${days===0?"btn-primary":""}`} onClick={()=>setDays(0)}>Indefinite</button>
          </div>
          {days !== 0 && (
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ fontSize:13, color:"#6b7280" }}>or custom:</span>
              <input type="number" min="1" max="365" value={days} onChange={e=>setDays(+e.target.value)} style={{ width:80 }} />
              <span style={{ fontSize:13, color:"#6b7280" }}>days</span>
            </div>
          )}
        </div>
        <div className="form-field">
          <label>Note (optional)</label>
          <textarea rows={2} placeholder="Why are you snoozing this?" value={note} onChange={e=>setNote(e.target.value)} style={{ resize:"vertical" }} />
        </div>
        <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={submit}>{busy?"Snoozing…":days===0?"Snooze indefinitely":`Snooze ${days} days`}</button>
        </div>
      </div>
    </div>
  );
}

// ── Row overflow menu (⋯) — demotes occasional actions to keep rows clean ──────
export function RowMenu({ items }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  return (
    <span style={{ position:"relative", display:"inline-block" }}>
      <button className="btn btn-sm" onClick={(e)=>{ e.stopPropagation(); setOpen(o=>!o); }} title="More actions">⋯</button>
      {open && (
        <div style={{ position:"absolute", right:0, top:"100%", marginTop:4, background:"#fff", border:"1px solid #e5e7eb", borderRadius:8, boxShadow:"0 4px 16px rgba(0,0,0,.1)", zIndex:50, minWidth:160, overflow:"hidden" }} onClick={e=>e.stopPropagation()}>
          {items.map((it, i) => (
            <button key={i} onClick={()=>{ setOpen(false); it.onClick(); }}
              style={{ display:"block", width:"100%", textAlign:"left", padding:"8px 12px", fontSize:13, border:"none", background:"none", cursor:"pointer", color:it.danger?"#dc2626":"#374151" }}
              onMouseEnter={e=>e.currentTarget.style.background="#f3f4f6"}
              onMouseLeave={e=>e.currentTarget.style.background="none"}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

// ── Category chip — small inline tag showing a record's auto-assigned category ──
const CAT_COLORS = ["#7c3aed","#0e7490","#b45309","#1d4ed8","#be185d","#15803d","#9333ea","#0369a1"];
function catColor(tag) {
  if (!tag) return "#9ca3af";
  let h = 0; for (let i=0;i<tag.length;i++) h = (h*31 + tag.charCodeAt(i)) >>> 0;
  return CAT_COLORS[h % CAT_COLORS.length];
}
export function CategoryChip({ category, categories }) {
  if (!category) return <span style={{ fontSize:10, color:"#d1d5db" }}>uncategorized</span>;
  const meta = (categories || []).find(c => c.tag === category);
  const color = catColor(category);
  return (
    <span title={meta?.description || category} style={{
      display:"inline-block", fontSize:10, fontWeight:600, color,
      background:`${color}14`, border:`1px solid ${color}33`, borderRadius:99,
      padding:"1px 8px", marginTop:4,
    }}>
      {meta?.name || category}
    </span>
  );
}
