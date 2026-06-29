"use client";
import { useEffect, useState } from "react";

const LABEL = {
  pending:"Pending",sent:"Sent",active:"Active",
  needs_review:"Review",followup:"Follow-up",snoozed:"Snoozed",
  resolved:"Resolved",no_reply:"No Reply",stalled:"Stalled",escalated:"Escalated",
};

export default function Admin() {
  const [tab, setTab] = useState("cases");
  const [cases, setCases] = useState([]);
  const [users, setUsers] = useState([]);
  const [toast, setToast] = useState(null);
  const [filter, setFilter] = useState("");

  async function load() {
    const [c, u] = await Promise.all([
      fetch("/api/admin/cases").then(r => r.json()),
      fetch("/api/admin/users").then(r => r.json()),
    ]);
    if (!c.error) setCases(c.records || []);
    setUsers(u.users || []);
  }
  useEffect(() => { load(); }, []);
  function show(m) { setToast(m); setTimeout(() => setToast(null), 4000); }

  async function setRole(userId, role) {
    const r = await fetch("/api/admin/users", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId, role }) }).then(r => r.json());
    if (r.error) return show("⚠ " + r.error);
    show("✅ Role updated"); load();
  }

  const filtered = cases.filter(c =>
    !filter ||
    (c.contacts?.name||"").toLowerCase().includes(filter.toLowerCase()) ||
    (c.contacts?.campaign||"").toLowerCase().includes(filter.toLowerCase()) ||
    (c.users?.name||"").toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div>
      <div className="page-header">
        <h1>Admin ★</h1>
        <p>View all cases across the team and manage user roles.</p>
      </div>

      <div className="tabs">
        <button className={`tab-btn ${tab === "cases" ? "active" : ""}`} onClick={() => setTab("cases")}>
          All Cases <span className="tab-count">{cases.length}</span>
        </button>
        <button className={`tab-btn ${tab === "team" ? "active" : ""}`} onClick={() => setTab("team")}>
          Team <span className="tab-count">{users.length}</span>
        </button>
      </div>

      {tab === "cases" && (
        <>
          <input placeholder="Filter by POC, campaign, or team member…" value={filter} onChange={e => setFilter(e.target.value)} style={{ marginBottom: 14, maxWidth: 400 }} />
          <div className="tbl-wrap">
            <table>
              <thead><tr><th>OPS MEMBER</th><th>POC</th><th>CAMPAIGN</th><th>ISSUE</th><th>STATUS</th><th>FU</th><th>UPDATED</th></tr></thead>
              <tbody>
                {filtered.map(r => (
                  <tr key={r.id}>
                    <td style={{ fontSize: 12, fontWeight: 500 }}>{r.users?.name || "—"}</td>
                    <td><div className="poc-name">{r.contacts?.name}</div><div className="poc-email">{r.contacts?.email}</div></td>
                    <td>{r.contacts?.campaign && <span className="campaign-pill">{r.contacts.campaign}</span>}</td>
                    <td><div className="issue-text">{r.contacts?.issue}</div></td>
                    <td style={{ fontSize: 12 }}>{LABEL[r.status] || r.status}</td>
                    <td style={{ fontSize: 12, color: "#6b7280" }}>{r.followups}</td>
                    <td style={{ fontSize: 11, color: "#9ca3af" }}>{r.last_action_at ? new Date(r.last_action_at).toLocaleDateString() : "—"}</td>
                  </tr>
                ))}
                {filtered.length === 0 && <tr><td colSpan={7} style={{ padding: 32, textAlign: "center", color: "#9ca3af" }}>No cases found.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === "team" && (
        <div className="tbl-wrap">
          <table>
            <thead><tr><th>MEMBER</th><th>EMAIL</th><th>ROLE</th><th>JOINED</th><th>CHANGE ROLE</th></tr></thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {u.avatar_url && <img src={u.avatar_url} style={{ width: 26, height: 26, borderRadius: "50%" }} alt="" />}
                      <span className="poc-name">{u.name}</span>
                    </div>
                  </td>
                  <td style={{ fontSize: 12, color: "#6b7280" }}>{u.email}</td>
                  <td>{u.role === "admin"
                    ? <span style={{ background: "#f5f3ff", color: "#7c3aed", border: "1px solid #ddd6fe", borderRadius: 99, padding: "2px 10px", fontSize: 11, fontWeight: 600 }}>★ Admin</span>
                    : <span style={{ fontSize: 12, color: "#6b7280" }}>Member</span>}
                  </td>
                  <td style={{ fontSize: 12, color: "#9ca3af" }}>{new Date(u.created_at).toLocaleDateString()}</td>
                  <td>
                    {u.role === "admin"
                      ? <button className="btn btn-sm" onClick={() => setRole(u.id, "member")}>Make Member</button>
                      : <button className="btn btn-sm btn-purple" onClick={() => setRole(u.id, "admin")}>Make Admin ★</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
