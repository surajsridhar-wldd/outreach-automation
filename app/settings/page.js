"use client";
import { useEffect, useState } from "react";

export default function Settings() {
  const [me, setMe] = useState(null);
  const [sheetUrl, setSheetUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => { fetch("/api/me").then((r) => r.json()).then(setMe); }, []);
  function show(m) { setToast(m); setTimeout(() => setToast(null), 5000); }

  async function saveSettings(patch) {
    const settings = { ...me.settings, ...patch };
    setMe({ ...me, settings });
    await fetch("/api/me", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings: patch }) });
    show("✅ Saved");
  }

  async function exportSheet() {
    setBusy(true);
    const r = await fetch("/api/outreach/export").then((r) => r.json());
    setBusy(false);
    if (r.error) return show("⚠ " + r.error);
    setSheetUrl(r.url);
    show("✅ Sheet created");
  }

  if (!me) return <p className="dim">Loading…</p>;
  const s = me.settings || {};

  return (
    <div>
      <h1>Settings</h1>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>📧 Email channel</h2>
        {me.gmail_connected ? (
          <p className="dim">Connected as <strong style={{ color: "var(--green)" }}>{me.gmail_address}</strong>. Outreach emails send from this inbox.</p>
        ) : (
          <>
            <p className="dim" style={{ marginBottom: 10 }}>Connect your Gmail so emails send from your own inbox. Slack works without this.</p>
            <a href="/api/auth/google" className="btn btn-blue" style={{ textDecoration: "none" }}>Connect Gmail →</a>
          </>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>🔁 Auto follow-ups</h2>
        <p className="dim" style={{ marginBottom: 10 }}>Off by default — you review the Follow-ups queue manually. Turn on to let the daily check send follow-ups automatically.</p>
        <label className="row" style={{ gap: 8, cursor: "pointer", marginBottom: 10 }}>
          <input type="checkbox" style={{ width: "auto" }} checked={!!s.auto_followup} onChange={(e) => saveSettings({ auto_followup: e.target.checked })} />
          <span className="dim">Send follow-ups automatically</span>
        </label>
        {s.auto_followup && (
          <div className="row">
            <span className="dim">after</span>
            <input type="number" min="1" max="14" value={s.followup_after_days ?? 1} onChange={(e) => saveSettings({ followup_after_days: +e.target.value })} style={{ width: 70 }} />
            <span className="dim">day(s) of silence · max</span>
            <input type="number" min="1" max="5" value={s.max_followups ?? 3} onChange={(e) => saveSettings({ max_followups: +e.target.value })} style={{ width: 70 }} />
            <span className="dim">follow-ups</span>
          </div>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>📊 Export to Google Sheet</h2>
        <p className="dim" style={{ marginBottom: 10 }}>Creates a fresh Google Sheet with all your outreach data.</p>
        <button className="btn btn-green" disabled={busy} onClick={exportSheet}>{busy ? "Creating…" : "Export Now →"}</button>
        {sheetUrl && <p style={{ marginTop: 10 }}><a href={sheetUrl} target="_blank">Open the sheet ↗</a></p>}
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
