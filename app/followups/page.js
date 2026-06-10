"use client";
import { useEffect, useState } from "react";

export default function Followups() {
  const [records, setRecords] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  async function load() {
    const r = await fetch("/api/followups/queue").then((r) => r.json());
    setRecords(r.records || []);
  }
  useEffect(() => { load(); }, []);

  function show(m) { setToast(m); setTimeout(() => setToast(null), 5000); }
  function toggle(id) { setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }); }

  async function send(ids) {
    setBusy(true);
    const r = await fetch("/api/followups/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) }).then((r) => r.json());
    setBusy(false);
    setSelected(new Set());
    const ok = r.results?.filter((x) => x.ok).length || 0;
    const failed = r.results?.filter((x) => !x.ok) || [];
    show(`✅ ${ok} follow-up(s) sent` + (failed.length ? ` · ⚠ ${failed[0].error}` : ""));
    load();
  }

  return (
    <div>
      <h1>Follow-ups Due</h1>
      <p className="dim" style={{ marginBottom: 16 }}>
        These POCs had no relevant reply at the last check. Send all, or pick individuals. After 3 follow-ups a record is marked Stalled instead of nagging forever.
      </p>
      {records.length > 0 && (
        <div className="card row">
          <button className="btn btn-orange" disabled={busy} onClick={() => send(records.map((r) => r.id))}>
            {busy ? "Sending…" : `🔁 Send All (${records.length})`}
          </button>
          {selected.size > 0 && (
            <button className="btn btn-orange" disabled={busy} onClick={() => send([...selected])}>Send Selected ({selected.size})</button>
          )}
        </div>
      )}
      <table>
        <thead><tr><th></th><th>CAMPAIGN</th><th>POC</th><th>ISSUE</th><th>CHANNEL</th><th>SENT</th><th>FU SO FAR</th></tr></thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.id}>
              <td><input type="checkbox" style={{ width: "auto" }} checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
              <td className="dim">{r.contacts?.campaign || "—"}</td>
              <td><div>{r.contacts?.name}</div><div className="faint">{r.contacts?.email}</div></td>
              <td className="dim" style={{ maxWidth: 300 }}>{r.contacts?.issue}</td>
              <td className="dim">{r.channel}</td>
              <td className="dim">{r.reached_out_at ? new Date(r.reached_out_at).toLocaleDateString() : "—"}</td>
              <td className="dim">{r.followups}</td>
            </tr>
          ))}
          {records.length === 0 && <tr><td colSpan={7} className="dim" style={{ padding: 24, textAlign: "center" }}>🎉 No follow-ups due. The daily check runs every morning.</td></tr>}
        </tbody>
      </table>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
