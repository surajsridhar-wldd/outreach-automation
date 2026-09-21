"use client";
import { useEffect, useState } from "react";

// Admin is just people and roles now. Everything about the issues, the automation's activity and the numbers lives in the
// Tracker (Run log, Excluded, Pause) and Frequency, so nothing is shown in two places.
export default function Admin() {
  const [users, setUsers] = useState([]);
  const [toast, setToast] = useState(null);
  async function load() { const u = await fetch("/api/admin/users").then((r) => r.json()); setUsers(u.users || []); }
  useEffect(() => { load(); }, []);
  const show = (m) => { setToast(m); setTimeout(() => setToast(null), 4000); };
  async function setRole(userId, role) {
    const r = await fetch("/api/admin/users", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId, role }) }).then((r) => r.json());
    if (r.error) return show("⚠ " + r.error);
    show("✅ Role updated"); load();
  }
  return (
    <div>
      <div className="page-header"><h1>Admin ★</h1><p>Who can use the tool. Admins see the Tracker and Frequency; members only have the old tracker.</p></div>
      <div><p className="scroll-hint">← swipe the table sideways →</p>
        <div className="tbl-wrap"><table>
          <thead><tr><th>MEMBER</th><th>EMAIL</th><th>ROLE</th><th>JOINED</th><th>CHANGE ROLE</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td><div className="row-main" style={{ cursor: "default" }}>{u.avatar_url && <img src={u.avatar_url} style={{ width: 26, height: 26, borderRadius: "50%" }} alt="" />}<span className="poc-name">{u.name}</span></div></td>
                <td><div className="row-main" style={{ cursor: "default", fontSize: 12, color: "#6b7280" }}>{u.email}</div></td>
                <td><div className="row-main" style={{ cursor: "default" }}>{u.role === "admin" ? <span style={{ background: "#f5f3ff", color: "#7c3aed", border: "1px solid #ddd6fe", borderRadius: 99, padding: "2px 10px", fontSize: 11, fontWeight: 600 }}>★ Admin</span> : <span style={{ fontSize: 12, color: "#6b7280" }}>Member</span>}</div></td>
                <td><div className="row-main" style={{ cursor: "default", fontSize: 12, color: "#9ca3af" }}>{new Date(u.created_at).toLocaleDateString()}</div></td>
                <td><div className="row-main" style={{ cursor: "default" }}>{u.role === "admin" ? <button className="btn btn-sm" onClick={() => setRole(u.id, "member")}>Make Member</button> : <button className="btn btn-sm btn-purple" onClick={() => setRole(u.id, "admin")}>Make Admin ★</button>}</div></td>
              </tr>
            ))}
          </tbody>
        </table></div></div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
