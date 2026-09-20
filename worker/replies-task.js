// One-off task: read replies now (wide window, includes carried-over legacy threads) and apply their effects.
import * as S from './lib/store.js';
import { makeAppSender } from './lib/appSender.js';
import { readReplies } from './lib/replies.js';

const db = S.makeDb(process.env);
const settings = await S.loadSettings(db);
const sender = makeAppSender({ baseUrl: settings.app_base_url, key: process.env.SUPABASE_SERVICE_ROLE_KEY });
const [issues, people] = await Promise.all([S.loadOpenIssues(db), S.loadPeople(db)]);
const me = await S.loadSender(db, settings.sender_user_email);
const stats = await readReplies({
  store: S.replyStore(db, { windowDays: 120 }), senders: sender, interpret: ({ prompt }) => sender.interpret(prompt), apiKey: null,
  now: new Date(), settings, people, issuesById: new Map(issues.map((r) => [r.id, r])), senderEmail: me.gmail_address, log: console.log,
});
console.log('REPLIES', JSON.stringify(stats));
