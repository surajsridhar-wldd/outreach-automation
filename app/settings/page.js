"use client";
import { useEffect, useState } from "react";

export default function Settings() {
  const [me, setMe] = useState(null);
  const [sheetUrl, setSheetUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [categories, setCategories] = useState([]);
  const [newCat, setNewCat] = useState({ tag:"", name:"", description:"", done_definition:"", is_time_sensitive:false });
  const [catBusy, setCatBusy] = useState(false);
  const [backfill, setBackfill] = useState(null);   // { untagged, checkable }
  const [backfillRunning, setBackfillRunning] = useState(null); // null | 'tag' | 'attr'
  const [backfillMsg, setBackfillMsg] = useState("");

  useEffect(() => { fetch("/api/me").then(r => r.json()).then(setMe); }, []);
  useEffect(() => {
    fetch("/api/categories").then(r => r.json()).then(d => setCategories(d.categories || []));
  }, []);
  useEffect(() => {
    fetch("/api/backfill").then(r => r.ok ? r.json() : null).then(d => d && setBackfill(d)).catch(()=>{});
  }, []);
  function show(m) { setToast(m); setTimeout(() => setToast(null), 4000); }

  const [recatMsg, setRecatMsg] = useState("");
  const [recatBusy, setRecatBusy] = useState(false);

  async function addCategory() {
    if (!newCat.tag.trim() || !newCat.name.trim()) return;
    setCatBusy(true);
    const r = await fetch("/api/categories", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(newCat) }).then(r=>r.json());
    setCatBusy(false);
    if (r.error) return show("⚠ " + r.error);
    setCategories(c => [...c, r.category]);
    setNewCat({ tag:"", name:"", description:"", done_definition:"", is_time_sensitive:false });
    show("✅ Category added — click 'Re-check uncategorized' below to see if existing records now fit it");
  }
  async function runRecategorize(scope) {
    setRecatBusy(true);
    setRecatMsg(scope==="all" ? "Re-checking ALL records against your current categories…" : "Re-checking uncategorized records…");
    try {
      let guard = 0, totalTagged = 0, totalChanged = 0;
      while (guard++ < 20) {
        const res = await fetch("/api/recategorize", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ scope }) }).then(r=>r.json());
        if (!res || res.error) { setRecatMsg("⚠ " + (res?.error||"Failed") + (res?.diag?` · ${JSON.stringify(res.diag)}`:"")); break; }
        totalTagged += res.tagged||0; totalChanged += res.changed||0;

        // If a pass processed 0 items (or 0 got tagged with nothing left to explain
        // why), show the diagnostics instead of just looping/stopping silently.
        if ((res.diag?.itemsWithIssue||0) === 0 || (res.diag?.categorizeError)) {
          const d = res.diag || {};
          const parts = [
            `categories: ${d.categoriesLoaded ?? "?"} (${(d.categoryTags||[]).join(", ")})`,
            `reopened: ${d.reopenedCount ?? "?"}`,
            `found: ${d.recordsFetched ?? "?"}`,
            `with issue text: ${d.itemsWithIssue ?? "?"}`,
          ];
          if (d.categorizeError) parts.push(`categorize error: ${d.categorizeError}`);
          if (d.updateError) parts.push(`update error: ${d.updateError}`);
          setRecatMsg(`${totalChanged===0 && totalTagged===0 ? "⚠ Nothing changed." : "✓ Done."} Diagnostics — ${parts.join(" · ")}`);
          break;
        }

        setRecatMsg(`Checked ${totalTagged}, ${totalChanged} now categorized… ${res.remaining} remaining`);
        if ((res.remaining||0) === 0 || (res.tagged||0) === 0) break;
      }
      setRecatMsg(m => (m.startsWith("⚠")||m.includes("Diagnostics")) ? m : `✓ Done — ${totalChanged} record(s) newly categorized.`);
    } catch (e) { setRecatMsg("⚠ " + e.message); }
    setRecatBusy(false);
  }
  async function deleteCategory(id) {
    await fetch("/api/categories", { method:"DELETE", headers:{"content-type":"application/json"}, body:JSON.stringify({ id }) });
    setCategories(c => c.filter(x => x.id !== id));
    show("Category removed");
  }

  async function runBackfill(kind) {
    setBackfillRunning(kind);
    setBackfillMsg(kind === "tag" ? "Tagging existing records…" : "Re-checking replies on existing records…");
    try {
      let guard = 0, totalTagged = 0, totalChecked = 0;
      while (guard++ < 40) {
        const body = kind === "tag" ? { tag:true } : { tag:false, attribution:true };
        const res = await fetch("/api/backfill", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body) }).then(r=>r.json());
        if (!res || res.error) { show("⚠ " + (res?.error || "Backfill failed")); break; }
        totalTagged += res.tagged || 0; totalChecked += res.checked || 0;
        const remaining = kind === "tag" ? res.taggedRemaining : res.checkedRemaining;

        // If a tag pass made zero progress, surface diagnostics instead of looping pointlessly.
        if (kind === "tag" && (res.tagged || 0) === 0) {
          const diag = [];
          if (res.tagError) diag.push(`error: ${res.tagError}`);
          if (res.updateError) diag.push(`db update: ${res.updateError}`);
          if (typeof res.tagFound === "number") diag.push(`found ${res.tagFound}`);
          if (typeof res.catsLoaded === "number") diag.push(`categories ${res.catsLoaded}`);
          if (res.catDebug) diag.push(`catDebug ${JSON.stringify(res.catDebug)}`);
          if (typeof res.itemsWithIssue === "number") diag.push(`items w/ issue ${res.itemsWithIssue}`);
          if (res.sampleResult) diag.push(`sample ${res.sampleResult}`);
          setBackfillMsg(`⚠ Tagged 0. Diagnostics — ${diag.join(" · ") || "no info"}`);
          break;
        }

        setBackfillMsg(kind === "tag"
          ? `Tagged ${totalTagged}… ${remaining} remaining`
          : `Re-checked ${totalChecked}… ${remaining} remaining`);
        if ((remaining || 0) === 0) break;
      }
      if (!(kind === "tag" && totalTagged === 0)) {
        setBackfillMsg(kind === "tag" ? `✓ Done — tagged ${totalTagged} records.` : `✓ Done — re-checked ${totalChecked} records.`);
      }
      fetch("/api/backfill").then(r=>r.json()).then(setBackfill).catch(()=>{});
    } catch (e) {
      setBackfillMsg("⚠ " + e.message);
    }
    setBackfillRunning(null);
  }

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

      <div className="settings-section">
        <h2>🏷️ Issue Categories</h2>
        <p>Categories are shared across your whole org. New imports are auto-tagged into one of these by Claude. They power category-scoped reconciliation and the per-category frequency view.</p>
        <div style={{ marginBottom:16 }}>
          {categories.length === 0 ? (
            <p style={{ fontSize:13, color:"#9ca3af" }}>No categories yet — add some below, or run the migration which seeds the standard 5.</p>
          ) : categories.map(c => (
            <div key={c.id} style={{ display:"flex", alignItems:"flex-start", gap:12, padding:"10px 0", borderBottom:"1px solid #f3f4f6" }}>
              <div style={{ flex:1 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <code style={{ background:"#f3f4f6", padding:"2px 6px", borderRadius:4, fontSize:11, fontWeight:600 }}>{c.tag}</code>
                  <strong style={{ fontSize:13 }}>{c.name}</strong>
                  {c.is_time_sensitive && <span style={{ background:"#fef2f2", color:"#dc2626", border:"1px solid #fecaca", borderRadius:99, padding:"1px 8px", fontSize:10, fontWeight:600 }}>⏱ time-sensitive</span>}
                </div>
                {c.description && <div style={{ fontSize:12, color:"#6b7280", marginTop:2 }}>{c.description}</div>}
                {c.done_definition && <div style={{ fontSize:11, color:"#9ca3af", marginTop:2 }}>Done when: {c.done_definition}</div>}
              </div>
              <button className="btn btn-sm" onClick={() => deleteCategory(c.id)} title="Remove category">✕</button>
            </div>
          ))}
        </div>
        <div style={{ background:"#f8f9fb", border:"1px solid #e5e7eb", borderRadius:8, padding:14 }}>
          <div style={{ fontWeight:600, fontSize:13, marginBottom:10 }}>Add a category</div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:8 }}>
            <input placeholder="TAG_LIKE_THIS" value={newCat.tag} onChange={e=>setNewCat(n=>({...n,tag:e.target.value}))} />
            <input placeholder="Display name" value={newCat.name} onChange={e=>setNewCat(n=>({...n,name:e.target.value}))} />
          </div>
          <textarea rows={2} placeholder="Description — what defines this category (helps Claude tag accurately)" value={newCat.description} onChange={e=>setNewCat(n=>({...n,description:e.target.value}))} style={{ resize:"vertical", marginBottom:8, width:"100%" }} />
          <input placeholder="Done definition (e.g. 'Values reconciled on DMS')" value={newCat.done_definition} onChange={e=>setNewCat(n=>({...n,done_definition:e.target.value}))} style={{ marginBottom:8, width:"100%" }} />
          <div className="toggle-row" style={{ marginBottom:10 }}>
            <input type="checkbox" id="ts" checked={newCat.is_time_sensitive} onChange={e=>setNewCat(n=>({...n,is_time_sensitive:e.target.checked}))} />
            <label htmlFor="ts">Time-sensitive (has a hard deadline like month-end)</label>
          </div>
          <button className="btn btn-primary btn-sm" disabled={catBusy||!newCat.tag.trim()||!newCat.name.trim()} onClick={addCategory}>{catBusy?"Adding…":"Add category"}</button>
        </div>

        <div style={{ marginTop:16, background:"#fffbeb", border:"1px solid #fde68a", borderRadius:8, padding:14 }}>
          <div style={{ fontWeight:600, fontSize:13, marginBottom:6 }}>Re-check categorization</div>
          <p style={{ fontSize:12, color:"#92400e", marginBottom:10 }}>
            Once a record has been checked against your categories, it's normally never re-checked automatically — so adding a NEW category later won't retroactively apply to older records unless you re-check them here.
          </p>
          <div style={{ display:"flex", gap:10, flexWrap:"wrap", alignItems:"center" }}>
            <button className="btn btn-sm" disabled={recatBusy} onClick={()=>runRecategorize("uncategorized")}>{recatBusy?"Checking…":"Re-check uncategorized records"}</button>
            <button className="btn btn-sm" disabled={recatBusy} onClick={()=>runRecategorize("all")}>{recatBusy?"Checking…":"Re-check ALL records"}</button>
          </div>
          {recatMsg && <div style={{ fontSize:12, color:"#92400e", marginTop:8 }}>{recatMsg}</div>}
        </div>
      </div>

      {me.role === "admin" && backfill && (
        <div className="settings-section">
          <h2>🔄 One-time Backfill</h2>
          <p>Run once after the migration to apply the new logic to records that already exist. Safe to run anytime; uses Claude credits.</p>
          <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
            <div style={{ display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
              <button className="btn btn-primary btn-sm" disabled={!!backfillRunning} onClick={()=>runBackfill("tag")}>
                {backfillRunning==="tag"?"Tagging…":`Tag ${backfill.untagged} existing records`}
              </button>
              <span style={{ fontSize:12, color:"#6b7280" }}>Categorizes every record that has no category yet.</span>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
              <button className="btn btn-sm" disabled={!!backfillRunning} onClick={()=>runBackfill("attr")}>
                {backfillRunning==="attr"?"Re-checking…":`Re-check replies on ${backfill.checkable} records`}
              </button>
              <span style={{ fontSize:12, color:"#6b7280" }}>Re-runs the improved reply attribution (fixes old chit-chat false-positives). Heavier — uses more credits.</span>
            </div>
            {backfillMsg && <div style={{ fontSize:13, color:"#374151", background:"#f8f9fb", border:"1px solid #e5e7eb", borderRadius:8, padding:"8px 12px" }}>{backfillMsg}</div>}
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
