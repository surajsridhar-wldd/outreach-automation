"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";

export default function Nav() {
  const [me, setMe] = useState(null);
  const pathname = usePathname();
  const router = useRouter();
  const [counts, setCounts] = useState({});

  useEffect(() => {
    if (pathname === "/login") return;
    fetch("/api/me").then(r => r.ok ? r.json() : null).then(setMe).catch(() => {});
    // Load counts for badges
    fetch("/api/outreach").then(r => r.json()).then(d => {
      const c = {};
      (d.records || []).forEach(r => c[r.status] = (c[r.status] || 0) + 1);
      setCounts(c);
    }).catch(() => {});
  }, [pathname]);

  if (pathname === "/login") return null;

  const followupCount = counts["no_reply"] || 0;
  const reviewCount = (counts["needs_review"] || 0) + (counts["resolved_auto"] || 0) + (counts["replied"] || 0);

  const links = [
    { href: "/tracker",  label: "Tracker" },
    { href: "/stats",    label: "Frequency" },
    { href: "/settings", label: "Settings" },
  ];
  if (me?.role === "admin") links.push({ href: "/admin", label: "Admin ★" });

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  return (
    <nav className="nav">
      <span className="nav-logo">Ops <span>Outreach</span></span>
      {links.map(({ href, label }) => (
        <Link key={href} href={href} className={`navlink ${pathname === href ? "active" : ""}`}>
          {label}
          {href === "/tracker" && followupCount > 0 && (
            <span style={{ background: "#ef4444", color: "#fff", borderRadius: 99, fontSize: 10, fontWeight: 700, padding: "1px 6px", marginLeft: 4 }}>{followupCount}</span>
          )}
          {href === "/tracker" && reviewCount > 0 && (
            <span style={{ background: "#7c3aed", color: "#fff", borderRadius: 99, fontSize: 10, fontWeight: 700, padding: "1px 6px", marginLeft: 4 }}>{reviewCount}</span>
          )}
        </Link>
      ))}
      <span className="navspacer" />
      {me && (
        <div className="userchip">
          {me.avatar_url && <img src={me.avatar_url} alt="" />}
          <span className="name">{me.name}</span>
          {me.role === "admin" && <span className="admin-badge">ADMIN</span>}
          <button className="btn btn-sm" onClick={logout} style={{ marginLeft: 4 }}>Sign out</button>
        </div>
      )}
    </nav>
  );
}
