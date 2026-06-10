// Reply classification via Claude Haiku (cheap, fast).
export async function classifyReply({ campaign, issue, messages }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system:
        "You classify whether messages from a colleague are a response to a specific data-correction request. " +
        'Respond with ONLY valid JSON: {"classification":"resolved|acknowledged|question|unrelated","confidence":0.0-1.0,"summary":"one short sentence"}. ' +
        "resolved = they say the issue is fixed/done. acknowledged = they confirm they will act or are working on it. " +
        "question = they ask something about the issue. unrelated = the messages are about a different topic entirely.",
      messages: [
        {
          role: "user",
          content: `The outreach was about campaign "${campaign || "n/a"}" with this issue:\n${issue}\n\nThe person sent these message(s) since the outreach:\n${messages
            .map((m) => `- ${m}`)
            .join("\n")}\n\nClassify.`,
        },
      ],
    }),
  });
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    if (!["resolved", "acknowledged", "question", "unrelated"].includes(parsed.classification)) throw new Error("bad class");
    return parsed;
  } catch {
    return { classification: "unrelated", confidence: 0.0, summary: "Could not parse classification" };
  }
}
