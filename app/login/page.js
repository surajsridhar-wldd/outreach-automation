export default function Login({ searchParams }) {
  const errors = {
    no_code: "No authorization code received from Slack.",
    oauth_failed: "Slack authorization failed. Please try again.",
    db_42501: "Database permission error. Please contact your admin.",
    db_insert_failed: "Could not create your account. Please try again.",
  };
  const errMsg = searchParams?.error ? (errors[searchParams.error] || `Error: ${searchParams.error}`) : null;

  return (
    <div style={{ minHeight: "100vh", background: "#f8f9fb", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: 380, textAlign: "center" }}>
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 2, color: "#6b7280", marginBottom: 8, textTransform: "uppercase" }}>
            Ops Outreach
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-.5px", color: "#111827", marginBottom: 8 }}>
            Welcome back
          </h1>
          <p style={{ fontSize: 14, color: "#6b7280" }}>
            Track data-correction outreach. Send as yourself. Never lose a follow-up.
          </p>
        </div>

        {errMsg && (
          <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: "#dc2626" }}>
            {errMsg}
          </div>
        )}

        <a href="/api/auth/slack"
          style={{
            display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
            background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10,
            padding: "12px 24px", fontSize: 14, fontWeight: 600, color: "#111827",
            boxShadow: "0 1px 3px rgba(0,0,0,.08)", textDecoration: "none",
          }}>
          <svg width="18" height="18" viewBox="0 0 54 54" fill="none">
            <path d="M13.5 34.5C13.5 36.98 11.48 39 9 39C6.52 39 4.5 36.98 4.5 34.5C4.5 32.02 6.52 30 9 30H13.5V34.5Z" fill="#E01E5A"/>
            <path d="M16 34.5C16 32.02 18.02 30 20.5 30C22.98 30 25 32.02 25 34.5V45C25 47.48 22.98 49.5 20.5 49.5C18.02 49.5 16 47.48 16 45V34.5Z" fill="#E01E5A"/>
            <path d="M20.5 13.5C18.02 13.5 16 11.48 16 9C16 6.52 18.02 4.5 20.5 4.5C22.98 4.5 25 6.52 25 9V13.5H20.5Z" fill="#36C5F0"/>
            <path d="M20.5 16C22.98 16 25 18.02 25 20.5C25 22.98 22.98 25 20.5 25H9C6.52 25 4.5 22.98 4.5 20.5C4.5 18.02 6.52 16 9 16H20.5Z" fill="#36C5F0"/>
            <path d="M41.5 20.5C41.5 18.02 43.52 16 46 16C48.48 16 50.5 18.02 50.5 20.5C50.5 22.98 48.48 25 46 25H41.5V20.5Z" fill="#2EB67D"/>
            <path d="M39 20.5C39 22.98 36.98 25 34.5 25C32.02 25 30 22.98 30 20.5V9C30 6.52 32.02 4.5 34.5 4.5C36.98 4.5 39 6.52 39 9V20.5Z" fill="#2EB67D"/>
            <path d="M34.5 41.5C36.98 41.5 39 43.52 39 46C39 48.48 36.98 50.5 34.5 50.5C32.02 50.5 30 48.48 30 46V41.5H34.5Z" fill="#ECB22E"/>
            <path d="M34.5 39C32.02 39 30 36.98 30 34.5C30 32.02 32.02 30 34.5 30H46C48.48 30 50.5 32.02 50.5 34.5C50.5 36.98 48.48 39 46 39H34.5Z" fill="#ECB22E"/>
          </svg>
          Continue with Slack
        </a>

        <p style={{ marginTop: 20, fontSize: 12, color: "#9ca3af" }}>
          Messages will be sent from your Slack account
        </p>
      </div>
    </div>
  );
}
