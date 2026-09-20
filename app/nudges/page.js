"use client";
import { useEffect, useState, useCallback } from "react";

const CAT = {
  invoice_approvals: "Invoice approvals", creator_submissions: "Creator submissions", screenshot_approvals: "Screenshot approvals",
  pending_closings: "Pending closings", pending_proposals: "Pending proposals",
};
const KIND = {
  needs_owner: "Needs owner", low_confidence: "Unsure reply", ambiguous_redirect: "Who is the new owner?", ladder_exhausted: "Five nudges, no result",
  false_done_twice: "Said done twice, still pending", dispute: "Disputes an item", question: "Asked a question", blocked: "Blocked",
  manager_missing: "No manager on file", send_failed: "Send problem", sync_guard: "Suspicious DMS read",
};
const when = (t) => (t ? new Date(t).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
const n1 = (x) => (x == null ? "–" : Number(x).toFixed(1));

export default function Nudges() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState("overview");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/nudges");
    const j = await r.json();
    if (!r.ok) return setErr(j.error || "Could not load");
    setErr(null); setD(j);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function act(body) {
    setBusy(true);
    const r = await fetch("/api/nudges", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json(); setBusy(false);
    if (!r.ok) return setErr(j.error); await load();
  }

  if (err) return <div className="main"><div className="page-header"><h1>Nudges</h1><p>{err}</p></div></div>;
  if (!d) return <div className="main"><p>Loading…</p></div>;
  const paused = d.settings.paused === true;
  const last = d.runs[0];

  return (
    <div>
      <div className="page-header">
        <h1>Nudges</h1>
        <p>Automated reminders for the five DMS categories. Mode: <b>{d.settings.mode}</b>{paused ? " · PAUSED" : ""}</p>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 18, flexWrap: "wrap" }}>
        {paused
          ? <button className="btn btn-green" disabled={busy} onClick={() => act({ action: "resume" })}>▶ Resume nudging</button>
          : <button className="btn btn-red" disabled={busy} onClick={() => { if (confirm("Pause all sending? Nothing will reach anyone until you resume. Runs keep syncing DMS.")) act({ action: "pause" }); }}>⏸ Pause all sending</button>}
        <span style={{ color: "var(--dim)", fontSize: 13 }}>Pausing takes effect immediately, including for a run already in progress.</span>
      </div>

      <div className="tabs">
        {[["overview", "Overview"], ["owner", `Needs owner (${d.needsOwner.length})`], ["review", `Review (${d.review.length})`], ["zero", "Zero-cost services"], ["tracker", "Tracker"], ["messages", "Messages"], ["replies", "Replies"]].map(([k, l]) => (
          <button key={k} className={`tab-btn ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {tab === "overview" && (<>
        <div className="stat-grid">
          {[["Open issues", d.counts.open], ["On hold", d.counts.onHold], ["Claimed done, still open", d.counts.claimedDone], ["Five nudges, unresolved", d.counts.atLadderEnd], ["Needs owner", d.needsOwner.length], ["Review items", d.review.length]].map(([l, v]) => (
            <div key={l} className="stat-card"><div className="stat-num">{v}</div><div className="stat-label">{l}</div></div>
          ))}
        </div>
        <h3 style={{ margin: "8px 0" }}>Recent runs</h3>
        <div className="tbl-wrap"><table><thead><tr><th>Started</th><th>Mode</th><th>Result</th><th>Sent</th><th>Planned</th><th>Cleared</th><th>Notes</th></tr></thead><tbody>
          {d.runs.map((r) => (
            <tr key={r.id}><td>{when(r.started_at)}</td><td>{r.mode}</td><td>{r.ok === true ? "OK" : r.ok === false ? `Failed: ${r.error || ""}` : "Running"}{r.stats?.skipped ? ` (${r.stats.skipped})` : ""}</td>
              <td>{r.stats?.sent ?? ""}</td><td>{r.stats?.planned ?? ""}</td><td>{r.stats?.cleared ?? ""}</td><td>{(r.stats?.notes || []).join(" | ")}</td></tr>
          ))}
        </tbody></table></div>
        {last?.stats?.replyStats && <p style={{ color: "var(--dim)", marginTop: 10, fontSize: 13 }}>Last reply check: {last.stats.replyStats.error ? `failed (${last.stats.replyStats.error})` : last.stats.replyStats.skipped ? `skipped (${last.stats.replyStats.skipped})` : `${last.stats.replyStats.newMessages} new repl${last.stats.replyStats.newMessages === 1 ? "y" : "ies"}, model cost $${(last.stats.replyStats.cost || 0).toFixed(4)}`}</p>}
      </>)}

      {tab === "owner" && (<>
        <p style={{ color: "var(--dim)", marginBottom: 10 }}>Campaigns whose lead is deleted or missing in DMS. Nobody is nudged for these until a lead is set in DMS (or a co-owner is added).</p>
        <div className="tbl-wrap"><table><thead><tr><th>Campaign</th><th>Category</th><th>Items</th><th>Owner state</th><th>Open since</th></tr></thead><tbody>
          {d.needsOwner.map((i) => <tr key={i.id}><td>{i.campaign_name}</td><td>{CAT[i.category]}</td><td>{i.item_count}</td><td>{i.owner_state}</td><td>{when(i.first_seen_at)}</td></tr>)}
          {!d.needsOwner.length && <tr><td colSpan={5}>Nothing here.</td></tr>}
        </tbody></table></div>
      </>)}

      {tab === "review" && (
        <div className="tbl-wrap"><table><thead><tr><th>What</th><th>Campaign</th><th>Detail</th><th>When</th><th></th></tr></thead><tbody>
          {d.review.map((r) => (
            <tr key={r.id}><td><b>{KIND[r.kind] || r.kind}</b></td><td>{r.issues?.campaign_name || ""}</td><td>{r.note}</td><td>{when(r.created_at)}</td>
              <td style={{ whiteSpace: "nowrap" }}>
                {r.payload?.type === "zero_cost" ? (<>
                  <button className="btn btn-sm" disabled={busy} title="Never nudge this campaign and service" onClick={() => act({ action: "zero_cost_decide", reviewId: r.id, decision: "exclude" })}>Exclude for good</button>{" "}
                  <button className="btn btn-sm btn-primary" disabled={busy} title="Always nudge it, even though the note mentions AI or Chiraiya" onClick={() => act({ action: "zero_cost_decide", reviewId: r.id, decision: "nudge" })}>Nudge this</button>{" "}
                </>) : null}
                <button className="btn btn-sm" disabled={busy} onClick={() => act({ action: "resolve_review", id: r.id })}>Mark done</button>
              </td></tr>
          ))}
          {!d.review.length && <tr><td colSpan={5}>Nothing needs you.</td></tr>}
        </tbody></table></div>
      )}

      {tab === "zero" && (<>
        <p style={{ color: "var(--dim)", marginBottom: 10 }}>
          Services with zero deliverables and zero internal cost (Content Creation, ORM, Twitter Trend, Offline Activity) on Complete or Active campaigns. Rules are fixed and free to run: no AI is used, and every DMS check re-evaluates them from scratch.
          Your decisions below are permanent and always win over the rules.
        </p>
        {d.zeroStats && <p style={{ marginBottom: 12 }}>Last check: <b>{d.zeroStats.action}</b> to nudge, <b>{d.zeroStats.needsCheck}</b> waiting for your call in Review, <b>{d.zeroStats.autoExcluded.length}</b> excluded automatically (note says the internal team did it), <b>{d.zeroStats.decidedExcluded}</b> excluded by you.</p>}
        <h3 style={{ margin: "8px 0" }}>Your decisions ({d.zeroDecisions.length})</h3>
        <div className="tbl-wrap"><table><thead><tr><th>Campaign</th><th>Service</th><th>Decision</th><th>When</th><th></th></tr></thead><tbody>
          {d.zeroDecisions.map((x) => <tr key={x.id}><td>{x.campaign_name}</td><td>{x.service}</td><td>{x.decision === "exclude" ? "Never nudge" : "Always nudge"}</td><td>{when(x.decided_at)}</td>
            <td><button className="btn btn-sm" disabled={busy} onClick={() => act({ action: "zero_cost_undo", id: x.id })}>Undo</button></td></tr>)}
          {!d.zeroDecisions.length && <tr><td colSpan={5}>None yet.</td></tr>}
        </tbody></table></div>
        <h3 style={{ margin: "18px 0 8px" }}>Excluded automatically ({d.zeroStats?.autoExcluded.length ?? 0})</h3>
        <div className="tbl-wrap"><table><thead><tr><th>Campaign</th><th>Service</th><th>Note in DMS</th></tr></thead><tbody>
          {(d.zeroStats?.autoExcluded || []).map((x, i) => <tr key={i}><td>{x.campaign_name}</td><td>{x.service}</td><td>{x.note}</td></tr>)}
        </tbody></table></div>
        <h3 style={{ margin: "18px 0 8px" }}>Being nudged ({d.zeroIssues.length})</h3>
        <div className="tbl-wrap"><table><thead><tr><th>Campaign</th><th>Service</th><th>Owner</th><th>Nudges</th><th>Note in DMS</th><th></th></tr></thead><tbody>
          {d.zeroIssues.map((x) => <tr key={x.id}><td>{x.campaign_name}</td><td>{x.detail?.service}</td><td>{x.owner_state}</td><td>{x.nudge_count}</td><td>{x.detail?.internal_note}</td>
            <td><button className="btn btn-sm" disabled={busy} onClick={() => act({ action: "zero_cost_exclude", campaign_id: x.campaign_id, campaign_name: x.campaign_name, service: x.detail?.service })}>Exclude for good</button></td></tr>)}
        </tbody></table></div>
      </>)}

      {tab === "tracker" && (<>
        <h3 style={{ margin: "8px 0" }}>Categories</h3>
        <div className="tbl-wrap"><table><thead><tr><th>Category</th><th>Open</th><th>Cleared</th><th>Nudges sent</th><th>Avg nudges to clear</th><th>Avg days to clear</th><th>Avg age of open (days)</th></tr></thead><tbody>
          {d.cats.map((c) => <tr key={c.category}><td>{CAT[c.category]}</td><td>{c.open_issues}</td><td>{c.cleared_issues}</td><td>{c.nudges_total}</td><td>{n1(c.avg_nudges_before_clear)}</td><td>{n1(c.avg_days_to_clear)}</td><td>{n1(c.avg_open_age_days)}</td></tr>)}
        </tbody></table></div>
        <h3 style={{ margin: "18px 0 8px" }}>People who need the most chasing</h3>
        <div className="tbl-wrap"><table><thead><tr><th>Person</th><th>Manager</th><th>Open</th><th>Still open after 3 nudges</th><th>False "done"</th><th>Hold extensions</th><th>Avg days to clear</th><th>Nudges</th></tr></thead><tbody>
          {d.people.map((p) => <tr key={p.dms_user_id}><td>{p.name}</td><td>{p.manager_email || ""}</td><td>{p.open_issues}</td><td>{p.open_after_3_nudges}</td><td>{p.false_done_claims}</td><td>{p.hold_renewals}</td><td>{n1(p.avg_days_to_clear)}</td><td>{p.nudges_total}</td></tr>)}
        </tbody></table></div>
        <h3 style={{ margin: "18px 0 8px" }}>New issues per week</h3>
        <div className="tbl-wrap"><table><thead><tr><th>Week starting</th><th>Category</th><th>New</th><th>Since cleared</th></tr></thead><tbody>
          {d.weekly.map((w, i) => <tr key={i}><td>{String(w.week).slice(0, 10)}</td><td>{CAT[w.category]}</td><td>{w.new_issues}</td><td>{w.cleared_since}</td></tr>)}
        </tbody></table></div>
      </>)}

      {tab === "messages" && (
        <div className="tbl-wrap"><table><thead><tr><th>When</th><th>To</th><th>Channel</th><th>Kind</th><th>Status</th><th>Mode</th><th>Subject</th></tr></thead><tbody>
          {d.messages.map((m) => <tr key={m.id}><td>{when(m.sent_at || m.created_at)}</td><td>{m.recipient_name || m.to_address}{m.intended_to ? ` (rehearsal for ${m.intended_to})` : ""}</td><td>{m.channel}</td><td>{m.kind}</td><td>{m.status}</td><td>{m.mode}</td><td>{m.subject}</td></tr>)}
        </tbody></table></div>
      )}

      {tab === "replies" && (
        <div className="tbl-wrap"><table><thead><tr><th>Received</th><th>From</th><th>Campaign</th><th>Read as</th><th>Date</th><th>Evidence</th><th>Sure?</th></tr></thead><tbody>
          {d.replies.map((r) => <tr key={r.id}><td>{when(r.messages_in?.received_at)}</td><td>{r.messages_in?.sender_address}</td><td>{r.issues?.campaign_name || "(several)"}</td><td>{r.intent}</td><td>{r.promised_date || ""}</td><td>{r.evidence}</td><td>{r.needs_review ? "needs a look" : n1(r.confidence)}</td></tr>)}
          {!d.replies.length && <tr><td colSpan={7}>No replies read yet.</td></tr>}
        </tbody></table></div>
      )}
    </div>
  );
}
