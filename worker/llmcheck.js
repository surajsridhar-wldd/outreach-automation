// One tiny real call through the website to the model, to prove the key on the website works and has credit.
import * as S from './lib/store.js';
import { makeAppSender } from './lib/appSender.js';
import { buildPrompt } from './lib/llm.js';

const db = S.makeDb(process.env);
const settings = await S.loadSettings(db);
const sender = makeAppSender({ baseUrl: settings.app_base_url, key: process.env.SUPABASE_SERVICE_ROLE_KEY });
const prompt = buildPrompt({ todayIst: '2026-09-21', items: [{ n: 1, campaign_name: 'Test Campaign', category: 'pending_closings' }, { n: 2, campaign_name: 'Other', category: 'invoice_approvals' }], replyText: '1. done. Need till Friday for 2. Please add Ravi Kumar on 2.', fromOwner: true, senderName: 'Test' });
try {
  const r = await sender.interpret(prompt);
  console.log('LLM CHECK PASS', JSON.stringify(r));
} catch (e) {
  console.log('LLM CHECK FAIL', e.message);
  process.exit(1);
}
