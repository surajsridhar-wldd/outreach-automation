"use client";
import { useEffect, useState, useCallback } from "react";

const STATUS = {
  pending: ["Pending", "var(--grey)", "#1e293b"],
  sent: ["Outreach Sent", "var(--blue)", "#1e3a5f"],
  awaiting_reply: ["Awaiting Reply", "var(--blue)", "#1e3a5f"],
  replied: ["Replied", "var(--green)", "#064e3b"],
  needs_review: ["Needs Review", "var(--orange)", "#431407"],
  followup: ["Follow-up Sent", "var(--orange)", "#431407"],
  resolved_auto: ["Resolved (auto)", "var(--purple)", "#2e1065"],
  resolved: ["Resolved", "var(--purple)", "#2e1065"],
  no_reply: ["No Reply", "var(--red)", "#450a0a"],
  stalled: ["Stalled", "var(--red)", "#450a0a"],
};

function Badge({ status }) {
  const [label, color, bg] = STATUS[status] || [status, "var(--grey)", "#1e293b"];
  return <span className="badge" style={{ color, background: bg }}>{label}</span>;
}

function daysPending(d) {
  if (!d) return null;
  return Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
}

export default function Tracker() {
  const [records, setRecords] = useState([]);
  const [tab, setTab] = useState("reachout"); // import | reachout | pending | done
  const [selected, setSelected] = useState(new Set());
  const [channel, setChannel] = useState("slack");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [csvText, setCsvText] = useState("");
  const [sheetUrl, setSheetUrl] = useState("");
  const [history, setHistory] = useState(null); // {record, events}

  const load = useCallback(async () => {
    const r = await fetch("/api/outreach").then((r) => r.json());
    setRecords(r.records || []);
  }, []);
  useEffect(() => { load(); }, [load]);

  function show(msg) { setToast(msg); setTimeout(() => setToast(null), 5000); }

  async function doImport() {
    setBusy(true);
    const body = sheetUrl.trim() ? { sheetUrl: sheetUrl.trim() } : { csvText };
    const r = await fetch("/api/contacts/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    setBusy(false);
    if (r.error) return show("⚠ " + r.error);
    setCsvText(""); setSheetUrl("");
    show(`✅ Imported ${r.created} POC(s)`);
    setTab("reachout");
    load();
  }

  async function bulkSend() {
    setBusy(true);
    const ids = [...selected];
    const r = await fetch("/api/outreach/bulk-send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids, channel }) }).then((r) => r.json());
    setBusy(false);
    setSelected(new Set());
    const ok = r.results?.filter((x) => x.ok).length || 0;
    const failed = r.results?.filter((x) => !x.ok) || [];
    show(`✅ Sent ${ok}` + (failed.length ? ` · ⚠ ${failed.length} failed: ${failed[0].error}` : ""));
    if (r.error) show("⚠ " + r.error);
    load();
  }

  async function bulkAction(action) {
    setBusy(true);
    const ids = [...selected];
    await fetch("/api/outreach/bulk-update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids, action }) }).then((r) => r.json());
    setBusy(false);
    setSelected(new Set());
    show(action === "check_reply" ? "✅ Reply check complete" : "✅ Done");
    load();
  }

  async function resolveOne(id) {
    await fetch(`/api/outreach/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "resolved" }) });
    show("✅ Resolved"); load();
  }

  async function openHistory(rec) {
    const r = await fetch(`/api/outreach/${rec.id}/history`).then((r) => r.json());
    setHistory({ record: rec, events: r.events || [] });
  }

  const pending = records.filter((r) => r.status === "pending");
  const reachout = records.filter((r) => ["sent", "awaiting_reply", "followup", "replied", "needs_review", "resolved_auto"].includes(r.status));
  const pendingAction = records.filter((r) => ["no_reply", "stalled"].includes(r.status));
  const done = records.filter((r) => r.status === "resolved");

  const counts = {};
  records.forEach((r) => (counts[r.status] = (counts[r.status] || 0) + 1));

  const view = tab === "import" ? [] : tab === "reachout" ? [...pending, ...reachout] : tab === "pending" ? pendingAction : done;
  const selectable = view.filter((r) => r.status === "pending" || ["sent", "awaiting_reply", "followup", "no_reply"].includes(r.status));

  function toggle(id) {
    setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setSelected((p) => p.size === selectable.length ? new Set() : new Set(selectable.map((r) => r.id)));
  }

  const selPending = [...selected].filter((id) => records.find((r) => r.id === id)?.status === "pending");
  const selSent = [...selected].filter((id) => ["sent", "awaiting_reply", "followup", "no_reply"].includes(records.find((r) => r.id === id)?.status));

  return (
    <div>
      <h1>Tracker</h1>
      <div className="statgrid">
        {Object.entries(STATUS).map(([k, [label, color]]) => counts[k] ? (
          <div className="statcard" key={k}>
            <div className="statnum" style={{ color }}>{counts[k]}</div>
            <div className="faint">{label}</div>
          </div>
        ) : null)}
      </div>

      <div className="tabbar">
        {[["import", "➕ Import"], ["reachout", `Reachout (${pending.length + reachout.length})`], ["pending", `Pending Action (${pendingAction.length})`], ["done", `Resolved (${done.length})`]].map(([id, label]) => (
          <button key={id} className={`tabbtn ${tab === id ? "active" : ""}`} onClick={() => { setTab(id); setSelected(new Set()); }}>{label}</button>
        ))}
      </div>

      {tab === "import" && (
        <div className="card">
          <p className="dim" style={{ marginBottom: 12 }}>
            Paste a table (tab-separated or CSV, headers required: Campaign, POC Name, Email, Issue) — or paste a Google Sheet URL.
          </p>
          <input placeholder="https://docs.google.com/spreadsheets/d/… (optional)" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} style={{ marginBottom: 10 }} />
          <textarea rows={8} placeholder={"Campaign\tPOC Name\tEmail\tIssue\nQ2 GST Recon\tPriya Sharma\tpriya@corp.in\tMissing GST entries for March"} value={csvText} onChange={(e) => setCsvText(e.target.value)} style={{ marginBottom: 10 }} />
          <button className="btn btn-blue" disabled={busy || (!csvText.trim() && !sheetUrl.trim())} onClick={doImport}>
            {busy ? "Importing…" : "Import →"}
          </button>
        </div>
      )}

      {tab !== "import" && (
        <>
          {selectable.length > 0 && (
            <div className="card row">
              <label className="row" style={{ gap: 6, cursor: "pointer" }}>
                <input type="checkbox" style={{ width: "auto" }} checked={selected.size === selectable.length && selectable.length > 0} onChange={toggleAll} />
                <span className="dim">Select all ({selectable.length})</span>
              </label>
              {selPending.length > 0 && (
                <>
                  <span className="dim">{selPending.length} to send via</span>
                  <select value={channel} onChange={(e) => setChannel(e.target.value)} style={{ width: 110 }}>
                    <option value="slack">💬 Slack</option>
                    <option value="email">📧 Email</option>
                  </select>
                  <button className="btn btn-blue" disabled={busy} onClick={bulkSend}>{busy ? "Sending…" : `Send ${selPending.length} →`}</button>
                </>
              )}
              {selSent.length > 0 && (
                <button className="btn btn-green" disabled={busy} onClick={() => bulkAction("check_reply")}>🔍 Check Replies ({selSent.length})</button>
              )}
              {selected.size > 0 && (
                <button className="btn btn-purple" disabled={busy} onClick={() => bulkAction("resolve")}>✓ Resolve ({selected.size})</button>
              )}
            </div>
          )}

          <table>
            <thead><tr>
              <th></th><th>CAMPAIGN</th><th>POC</th><th>ISSUE</th><th>STATUS</th>
              {tab === "pending" && <th>DAYS</th>}
              <th>FU</th><th></th>
            </tr></thead>
            <tbody>
              {view.map((r) => {
                const dp = daysPending(r.reached_out_at);
                const dpColor = dp > 14 ? "var(--red)" : dp > 7 ? "var(--orange)" : dp > 3 ? "#fbbf24" : "var(--dim)";
                const canSelect = selectable.some((s) => s.id === r.id);
                return (
                  <tr key={r.id}>
                    <td>{canSelect && <input type="checkbox" style={{ width: "auto" }} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />}</td>
                    <td className="dim">{r.contacts?.campaign || "—"}</td>
                    <td><div>{r.contacts?.name}</div><div className="faint">{r.contacts?.email}</div></td>
                    <td className="dim" style={{ maxWidth: 280 }}>{r.contacts?.issue}{r.message_notes && <div className="faint" style={{ marginTop: 4 }}>💬 {r.message_notes}</div>}</td>
                    <td><Badge status={r.status} /></td>
                    {tab === "pending" && <td style={{ color: dpColor }}>{dp ?? "—"}d</td>}
                    <td className="dim">{r.followups || 0}</td>
                    <td className="row" style={{ gap: 6 }}>
                      <button className="btn" style={{ padding: "4px 8px", fontSize: 11 }} onClick={() => openHistory(r)}>History</button>
                      {!["resolved"].includes(r.status) && (
                        <button className="btn btn-purple" style={{ padding: "4px 8px", fontSize: 11 }} onClick={() => resolveOne(r.id)}>Resolve</button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {view.length === 0 && <tr><td colSpan={8} className="dim" style={{ padding: 24, textAlign: "center" }}>Nothing here. {tab === "reachout" ? "Import a table to get started." : ""}</td></tr>}
            </tbody>
          </table>
        </>
      )}

      {history && (
        <div className="card" style={{ position: "fixed", right: 16, top: 70, bottom: 16, width: 360, overflowY: "auto", zIndex: 50 }}>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
            <strong>{history.record.contacts?.name}</strong>
            <button className="btn" onClick={() => setHistory(null)}>✕</button>
          </div>
          {history.events.map((e) => (
            <div key={e.id} style={{ borderLeft: "2px solid var(--line)", paddingLeft: 10, marginBottom: 10 }}>
              <div className="faint">{new Date(e.created_at).toLocaleString()}</div>
              <div className="dim">{e.action.replace(/_/g, " ")} {e.new_status ? `→ ${e.new_status}` : ""}</div>
              {e.payload?.summary && <div className="faint">"{e.payload.summary}"</div>}
            </div>
          ))}
          {history.events.length === 0 && <p className="dim">No events yet.</p>}
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
