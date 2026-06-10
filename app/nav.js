"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";

export default function Nav() {
  const [me, setMe] = useState(null);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (pathname === "/login") return;
    fetch("/api/me").then(r => r.ok ? r.json() : null).then(setMe).catch(() => {});
  }, [pathname]);

  if (pathname === "/login") return null;

  const links = [
    ["/tracker", "Tracker"],
    ["/followups", "Follow-ups"],
    ["/review", "Review"],
    ["/stats", "Frequency"],
    ["/settings", "Settings"],
  ];
  if (me?.role === "admin") links.push(["/admin", "Admin ★"]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  return (
    <nav className="nav">
      <span className="nav-logo">Ops <span>Outreach</span></span>
      {links.map(([href, label]) => (
        <Link key={href} href={href} className={`navlink ${pathname === href ? "active" : ""}`}>{label}</Link>
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
