"use client";
import { useEffect, useState } from "react";

const LABEL = {
  pending: "Pending", sent: "Sent", awaiting_reply: "Awaiting", replied: "Replied",
  needs_review: "Review", followup: "Follow-up", resolved_auto: "Resolved*",
  resolved: "Resolved", no_reply: "No Reply", stalled: "Stalled",
};

export default function Admin() {
  const [tab, setTab] = useState("cases");
  const [cases, setCases] = useState([]);
  const [users, setUsers] = useState([]);
  const [toast, setToast] = useState(null);
  const [filter, setFilter] = useState("");

  async function load() {
    const c = await fetch("/api/admin/cases").then((r) => r.json());
    if (c.error) { setToast("⚠ " + c.error); return; }
    setCases(c.records || []);
    const u = await fetch("/api/admin/users").then((r) => r.json());
    setUsers(u.users || []);
  }
  useEffect(() => { load(); }, []);
  function show(m) { setToast(m); setTimeout(() => setToast(null), 4000); }

  async function setRole(userId, role) {
    const r = await fetch("/api/admin/users", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId, role }) }).then((r) => r.json());
    if (r.error) return show("⚠ " + r.error);
    show("✅ Role updated"); load();
  }

  const filtered = cases.filter((c) =>
    !filter ||
    (c.contacts?.name || "").toLowerCase().includes(filter.toLowerCase()) ||
    (c.contacts?.campaign || "").toLowerCase().includes(filter.toLowerCase()) ||
    (c.users?.name || "").toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div>
      <h1>Admin ★</h1>
      <div className="tabbar">
        <button className={`tabbtn ${tab === "cases" ? "active" : ""}`} onClick={() => setTab("cases")}>All Cases ({cases.length})</button>
        <button className={`tabbtn ${tab === "team" ? "active" : ""}`} onClick={() => setTab("team")}>Team ({users.length})</button>
      </div>

      {tab === "cases" && (
        <>
          <input placeholder="Filter by POC, campaign, or team member…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ marginBottom: 12, maxWidth: 400 }} />
          <table>
            <thead><tr><th>OPS MEMBER</th><th>CAMPAIGN</th><th>POC</th><th>ISSUE</th><th>STATUS</th><th>FU</th><th>UPDATED</th></tr></thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td className="dim">{r.users?.name || "—"}</td>
                  <td className="dim">{r.contacts?.campaign || "—"}</td>
                  <td><div>{r.contacts?.name}</div><div className="faint">{r.contacts?.email}</div></td>
                  <td className="dim" style={{ maxWidth: 260 }}>{r.contacts?.issue}</td>
                  <td className="dim">{LABEL[r.status] || r.status}</td>
                  <td className="dim">{r.followups}</td>
                  <td className="faint">{r.last_action_at ? new Date(r.last_action_at).toLocaleDateString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {tab === "team" && (
        <table>
          <thead><tr><th>MEMBER</th><th>EMAIL</th><th>ROLE</th><th>JOINED</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td className="row" style={{ gap: 8 }}>{u.avatar_url && <img src={u.avatar_url} style={{ width: 22, height: 22, borderRadius: "50%" }} alt="" />}{u.name}</td>
                <td className="dim">{u.email}</td>
                <td>{u.role === "admin" ? <span style={{ color: "var(--purple)" }}>★ admin</span> : <span className="dim">member</span>}</td>
                <td className="faint">{new Date(u.created_at).toLocaleDateString()}</td>
                <td>
                  {u.role === "admin"
                    ? <button className="btn" onClick={() => setRole(u.id, "member")}>Make member</button>
                    : <button className="btn btn-purple" onClick={() => setRole(u.id, "admin")}>Make admin</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
