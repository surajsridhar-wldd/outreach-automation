// Sends ONE short Slack DM to the owner (never anyone else) to prove the stored Slack connection works.
import * as S from './lib/store.js';
import { makeAppSender } from './lib/appSender.js';

const db = S.makeDb(process.env);
const settings = await S.loadSettings(db);
const sender = makeAppSender({ baseUrl: settings.app_base_url, key: process.env.SUPABASE_SERVICE_ROLE_KEY });
try {
  const r = await sender.slack({ person: { email: settings.sender_user_email }, text: 'Connector check: the nudge system can reach Slack. Nothing to do.', idempotencyKey: `slackcheck-${Date.now()}` });
  console.log(r.ok ? 'SLACK CHECK PASS' : `SLACK CHECK FAIL ${r.error}`, JSON.stringify({ ok: r.ok, channel: !!r.channel }));
  process.exit(r.ok ? 0 : 1);
} catch (e) { console.log('SLACK CHECK FAIL', e.message); process.exit(1); }
