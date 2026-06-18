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
  monitoring:   { label:"Monitoring",       color:"#0e7490", bg:"#ecfeff", border:"#a5f3fc", dot:"#06b6d4" },
  resolved:     { label:"Resolved",         color:"#4c1d95", bg:"#ede9fe", border:"#c4b5fd", dot:"#7c3aed" },
  escalated:    { label:"Escalated",        color:"#1e40af", bg:"#dbeafe", border:"#93c5fd", dot:"#2563eb" },
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
                { label:"Total",    n:data.stats.total,    color:"#374151" },
                { label:"Active",   n:data.stats.active,   color:"#059669" },
                { label:"No Reply", n:data.stats.no_reply, color:"#ef4444" },
                { label:"Resolved", n:data.stats.resolved, color:"#7c3aed" },
                { label:"Escalated",n:data.stats.escalated,color:"#2563eb" },
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
            {rec.status !== "escalated" && <button className="btn btn-xs btn-green" onClick={() => onStatusChange(rec.id, "escalated")}>↗ Escalate</button>}
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

// ── Escalate Modal ────────────────────────────────────────────────────────────
export function EscalateModal({ ids, records, onClose, onDone }) {
  const [note, setNote] = useState("");
  const [toName, setToName] = useState("");
  const [toEmail, setToEmail] = useState("");
  const [createNew, setCreateNew] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!note.trim()) return;
    setBusy(true);
    await fetch("/api/outreach/bulk-update", {
      method:"POST", headers:{"content-type":"application/json"},
      body:JSON.stringify({ ids, action:"escalate", payload:{ note, escalateTo: toName ? { name:toName, email:toEmail } : null } }),
    });
    if (createNew && toName) {
      const escalatedRecs = (records||[]).filter(r => ids.includes(r.id));
      const csvRows = ["POC Name\tEmail\tCampaign\tIssue",
        ...escalatedRecs.map(r => `${toName}\t${toEmail}\t${r.contacts?.campaign||""}\t${r.contacts?.issue||""}`)
      ].join("\n");
      await fetch("/api/contacts/import", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ csvText:csvRows }) });
    }
    setBusy(false); onDone(); onClose();
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>Escalate to Someone Else</h3>
        <div className="form-field">
          <label>What needs to happen *</label>
          <textarea rows={3} placeholder="e.g. Kirsten said this belongs to the finance team — they need to update the DMS entry" value={note} onChange={e => setNote(e.target.value)} style={{ resize:"vertical" }} />
        </div>
        <div className="form-field">
          <label>Reassign to (name)</label>
          <input placeholder="Ravi Kumar" value={toName} onChange={e => setToName(e.target.value)} />
        </div>
        <div className="form-field">
          <label>Their email (optional — for email outreach)</label>
          <input placeholder="ravi@corp.in" value={toEmail} onChange={e => setToEmail(e.target.value)} />
        </div>
        {toName && (
          <label style={{ display:"flex", alignItems:"center", gap:8, marginBottom:16, fontSize:13, cursor:"pointer" }}>
            <input type="checkbox" style={{ width:"auto" }} checked={createNew} onChange={e => setCreateNew(e.target.checked)} />
            Also create a new Outreach record for {toName} with the same issue
          </label>
        )}
        <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !note.trim()} onClick={submit}>{busy?"Escalating…":"Escalate"}</button>
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
