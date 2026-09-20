// Read-only: runs the zero-cost-service logic against live DMS and prints what it finds. Writes nothing anywhere.
import { MongoClient } from 'mongodb';
import { fetchOpenIssues } from './lib/mongoCategories.js';

const mongo = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
await mongo.connect();
const { issues, manualVerify } = await fetchOpenIssues(mongo.db('test'), new Date(), { log: console.log });
const zero = issues.filter((i) => i.category === 'zero_cost_services');
console.log(`ZEROCHECK action cases: ${zero.length}; manual-check cases: ${manualVerify.length}`);
const by = {};
for (const z of zero) { by[z.detail.service] = (by[z.detail.service] || 0) + 1; }
console.log('ZEROCHECK by service:', JSON.stringify(by));
console.log('ZEROCHECK owners:', JSON.stringify(zero.reduce((a, z) => ({ ...a, [z.owner_state]: (a[z.owner_state] || 0) + 1 }), {})));
console.log('ZEROCHECK status:', JSON.stringify(zero.reduce((a, z) => ({ ...a, [z.campaign_status]: (a[z.campaign_status] || 0) + 1 }), {})));
for (const z of zero) console.log(`ZC | ${z.campaign_name} | ${z.detail.service} | ${z.owner_email || z.owner_state} | ${(z.detail.internal_note || '').slice(0, 60)}`);
for (const m of manualVerify) console.log(`MANUAL | ${m.campaign_name} | ${m.service} | ${m.note.slice(0, 60)}`);
console.log('other categories (unchanged):', JSON.stringify(issues.reduce((a, i) => ({ ...a, [i.category]: (a[i.category] || 0) + 1 }), {})));
await mongo.close();
