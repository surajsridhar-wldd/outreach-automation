"use client";
import { useEffect, useState, useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";

export default function Nav() {
  const [me, setMe] = useState(null);
  const [counts, setCounts] = useState({});
  const pathname = usePathname();
  const router = useRouter();

  const refresh = useCallback(() => {
    if (pathname === "/login") return;
    fetch("/api/me").then(r => r.ok ? r.json() : null).then(setMe).catch(() => {});
    fetch("/api/outreach").then(r => r.json()).then(d => {
      const c = {};
      (d.records || []).forEach(r => c[r.status] = (c[r.status] || 0) + 1);
      setCounts(c);
    }).catch(() => {});
  }, [pathname]);

  useEffect(() => { refresh(); }, [refresh]);

  if (pathname === "/login") return null;

  const noReply = (counts["no_reply"] || 0) + (counts["stalled"] || 0);
  const reviewCount = counts["needs_review"] || 0;

  const links = [
    { href: "/tracker",   label: "Outreach",   badge: counts["pending"] > 0 ? { n: counts["pending"], cls: "" } : null },
    { href: "/inflight",  label: "In Flight",  badge: noReply > 0 ? { n: noReply, cls: "" } : null },
    { href: "/review",    label: "Review",     badge: reviewCount > 0 ? { n: reviewCount, cls: "purple" } : null },
    { href: "/resolved",  label: "Resolved",   badge: null },
    { href: "/stats",     label: "Frequency",  badge: null },
    { href: "/settings",  label: "Settings",   badge: null },
  ];
  if (me?.role === "admin") links.push({ href: "/admin", label: "Admin ★", badge: null });

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  return (
    <nav className="nav">
      <span className="nav-logo">Ops <span>Outreach</span></span>
      {links.map(({ href, label, badge }) => (
        <Link key={href} href={href} className={`navlink ${pathname === href ? "active" : ""}`}>
          {label}
          {badge && <span className={`nav-badge ${badge.cls || ""}`}>{badge.n}</span>}
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
