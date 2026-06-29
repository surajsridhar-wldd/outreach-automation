// Claude Haiku helpers for the outreach system. Cheap, fast, JSON-only.

const MODEL = "claude-haiku-4-5-20251001";

async function callHaiku({ system, user, maxTokens = 500 }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  return text;
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return fallback;
  }
}

// ── Reply attribution with relevance gate ─────────────────────────────────────
// The core fix: the FIRST question is "is this message about ANY of the person's
// open issues?" Chit-chat ("free for chai?") returns relevant:false and is discarded.
// Only relevant messages get attributed to a specific issue.
//
// Input:
//   messages: [{ id, text }]   raw POC messages (already author-filtered)
//   openIssues: [{ recordId, campaign, issue }]
// Output:
//   { attributions: [ { messageId, recordId|null, relevant, type, confidence, summary } ] }
//   - relevant:false        -> ignore entirely (not a reply to anything)
//   - relevant:true, recordId set    -> attributed to that issue
//   - relevant:true, recordId null   -> about some issue but can't tell which -> Review
export async function attributeReplies({ messages, openIssues }) {
  if (!messages.length || !openIssues.length) return { attributions: [] };

  const issueList = openIssues
    .map((o, i) => `  [${i}] recordId=${o.recordId} | campaign="${o.campaign || "n/a"}" | issue: ${o.issue}`)
    .join("\n");

  const msgList = messages
    .map(m => `  {"id":"${m.id}","text":${JSON.stringify(m.text || "")}}`)
    .join("\n");

  const system =
    "You attribute a colleague's chat/DM messages to specific open data-correction requests, or mark them as unrelated. " +
    "You are given a list of OPEN ISSUES (each with a recordId, campaign, and description) and a list of MESSAGES the person sent. " +
    "For EACH message decide: is it about ANY of the open issues? Many messages will be small talk, logistics, or unrelated chatter — those get relevant:false. " +
    "People often signal which issue by echoing a word from the campaign name (e.g. 'the Upgrad one is sorted' -> the issue whose campaign contains 'Upgrad'). " +
    "If a message is clearly about an issue but you cannot confidently tell WHICH one (multiple plausible), set relevant:true and recordId:null. " +
    'Respond with ONLY valid JSON: {"attributions":[{"messageId":"...","recordId":"..."|null,"relevant":true|false,"type":"resolved|acknowledged|question|unrelated","confidence":0.0-1.0,"summary":"short"}]}. ' +
    "type: resolved=they say it's fixed/done; acknowledged=they confirm they'll act/are working on it; question=they ask about the issue; unrelated=not about any issue (pair with relevant:false). " +
    "Use the exact recordId strings from the issue list. Do not invent recordIds.";

  const user =
    `OPEN ISSUES:\n${issueList}\n\nMESSAGES:\n${msgList}\n\n` +
    `Attribute every message. Return JSON only.`;

  const text = await callHaiku({ system, user, maxTokens: 800 });
  const parsed = parseJson(text, { attributions: [] });
  if (!parsed || !Array.isArray(parsed.attributions)) return { attributions: [] };

  // Validate recordIds against the provided set; coerce unknowns to null (-> review).
  const validIds = new Set(openIssues.map(o => String(o.recordId)));
  parsed.attributions = parsed.attributions.map(a => ({
    messageId: a.messageId,
    recordId: a.recordId && validIds.has(String(a.recordId)) ? String(a.recordId) : null,
    relevant: !!a.relevant,
    type: ["resolved", "acknowledged", "question", "unrelated"].includes(a.type) ? a.type : "unrelated",
    confidence: typeof a.confidence === "number" ? a.confidence : 0,
    summary: a.summary || "",
  }));
  return parsed;
}

// ── Issue sameness judge (LLM fallback for paraphrase) ────────────────────────
// Used by import dedup / reconciliation when token-similarity is ambiguous.
// Returns { same: bool, confidence: 0..1 }.
export async function judgeIssueSameness({ a, b, campaign }) {
  const system =
    "You decide whether two short issue descriptions refer to the SAME underlying problem for the same campaign, " +
    "even if worded differently. " +
    'Respond with ONLY valid JSON: {"same":true|false,"confidence":0.0-1.0}.';
  const user = `Campaign: ${campaign || "n/a"}\nIssue A: ${a}\nIssue B: ${b}\n\nSame underlying problem?`;
  const text = await callHaiku({ system, user, maxTokens: 100 });
  const parsed = parseJson(text, { same: false, confidence: 0 });
  return { same: !!parsed.same, confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0 };
}

// ── Category auto-tagging (single — kept for any one-off use) ──────────────────
// Given an issue + the user's category list, pick the best category tag (or null).
// categories: [{ tag, name, description }]
// Returns { tag: string|null, confidence: 0..1 }.
export async function categorizeIssue({ campaign, issue, categories }) {
  if (!categories || !categories.length) return { tag: null, confidence: 0 };
  const list = categories.map(c => `  ${c.tag}: ${c.description || c.name}`).join("\n");
  const tags = categories.map(c => c.tag);
  const system =
    "You classify a data-correction issue into exactly one of the predefined categories below, or return null if none fit confidently. " +
    `Categories:\n${list}\n\n` +
    'Respond with ONLY valid JSON: {"tag":"<one of the tags>"|null,"confidence":0.0-1.0}.';
  const user = `Campaign: ${campaign || "n/a"}\nIssue: ${issue}\n\nWhich category?`;
  const text = await callHaiku({ system, user, maxTokens: 100 });
  const parsed = parseJson(text, { tag: null, confidence: 0 });
  const tag = parsed.tag && tags.includes(parsed.tag) ? parsed.tag : null;
  return { tag, confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0 };
}

