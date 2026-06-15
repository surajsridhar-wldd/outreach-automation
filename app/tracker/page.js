"use client";
import { useEffect, useState, useCallback } from "react";
import { Badge, EditModal, BulkBar, SendProgressModal, CampaignDrawer, SC } from "@/components/shared";

export default function OutreachPage() {
  const [records, setRecords] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [channel, setChannel] = useState("slack");
  const [busy, setBusy] = useState({});
  const [toast, setToast] = useState(null);
  const [csvText, setCsvText] = useState("");
  const [sheetUrl, setSheetUrl] = useState("");
  const [editRec, setEditRec] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [progress, setProgress] = useState(null);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/outreach?status=pending").then(r => r.json());
    setRecords(r.records || []);
  }, []);

  useEffect(() => { load(); }, [load]);

  function show(msg, type = "info") { setToast({ msg, type }); setTimeout(() => setToast(null), 5000); }
  function toggle(id) { setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  function toggleAll() { setSelected(s => s.size === records.length ? new Set() : new Set(records.map(r => r.id))); }

  async function doImport() {
    setImporting(true);
    const body = sheetUrl.trim() ? { sheetUrl: sheetUrl.trim() } : { csvText };
    const r = await fetch("/api/contacts/import", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body) }).then(r => r.json());
    setImporting(false);
    if (r.error) return show("⚠ " + r.error, "error");
    setCsvText(""); setSheetUrl("");
    const msg = `✅ Imported ${r.created}${r.skipped ? ` · ${r.skipped} skipped (already active)` : ""}`;
    show(msg);
    load();
  }

  async function bulkSend() {
    const ids = [...selected];
    setProgress({ total: ids.length, results: [] });
    setBusy(b => ({ ...b, send: true }));
    const r = await fetch("/api/outreach/bulk-send", {
      method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ ids, channel }),
    }).then(r => r.json());
    setBusy(b => ({ ...b, send: false }));
    setSelected(new Set());
    setProgress({ total: ids.length, results: r.results || [] });
    load();
  }

  async function bulkDelete() {
    if (!confirm(`Delete ${selected.size} record(s)? This cannot be undone.`)) return;
    setBusy(b => ({ ...b, del: true }));
    await fetch("/api/outreach/bulk-update", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ ids:[...selected], action:"delete" }) });
    setBusy(b => ({ ...b, del: false }));
    setSelected(new Set());
    show(`🗑 Deleted`);
    load();
  }

  async function deleteOne(id) {
    if (!confirm("Delete this record?")) return;
    await fetch(`/api/outreach/${id}`, { method:"DELETE" });
    show("🗑 Deleted");
    load();
  }

  return (
    <div>
      {/* Import section */}
      <div style={{ marginBottom:24 }}>
        <h1 style={{ fontSize:20, fontWeight:700, letterSpacing:"-.4px", marginBottom:4 }}>Outreach</h1>
        <p style={{ fontSize:13, color:"#6b7280", marginBottom:16 }}>
          Pending POCs — imported but outreach not yet sent. Send via Slack or Email once ready.
        </p>

        <div className="import-box" style={{ marginBottom:20 }}>
          <div style={{ fontWeight:600, fontSize:14, marginBottom:12 }}>Import POCs</div>
          <div className="example-box">{"Campaign\tPOC Name\tEmail (optional)\tIssue\none8 x journey\tKirsten Menezes\t\tThis campaign has crossed its posting end date on DMS…"}</div>
          <p style={{ fontSize:11, color:"#9ca3af", marginBottom:12 }}>Email optional for Slack. Required for email outreach. Duplicates (same name + campaign with active outreach) are skipped automatically.</p>
          <div style={{ display:"flex", gap:10, marginBottom:10 }}>
            <input placeholder="Google Sheet URL (optional)" value={sheetUrl} onChange={e => setSheetUrl(e.target.value)} />
          </div>
          <textarea rows={4} placeholder="Or paste tab-separated / CSV table here…" value={csvText} onChange={e => setCsvText(e.target.value)} style={{ resize:"vertical", marginBottom:10 }} />
          <button className="btn btn-primary" disabled={importing || (!csvText.trim() && !sheetUrl.trim())} onClick={doImport}>
            {importing ? "Importing…" : "Import →"}
          </button>
        </div>
      </div>

      {/* Pending records */}
      {records.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">📋</div>
          <h3>No pending outreach</h3>
          <p>Import a table above to add POCs. Once sent, they move to In Flight.</p>
        </div>
      ) : (
        <>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12 }}>
            <label style={{ display:"flex", alignItems:"center", gap:6, cursor:"pointer", fontSize:13, fontWeight:500 }}>
              <input type="checkbox" style={{ width:"auto" }} checked={selected.size === records.length && records.length > 0} onChange={toggleAll} />
              Select all ({records.length})
            </label>
            <span style={{ fontSize:12, color:"#9ca3af", marginLeft:"auto" }}>{records.length} pending</span>
          </div>

          <BulkBar selected={selected.size}>
            <div className="channel-toggle">
              <button className={`ch-btn ${channel==="slack"?"active":""}`} onClick={() => setChannel("slack")}>💬 Slack</button>
              <button className={`ch-btn ${channel==="email"?"active":""}`} onClick={() => setChannel("email")}>📧 Email</button>
            </div>
            <button className="btn btn-primary btn-sm" disabled={busy.send} onClick={bulkSend}>
              {busy.send ? "Sending…" : `Send ${selected.size} via ${channel}`}
            </button>
            <button className="btn btn-red btn-sm" disabled={busy.del} onClick={bulkDelete} style={{ marginLeft:"auto" }}>
              🗑 Delete ({selected.size})
            </button>
          </BulkBar>

          <div className="tbl-wrap">
            <table>
              <thead><tr>
                <th style={{ width:32 }}></th>
                <th>POC</th><th>CAMPAIGN</th><th>ISSUE</th><th>ACTIONS</th>
              </tr></thead>
              <tbody>
                {records.map(r => (
                  <tr key={r.id}>
                    <td><div className="row-main" style={{ padding:"12px 8px 12px 14px", cursor:"default" }}>
                      <input type="checkbox" style={{ width:"auto" }} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                    </div></td>
                    <td><div className="row-main" style={{ cursor:"default" }}>
                      <div>
                        <div className="poc-name">{r.contacts?.name}</div>
                        <div className="poc-email">{r.contacts?.email || <span style={{ color:"#f97316", fontSize:11 }}>No email — Slack only</span>}</div>
                      </div>
                    </div></td>
                    <td><div className="row-main" style={{ cursor:"default" }}>
                      {r.contacts?.campaign ? (
                        <span className="campaign-pill" onClick={() => setDrawer(r.contacts.campaign)}>{r.contacts.campaign}</span>
                      ) : <span style={{ color:"#9ca3af", fontSize:12 }}>—</span>}
                    </div></td>
                    <td><div className="row-main" style={{ cursor:"default" }}>
                      <div className="issue-text">{r.contacts?.issue}</div>
                    </div></td>
                    <td><div className="row-main" style={{ cursor:"default", gap:6 }}>
                      <button className="btn btn-sm" onClick={() => setEditRec(r)}>✏️ Edit</button>
                      <button className="btn btn-red btn-sm" onClick={() => deleteOne(r.id)}>🗑</button>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {editRec && (
        <EditModal
          contact={editRec.contacts}
          outreachId={editRec.id}
          onClose={() => setEditRec(null)}
          onSaved={load}
        />
      )}
      {drawer && <CampaignDrawer campaign={drawer} onClose={() => setDrawer(null)} onStatusChange={async (id, status) => { await fetch(`/api/outreach/${id}`, { method:"PATCH", headers:{"content-type":"application/json"}, body:JSON.stringify({ status }) }); setDrawer(null); load(); }} />}
      <SendProgressModal progress={progress} onClose={() => { setProgress(null); }} />
      {toast && <div className="toast" style={{ background: toast.type==="error" ? "#dc2626" : "#1e293b" }}>{toast.msg}</div>}
    </div>
  );
}
