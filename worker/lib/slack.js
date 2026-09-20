// Minimal Slack Web API client, acting as the connected user (same token the app already stores).
async function slack(token, method, params) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(params),
  });
  return res.json();
}

export async function lookupByEmail(token, email) {
  const res = await fetch(`https://slack.com/api/users.lookupByEmail?${new URLSearchParams({ email })}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.ok ? data.user.id : null;
}

export async function openDm(token, slackUserId) {
  const r = await slack(token, 'conversations.open', { users: slackUserId });
  return r.ok ? r.channel.id : null;
}

export async function postMessage(token, channel, text) {
  const r = await slack(token, 'chat.postMessage', { channel, text });
  return { ok: !!r.ok, ts: r.ts ? String(r.ts) : null, error: r.error || null };
}
