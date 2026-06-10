export default function Login({ searchParams }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 120, gap: 18 }}>
      <div style={{ fontFamily: "Syne, sans-serif", fontWeight: 800, fontSize: 26, letterSpacing: 3, color: "#e2e8f0" }}>
        OPS OUTREACH
      </div>
      <p className="dim">Track data-correction outreach. Send as yourself. Never lose a follow-up.</p>
      {searchParams?.error && <p style={{ color: "#f87171", fontSize: 12 }}>Sign-in failed: {searchParams.error}</p>}
      <a href="/api/auth/slack" className="btn btn-blue" style={{ textDecoration: "none", padding: "12px 28px", fontSize: 14 }}>
        Sign in with Slack →
      </a>
    </div>
  );
}
