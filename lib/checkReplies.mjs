import { db } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";
import { processReadRequest } from "@/lib/nudgeSend.mjs";
import { readReplies } from "@/worker/lib/replies.js";
import { interpretReply } from "@/worker/lib/llm.js";
import { replyStore, loadSettings, loadPeople, loadOpenIssues, loadSender } from "@/worker/lib/store.js";

// "Check replies now" for the selected issues: reads the email threads (and Slack DMs) we started with THEIR owners,
// interprets any new reply exactly like the daily run does (same rules, same spending cap) and applies the effects.
export async function checkRepliesFor(recipientIds) {
  const settings = await loadSettings(db);
  const sender = await loadSender(db, settings.sender_user_email);
  const [people, open] = await Promise.all([loadPeople(db), loadOpenIssues(db)]);
  const only = new Set(recipientIds);
  const base = replyStore(db, { windowDays: 60 });
  const store = {
    ...base,
    replyThreads: async (now) => (await base.replyThreads(now)).filter((t) => only.has(t.recipientId)),
    slackConversations: async (now) => (await base.slackConversations(now)).filter((c) => only.has(c.recipientId)),
  };
  const deps = { decrypt, google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET }, guards: { allowThread: async () => true, allowChannel: async () => true } };
  const senders = {
    readThread: (threadId) => processReadRequest({ type: "gmail_thread", threadId }, sender, deps),
    slackHistory: ({ dmChannelId, oldest }) => processReadRequest({ type: "slack_history", dmChannelId, oldest }, sender, deps),
    bounces: async () => ({ bounces: [] }),
  };
  return readReplies({
    store, senders, interpret: ({ prompt }) => interpretReply({ apiKey: process.env.ANTHROPIC_API_KEY, prompt }), apiKey: null,
    now: new Date(), settings, people, issuesById: new Map(open.map((r) => [r.id, r])), senderEmail: sender.gmail_address,
  });
}