// ── BATCHED category auto-tagging ─────────────────────────────────────────────
// Categorize MANY issues in a single Claude call to keep cost flat regardless of
// import size. Chunks internally so each call stays small/reliable.
// items: [{ id, campaign, issue }]
// categories: [{ tag, name, description }]
// Returns: { [id]: { tag: string|null, confidence: 0..1 } }
export async function categorizeIssuesBatch({ items, categories, chunkSize = 25 }) {
  const out = {};
  if (!items?.length || !categories?.length) {
    for (const it of items || []) out[it.id] = { tag: null, confidence: 0 };
    return out;
  }
  const list = categories.map(c => `  ${c.tag}: ${c.description || c.name}`).join("\n");
  const validTags = new Set(categories.map(c => c.tag));

  const system =
    "You classify data-correction issues into exactly one of the predefined categories, or null if none fit confidently. " +
    `Categories:\n${list}\n\n` +
    "You will receive a JSON array of items, each with an id, campaign, and issue. " +
    'Respond with ONLY valid JSON: an array [{"id":"...","tag":"<one tag>"|null,"confidence":0.0-1.0}], one element per input id, same ids.';

  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const user = `Items:\n${JSON.stringify(chunk.map(it => ({ id: it.id, campaign: it.campaign || "n/a", issue: it.issue })))}\n\nClassify each.`;
    const text = await callHaiku({ system, user, maxTokens: 1500 });
    const parsed = parseJson(text, []);
    const arr = Array.isArray(parsed) ? parsed : [];
    const byId = Object.fromEntries(arr.map(a => [String(a.id), a]));
    for (const it of chunk) {
      const a = byId[String(it.id)];
      const tag = a && a.tag && validTags.has(a.tag) ? a.tag : null;
      out[it.id] = { tag, confidence: a && typeof a.confidence === "number" ? a.confidence : 0 };
    }
  }
  return out;
}

// ── BATCHED issue-sameness judge ──────────────────────────────────────────────
// Judge MANY ambiguous pairs in one call. pairs: [{ id, a, b, campaign }]
// Returns: { [id]: { same: bool, confidence: 0..1 } }
export async function judgeIssueSamenessBatch({ pairs, chunkSize = 25 }) {
  const out = {};
  if (!pairs?.length) return out;
  const system =
    "You decide, for each pair, whether two short issue descriptions refer to the SAME underlying problem for the same campaign, even if worded differently. " +
    "You receive a JSON array of pairs (id, campaign, a, b). " +
    'Respond with ONLY valid JSON: an array [{"id":"...","same":true|false,"confidence":0.0-1.0}], one per input id.';
  for (let i = 0; i < pairs.length; i += chunkSize) {
    const chunk = pairs.slice(i, i + chunkSize);
    const user = `Pairs:\n${JSON.stringify(chunk.map(p => ({ id: p.id, campaign: p.campaign || "n/a", a: p.a, b: p.b })))}\n\nJudge each.`;
    const text = await callHaiku({ system, user, maxTokens: 1200 });
    const parsed = parseJson(text, []);
    const arr = Array.isArray(parsed) ? parsed : [];
    const byId = Object.fromEntries(arr.map(a => [String(a.id), a]));
    for (const p of chunk) {
      const a = byId[String(p.id)];
      out[p.id] = { same: a ? !!a.same : false, confidence: a && typeof a.confidence === "number" ? a.confidence : 0 };
    }
  }
  return out;
}

// ── Legacy single-issue classifier (kept for backward compat during migration) ─
// Still used by any caller not yet migrated to attributeReplies.
export async function classifyReply({ campaign, issue, messages }) {
  const system =
    "You classify whether messages from a colleague are a response to a specific data-correction request. " +
    'Respond with ONLY valid JSON: {"classification":"resolved|acknowledged|question|unrelated","confidence":0.0-1.0,"summary":"one short sentence"}. ' +
    "resolved = they say the issue is fixed/done. acknowledged = they confirm they will act or are working on it. " +
    "question = they ask something about the issue. unrelated = the messages are about a different topic entirely.";
  const user = `The outreach was about campaign "${campaign || "n/a"}" with this issue:\n${issue}\n\nThe person sent these message(s) since the outreach:\n${messages.map(m => `- ${m}`).join("\n")}\n\nClassify.`;
  const text = await callHaiku({ system, user, maxTokens: 300 });
  const parsed = parseJson(text, { classification: "unrelated", confidence: 0, summary: "Could not parse" });
  if (!["resolved", "acknowledged", "question", "unrelated"].includes(parsed.classification)) {
    return { classification: "unrelated", confidence: 0, summary: "Could not parse classification" };
  }
  return parsed;
}
