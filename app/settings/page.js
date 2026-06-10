"use client";
import { useEffect, useState } from "react";

export default function Settings() {
  const [me, setMe] = useState(null);
  const [sheetUrl, setSheetUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => { fetch("/api/me").then(r => r.json()).then(setMe); }, []);
  function show(m) { setToast(m); setTimeout(() => setToast(null), 4000); }

  async function saveSettings(patch) {
    const settings = { ...me.settings, ...patch };
    setMe({ ...me, settings });
    await fetch("/api/me", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings: patch }) });
    show("✅ Saved");
  }

  async function exportSheet() {
    setBusy(true);
    const r = await fetch("/api/outreach/export").then(r => r.json());
    setBusy(false);
    if (r.error) return show("⚠ " + r.error);
    setSheetUrl(r.url);
    show("✅ Sheet created successfully");
  }

  if (!me) return <div style={{ padding: 40, color: "#9ca3af", fontSize: 13 }}>Loading…</div>;
  const s = me.settings || {};

  return (
    <div>
      <div className="page-header">
        <h1>Settings</h1>
        <p>Manage your connected accounts and outreach preferences.</p>
      </div>

      <div className="settings-section">
        <h2>📧 Gmail (Email channel)</h2>
        <p>{me.gmail_connected ? `Connected as ${me.gmail_address}. Outreach emails send from this inbox.` : "Connect Gmail so outreach emails send from your own inbox. Slack works without this."}</p>
        {me.gmail_connected ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ background: "#ecfdf5", color: "#059669", border: "1px solid #a7f3d0", borderRadius: 99, padding: "3px 12px", fontSize: 12, fontWeight: 600 }}>
              ✓ Connected — {me.gmail_address}
            </span>
            <a href="/api/auth/google" className="btn btn-sm">Reconnect</a>
          </div>
        ) : (
          <a href="/api/auth/google" className="btn btn-primary" style={{ textDecoration: "none", width: "fit-content" }}>Connect Gmail →</a>
        )}
      </div>

      <div className="settings-section">
        <h2>🔁 Auto Follow-ups</h2>
        <p>Off by default — review the Follow-ups queue manually. Enable to let the daily check send follow-ups automatically.</p>
        <div className="toggle-row" style={{ marginBottom: 12 }}>
          <input type="checkbox" id="auto" checked={!!s.auto_followup} onChange={e => saveSettings({ auto_followup: e.target.checked })} />
          <label htmlFor="auto">Send follow-ups automatically</label>
        </div>
        {s.auto_followup && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, color: "#6b7280" }}>After</span>
            <input type="number" min="1" max="14" value={s.followup_after_days ?? 1} onChange={e => saveSettings({ followup_after_days: +e.target.value })} style={{ width: 70 }} />
            <span style={{ fontSize: 13, color: "#6b7280" }}>day(s) of silence · max</span>
            <input type="number" min="1" max="5" value={s.max_followups ?? 3} onChange={e => saveSettings({ max_followups: +e.target.value })} style={{ width: 70 }} />
            <span style={{ fontSize: 13, color: "#6b7280" }}>follow-ups</span>
          </div>
        )}
      </div>

      <div className="settings-section">
        <h2>📊 Export to Google Sheet</h2>
        <p>Creates a fresh Google Sheet with all your current outreach data and shares it with you.</p>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button className="btn btn-green" disabled={busy} onClick={exportSheet}>{busy ? "Creating sheet…" : "Export Now →"}</button>
          {sheetUrl && <a href={sheetUrl} target="_blank" rel="noreferrer" className="btn btn-sm">Open Sheet ↗</a>}
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
