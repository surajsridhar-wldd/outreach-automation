"use client";
import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { tabOf, chipsOf, labelOf } from "@/lib/ledger.mjs";

// One tracker for everything: issues the DMS check finds and issues you add by hand live in the same list, follow the
// same nudge schedule and collect replies the same way. A small "DMS" / "Manual" tag shows where each came from.

const TABS = [
  ["outreach", "Outreach", "Added by you, not sent yet."],
  ["inflight", "In Flight", "Everything open and being followed up, from the DMS check and from you."],
  ["review", "Review", "Things that need a person: replies to read, missing owners, unclear cases."],
  ["snoozed", "Snoozed", "Paused until a date. Nothing goes out until then."],
  ["resolved", "Resolved", "Closed by DMS (it stopped flagging them) or by you. Last 60 days."],
];
const KIND = {
  needs_owner: "Needs owner", low_confidence: "Please check", ambiguous_redirect: "Who is the new owner?", ladder_exhausted: "Five nudges, no result",
  false_done_twice: "Said done twice, still pending", dispute: "Disputes an item", question: "Asked a question", blocked: "Blocked",
  manager_missing: "No manager on file", send_failed: "Send problem", sync_guard: "Suspicious DMS read",
};
const when = (t) => (t ? new Date(t).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
const day = (t) => (t ? new Date(t).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" }) : "");
const addDaysIso = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const monthEnd = (d) => { const x = new Date(`${d}T00:00:00Z`); return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); };

export default function Tracker() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState("inflight");
  const [sel, setSel] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [src, setSrc] = useState("");
  const [chip, setChip] = useState("");
  const [drawer, setDrawer] = useState(null);
  const [snooze, setSnooze] = useState(null);
  const [imp, setImp] = useState({ open: false, text: "", sheet: "", category: "revenue_mismatch", auto: true });

  const load = useCallback(async () => {
    const r = await fetch("/api/ledger"); const j = await r.json();
    if (!r.ok) return setErr(j.error || "Could not load");
    setErr(null); setD(j);
  }, []);
  useEffect(() => { load(); const f = () => document.visibilityState === "visible" && load(); document.addEventListener("visibilitychange", f); return () => document.removeEventListener("visibilitychange", f); }, [load]);
  useEffect(() => { setSel(new Set()); }, [tab]);
  const show = (m, bad) => { setToast({ m, bad }); setTimeout(() => setToast(null), 7000); };

  async function post(body, url = "/api/ledger") {
    setBusy(true);
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({})); setBusy(false);
    if (!r.ok) { show(j.error || "Something went wrong", true); return null; }
    await load(); return j;
  }

  const people = useMemo(() => new Map((d?.people || []).map((p) => [p.dms_user_id, p])), [d]);
  const today = d?.today;
  const rows = useMemo(() => (d?.issues || []).map((i) => ({ ...i, person: people.get(i.owner_dms_user_id), tab: tabOf(i, today), chips: chipsOf(i, today) })), [d, people, today]);
  const counts = useMemo(() => {
    const c = { outreach: 0, inflight: 0, snoozed: 0, resolved: 0 };
    for (const r of rows) c[r.tab]++;
    c.review = d?.review.length || 0;
    return c;
  }, [rows, d]);

  const ql = q.trim().toLowerCase();
  const list = rows.filter((r) => r.tab === tab
    && (!cat || r.category === cat) && (!src || r.source === src)
    && (!chip || r.chips.includes(chip))
    && (!ql || [r.campaign_name, r.issue_text, r.person?.name, r.person?.email, labelOf(r.category)].some((x) => (x || "").toLowerCase().includes(ql))));
  const chosen = list.filter((r) => sel.has(r.id));
  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allOn = list.length > 0 && chosen.length === list.length;

  async function sendNow(items) {
    const ids = items.map((r) => r.id);
    const people2 = new Set(items.map((r) => r.owner_dms_user_id)).size;
    const nudgedToday = items.filter((r) => r.last_nudged_at && day(r.last_nudged_at) === day(new Date())).length;
    const extra = nudgedToday ? `\n\n${nudgedToday} of these were already nudged today.` : "";
    if (!confirm(`Send ${ids.length} nudge${ids.length === 1 ? "" : "s"} to ${people2} ${people2 === 1 ? "person" : "people"} now?\n\nThis goes out immediately, whatever the day or time. Later follow-ups continue from here.${extra}`)) return;
    const r = await post({ action: "send", ids });
    if (r) { show(`Sent ${r.sent} email${r.sent === 1 ? "" : "s"}${r.failed ? `, ${r.failed} failed` : ""}${r.skippedUnreachable ? `, ${r.skippedUnreachable} skipped (address bounced)` : ""}${r.notSent?.length ? `, ${r.notSent.length} have no owner` : ""}.`); setSel(new Set()); }
  }
  async function doImport() {
    const r = await post({ action: "import", csvText: imp.sheet ? undefined : imp.text, sheetUrl: imp.sheet || undefined, category: imp.category, autoFollowups: imp.auto });
    if (!r) return;
    show(`Added ${r.created}${r.refreshed ? `, refreshed ${r.refreshed}` : ""}${r.skipped.length ? `, skipped ${r.skipped.length}: ${r.skipped.slice(0, 3).map((s) => `${s.row.name || s.row.email} (${s.why})`).join("; ")}${r.skipped.length > 3 ? "…" : ""}` : ""}`, r.skipped.length > 0 && r.created === 0);
    setImp({ ...imp, text: "", sheet: "", open: r.skipped.length > 0 });
  }
  async function togglePause() {
    if (!d.paused && !confirm("Pause all sending? Nothing (automatic or manual) will go out until you resume. The DMS check keeps running.")) return;
    await post({ action: d.paused ? "resume" : "pause" }, "/api/nudges");
  }
  async function openDrawer(id) { setDrawer({ id, loading: true }); const j = await (await fetch(`/api/ledger/${id}`)).json(); setDrawer({ id, ...j }); }

  if (err) return <div className="main"><div className="page-header"><h1>Tracker</h1><p>{err}</p></div><p>The tracker is for admins. <Link href="/tracker-legacy">Open the old tracker</Link>.</p></div>;
  if (!d) return <div className="main"><p>Loading…</p></div>;

  return (
    <div>
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div><h1>Tracker</h1><p>{TABS.find((t) => t[0] === tab)[2]}</p></div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="badge" style={{ background: d.paused ? "var(--red-bg)" : "var(--green-bg)", color: d.paused ? "var(--red)" : "var(--green)", border: "1px solid var(--line)" }}>
            {d.paused ? "Automation paused" : `Automation ${d.mode}`}{d.lastRun ? ` · last run ${when(d.lastRun.at)}` : ""}
          </span>
          <button className={`btn btn-sm ${d.paused ? "btn-green" : "btn-red"}`} disabled={busy} onClick={togglePause}>{d.paused ? "▶ Resume" : "⏸ Pause"}</button>
        </div>
      </div>
      {d.lastRun?.notes?.length > 0 && <p style={{ background: "var(--orange-bg)", border: "1px solid var(--orange-border)", borderRadius: 8, padding: "8px 12px", marginBottom: 12, fontSize: 13 }}>Last run needs attention: {d.lastRun.notes.join(" · ")}</p>}
      {toast && <div style={{ background: toast.bad ? "var(--red-bg)" : "var(--green-bg)", border: `1px solid ${toast.bad ? "var(--red-border)" : "var(--green-border)"}`, borderRadius: 8, padding: "8px 12px", marginBottom: 12, fontSize: 13 }}>{toast.m}</div>}

      <div className="tabs">
        {TABS.map(([k, l]) => <button key={k} className={`tab-btn ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{l} <span className="tab-count">{counts[k]}</span></button>)}
      </div>

      {tab !== "review" && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <input style={{ maxWidth: 320 }} placeholder="Search person, campaign, category or issue…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select style={{ width: 190 }} value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="">All categories</option>
            {[...new Set(rows.map((r) => r.category))].sort().map((c) => <option key={c} value={c}>{labelOf(c)}</option>)}
          </select>
          <select style={{ width: 170 }} value={src} onChange={(e) => setSrc(e.target.value)}>
            <option value="">DMS + added by me</option><option value="mongo">Found by DMS check</option><option value="manual">Added by me</option>
          </select>
          {tab === "inflight" && (
            <select style={{ width: 210 }} value={chip} onChange={(e) => setChip(e.target.value)}>
              <option value="">Any status</option><option>Needs owner</option><option>Said done, still pending</option><option>Ladder finished</option><option>No automatic follow-ups</option>
            </select>
          )}
        </div>
      )}

      {tab === "outreach" && (
        <div style={{ border: "1px solid var(--line)", borderRadius: 10, background: "#fff", padding: 14, marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <b>Add issues</b>
            <button className="btn btn-sm" onClick={() => setImp({ ...imp, open: !imp.open })}>{imp.open ? "Hide" : "Paste / import"}</button>
          </div>
          {imp.open && (<div style={{ marginTop: 10, display: "grid", gap: 8 }}>
            <p style={{ color: "var(--dim)", fontSize: 13 }}>Paste rows with a header line. Columns: <b>name</b>, <b>email</b>, <b>campaign</b>, <b>issue</b> (the text the person will see), optional <b>category</b>. Issues the DMS check already finds (invoices, closings, proposals, creator links, screenshots, zero-cost services) are added automatically and are not imported by hand.</p>
            <textarea rows={6} placeholder={"name\temail\tcampaign\tissue\nPriya Sharma\tpriya@wldd.in\tXiaomi Plan 3\tThe value on DMS is different from Finance (498,000). Please check and edit."} value={imp.text} onChange={(e) => setImp({ ...imp, text: e.target.value })} />
            <input placeholder="…or a Google Sheet link" value={imp.sheet} onChange={(e) => setImp({ ...imp, sheet: e.target.value })} />
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <label>Category (if no category column)&nbsp;
                <select style={{ width: 200, display: "inline-block" }} value={imp.category} onChange={(e) => setImp({ ...imp, category: e.target.value })}>
                  {d.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select></label>
              <label><input type="checkbox" style={{ width: "auto" }} checked={imp.auto} onChange={(e) => setImp({ ...imp, auto: e.target.checked })} /> Follow up automatically after the first send</label>
              <button className="btn btn-primary" disabled={busy || !(imp.text.trim() || imp.sheet.trim())} onClick={doImport}>Add to Outreach</button>
            </div>
          </div>)}
        </div>
      )}

      {chosen.length > 0 && tab !== "review" && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 10px", padding: "8px 12px", background: "var(--blue-bg)", border: "1px solid var(--blue-border)", borderRadius: 8, flexWrap: "wrap" }}>
          <b>{chosen.length} selected</b>
          {["outreach", "inflight", "snoozed"].includes(tab) && <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => sendNow(chosen)}>{tab === "outreach" ? "Send now" : "Nudge now"}</button>}
          {["inflight"].includes(tab) && <button className="btn btn-sm" disabled={busy} onClick={() => setSnooze({ ids: chosen.map((r) => r.id) })}>Snooze…</button>}
          {tab === "snoozed" && <button className="btn btn-sm" disabled={busy} onClick={() => post({ action: "unsnooze", ids: chosen.map((r) => r.id) })}>Un-snooze</button>}
          {["inflight", "snoozed", "outreach"].includes(tab) && <button className="btn btn-sm" disabled={busy} title="Only issues you added yourself. The DMS check closes its own." onClick={async () => { const r = await post({ action: "resolve", ids: chosen.map((x) => x.id) }); if (r) show(`Resolved ${r.resolved}${r.leftToDms ? `. ${r.leftToDms} found by the DMS check will close on their own when DMS stops flagging them (use Snooze to pause them)` : ""}`); }}>Resolve</button>}
          {tab === "outreach" && <button className="btn btn-sm btn-red" disabled={busy} onClick={() => confirm("Discard the selected drafts?") && post({ action: "discard", ids: chosen.map((r) => r.id) })}>Discard</button>}
          {["inflight", "snoozed", "outreach"].includes(tab) && <>
            <button className="btn btn-sm" disabled={busy} onClick={() => post({ action: "followups", ids: chosen.map((r) => r.id), on: true })}>Auto follow-ups on</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => post({ action: "followups", ids: chosen.map((r) => r.id), on: false })}>Off</button></>}
          {tab === "resolved" && <button className="btn btn-sm" disabled={busy} onClick={() => post({ action: "reopen", ids: chosen.map((r) => r.id) })}>Reopen</button>}
          <button className="btn btn-sm" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}

      {tab === "review" ? <ReviewList d={d} busy={busy} post={post} openDrawer={openDrawer} /> : (
        <div className="tbl-wrap"><table>
          <thead><tr>
            <th style={{ width: 28 }}><input type="checkbox" style={{ width: "auto" }} checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(list.map((r) => r.id)))} /></th>
            <th>Campaign / issue</th><th>Category</th><th>Person</th><th>Nudges</th><th>{tab === "resolved" ? "Closed" : "Last nudged"}</th><th>Status</th>
          </tr></thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => openDrawer(r.id)}>
                <td onClick={(e) => e.stopPropagation()}><input type="checkbox" style={{ width: "auto" }} checked={sel.has(r.id)} onChange={() => toggle(r.id)} /></td>
                <td><b>{r.campaign_name}</b>{r.category === "zero_cost_services" && r.detail?.service ? <span style={{ color: "var(--dim)" }}> · {r.detail.service}</span> : null}
                  {r.issue_text ? <div style={{ color: "var(--dim)", fontSize: 12, maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.issue_text}</div> : null}</td>
                <td>{labelOf(r.category)}</td>
                <td>{r.person ? <>{r.person.name}<div style={{ color: "var(--dim)", fontSize: 12 }}>{r.person.email}</div></> : <span style={{ color: "var(--red)" }}>No owner</span>}</td>
                <td>{r.nudge_count}</td>
                <td>{tab === "resolved" ? `${day(r.cleared_at)} · ${r.resolved_by ? "by you" : "DMS"}` : day(r.last_nudged_at) || "–"}</td>
                <td>{r.chips.map((c) => <span key={c} className="badge" style={{ marginRight: 4, background: "var(--bg)", border: "1px solid var(--line)", color: "var(--dim)" }}>{c}</span>)}</td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--dim)", padding: 24 }}>{tab === "outreach" ? "Nothing waiting to be sent. Paste issues above to add them." : "Nothing here."}</td></tr>}
          </tbody></table></div>
      )}
      <p style={{ marginTop: 16, fontSize: 12, color: "var(--dim)" }}><Link href="/tracker-legacy">Open the old tracker</Link> · run log, replies and settings are under Admin → Automation</p>

      {snooze && <SnoozeModal today={today} onClose={() => setSnooze(null)} onPick={async (until) => { const r = await post({ action: "snooze", ids: snooze.ids, until }); if (r) { show(`Snoozed until ${until}`); setSnooze(null); setSel(new Set()); } }} />}
      {drawer && <Drawer drawer={drawer} row={rows.find((r) => r.id === drawer.id)} onClose={() => setDrawer(null)} post={post} busy={busy} sendNow={sendNow} today={today} reload={async () => { await load(); await openDrawer(drawer.id); }} />}
    </div>
  );
}

function ReviewList({ d, busy, post, openDrawer }) {
  const needsOwner = d.issues.filter((i) => i.state !== "cleared" && i.owner_state && i.owner_state !== "active");
  const [owner, setOwner] = useState({});
  return (<>
    {needsOwner.length > 0 && (<>
      <h3 style={{ margin: "4px 0 6px" }}>Needs an owner ({needsOwner.length})</h3>
      <p style={{ color: "var(--dim)", marginBottom: 8, fontSize: 13 }}>The campaign lead in DMS is deleted or missing. Nobody is nudged for these until you assign someone (or DMS gets a new lead).</p>
      <div className="tbl-wrap" style={{ marginBottom: 18 }}><table><thead><tr><th>Campaign</th><th>Category</th><th>Assign to (email)</th></tr></thead><tbody>
        {needsOwner.map((i) => (<tr key={i.id}><td><a onClick={() => openDrawer(i.id)} style={{ cursor: "pointer" }}>{i.campaign_name}</a></td><td>{labelOf(i.category)}</td>
          <td style={{ display: "flex", gap: 6 }}><input style={{ maxWidth: 260 }} placeholder="name@wldd.in" value={owner[i.id] || ""} onChange={(e) => setOwner({ ...owner, [i.id]: e.target.value })} />
            <button className="btn btn-sm btn-primary" disabled={busy || !owner[i.id]} onClick={() => post({ action: "reassign", ids: [i.id], email: owner[i.id] })}>Assign</button></td></tr>))}
      </tbody></table></div></>)}
    <h3 style={{ margin: "4px 0 6px" }}>To check ({d.review.length})</h3>
    <div className="tbl-wrap"><table><thead><tr><th>What</th><th>Campaign</th><th>Detail</th><th>When</th><th></th></tr></thead><tbody>
      {d.review.map((r) => (<tr key={r.id}>
        <td><b>{KIND[r.kind] || r.kind}</b></td><td>{r.issues?.campaign_name || r.payload?.campaign_name || ""}</td><td>{r.note}</td><td>{when(r.created_at)}</td>
        <td style={{ whiteSpace: "nowrap" }}>
          {r.payload?.type === "zero_cost" && <>
            <button className="btn btn-sm" disabled={busy} title="Never nudge this campaign and service" onClick={() => post({ action: "zero_cost_decide", reviewId: r.id, decision: "exclude" }, "/api/nudges")}>Exclude for good</button>{" "}
            <button className="btn btn-sm btn-primary" disabled={busy} title="Always nudge it" onClick={() => post({ action: "zero_cost_decide", reviewId: r.id, decision: "nudge" }, "/api/nudges")}>Nudge this</button>{" "}</>}
          <button className="btn btn-sm" disabled={busy} onClick={() => post({ action: "resolve_review", id: r.id }, "/api/nudges")}>Mark done</button>
        </td></tr>))}
      {!d.review.length && <tr><td colSpan={5} style={{ textAlign: "center", color: "var(--dim)", padding: 24 }}>Nothing needs you.</td></tr>}
    </tbody></table></div>
  </>);
}

function SnoozeModal({ today, onClose, onPick }) {
  const [date, setDate] = useState(addDaysIso(today, 7));
  const quick = [["+3 days", addDaysIso(today, 3)], ["+1 week", addDaysIso(today, 7)], ["+2 weeks", addDaysIso(today, 14)], ["End of month", monthEnd(today)]];
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200 }} onClick={onClose}>
      <div style={{ background: "#fff", borderRadius: 12, padding: 20, width: 380 }} onClick={(e) => e.stopPropagation()}>
        <h3>Snooze until…</h3>
        <p style={{ color: "var(--dim)", fontSize: 13, margin: "6px 0 12px" }}>Nothing goes out for these until the day after this date. Replies asking for time do this automatically.</p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>{quick.map(([l, v]) => <button key={l} className="btn btn-sm" onClick={() => setDate(v)}>{l}</button>)}</div>
        <input type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => onPick(date)}>Snooze</button></div>
      </div>
    </div>
  );
}

function Drawer({ drawer, row, onClose, post, busy, sendNow, today, reload }) {
  const [note, setNote] = useState(null);
  const i = drawer.issue;
  const owner = drawer.people?.find((p) => p.dms_user_id === i?.owner_dms_user_id);
  const timeline = [
    ...(drawer.messages || []).map((m) => ({ at: m.sent_at || m.created_at, kind: "sent", text: `${m.channel === "slack" ? "Slack" : "Email"} ${m.kind} to ${m.to_address || "…"} (${m.status}${m.mode !== "live" ? `, ${m.mode}` : ""})${m.subject ? ` – ${m.subject}` : ""}` })),
    ...(drawer.replies || []).map((r) => ({ at: r.messages_in?.received_at || r.created_at, kind: "reply", text: `Reply from ${r.messages_in?.sender_address || "?"}, read as “${r.intent}”${r.promised_date ? ` (${r.promised_date})` : ""}: ${r.evidence || ""}` })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));
  return (
    <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 470, maxWidth: "100vw", background: "#fff", borderLeft: "1px solid var(--line)", boxShadow: "var(--shadow-md)", zIndex: 150, overflow: "auto", padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}><h3>{row?.campaign_name || "…"}</h3><button className="btn btn-sm" onClick={onClose}>Close</button></div>
      {drawer.loading || !i ? <p>Loading…</p> : (<>
        <p style={{ color: "var(--dim)", margin: "4px 0 10px" }}>{labelOf(i.category)}{i.detail?.service ? ` · ${i.detail.service}` : ""} · {i.source === "manual" ? "added by you" : "found by the DMS check"}</p>
        {i.issue_text && <p style={{ background: "var(--bg)", padding: 10, borderRadius: 8, marginBottom: 10, whiteSpace: "pre-wrap" }}>{i.issue_text}</p>}
        {i.detail?.internal_note && <p style={{ marginBottom: 10 }}><b>DMS note:</b> {i.detail.internal_note}</p>}
        <p><b>Owner:</b> {owner ? `${owner.name} (${owner.email})` : "none"}{owner?.manager_email ? ` · manager ${owner.manager_email}` : ""}</p>
        {(drawer.owners || []).filter((o) => o.active).map((o) => <p key={o.id}><b>{o.role === "co_owner" ? "Also:" : "Reassigned to:"}</b> {drawer.people?.find((p) => p.dms_user_id === o.dms_user_id)?.name || o.dms_user_id}</p>)}
        <p><b>Nudges sent:</b> {i.nudge_count}{i.false_done_claims ? ` · said “done” while still pending ${i.false_done_claims}×` : ""}{i.hold_until ? ` · snoozed to ${i.hold_until}${i.hold_reason ? ` (${i.hold_reason})` : ""}` : ""}</p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "12px 0" }}>
          {i.state !== "cleared" && <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => sendNow([{ ...i, id: i.id }]).then(reload)}>{i.state === "draft" ? "Send now" : "Nudge now"}</button>}
          {i.state === "open" && i.hold_until >= today && <button className="btn btn-sm" disabled={busy} onClick={() => post({ action: "unsnooze", ids: [i.id] }).then(reload)}>Un-snooze</button>}
          {i.source === "manual" && i.state !== "cleared" && <button className="btn btn-sm" disabled={busy} onClick={() => post({ action: "resolve", ids: [i.id] }).then(reload)}>Resolve</button>}
          {i.source === "manual" && <button className="btn btn-sm" disabled={busy} onClick={() => post({ action: "followups", ids: [i.id], on: i.auto_followups === false }).then(reload)}>{i.auto_followups === false ? "Turn auto follow-ups on" : "Turn auto follow-ups off"}</button>}
          {i.category === "zero_cost_services" && i.state === "open" && <button className="btn btn-sm" disabled={busy} onClick={() => confirm("Never nudge this campaign and service again?") && post({ action: "zero_cost_exclude", campaign_id: i.campaign_id, campaign_name: i.campaign_name, service: i.detail?.service }, "/api/nudges").then(reload)}>Exclude for good</button>}
        </div>
        <h4 style={{ margin: "14px 0 6px" }}>History</h4>
        {timeline.length ? timeline.map((t, k) => <p key={k} style={{ fontSize: 13, margin: "0 0 6px", color: t.kind === "reply" ? "var(--text)" : "var(--dim)" }}><b>{when(t.at)}</b> · {t.text}</p>) : <p style={{ color: "var(--dim)", fontSize: 13 }}>Nothing sent yet.</p>}
        {(drawer.review || []).filter((r) => r.status === "open").map((r) => <p key={r.id} style={{ fontSize: 13 }}>⚑ {KIND[r.kind] || r.kind}: {r.note}</p>)}
        <h4 style={{ margin: "14px 0 6px" }}>Notes</h4>
        <textarea rows={3} value={note ?? i.notes ?? ""} onChange={(e) => setNote(e.target.value)} placeholder="Private notes (e.g. lead said this is handled offline)" />
        <button className="btn btn-sm" style={{ marginTop: 6 }} disabled={busy || note === null} onClick={() => post({ action: "note", ids: [i.id], text: note }).then(() => setNote(null))}>Save note</button>
      </>)}
    </div>
  );
}
