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
    fetch("/api/me").then((r) => (r.ok ? r.json() : null)).then(setMe).catch(() => {});
  }, [pathname]);

  if (pathname === "/login") return null;

  const links = [
    ["/tracker", "Tracker"],
    ["/followups", "Follow-ups"],
    ["/review", "Review"],
    ["/stats", "Frequency"],
    ["/settings", "Settings"],
  ];
  if (me?.role === "admin") links.push(["/admin", "Admin"]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  return (
    <nav className="nav">
      <Link href="/tracker" className="logo">OPS OUTREACH</Link>
      {links.map(([href, label]) => (
        <Link key={href} href={href} className={`navlink ${pathname === href ? "active" : ""}`}>{label}</Link>
      ))}
      <span className="navspacer" />
      {me && (
        <span className="userchip">
          {me.avatar_url && <img src={me.avatar_url} alt="" />}
          {me.name} {me.role === "admin" && <span style={{ color: "#a78bfa" }}>★</span>}
          <button className="btn" onClick={logout} style={{ marginLeft: 6, padding: "4px 10px" }}>Logout</button>
        </span>
      )}
    </nav>
  );
}
