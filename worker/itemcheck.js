// Read-only dry run of per-item tracking against live DMS and the live ledger. Writes nothing.
import { MongoClient } from 'mongodb';
import { fetchOpenIssues } from './lib/mongoCategories.js';
import { planItemSync } from './lib/items.js';
import * as S from './lib/store.js';

const db = S.makeDb(process.env);
const mongo = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
await mongo.connect();
const zeroDecisions = await S.loadZeroCostDecisions(db);
const { issues: fetched } = await fetchOpenIssues(mongo.db('test'), new Date(), { log: console.log, zeroDecisions });
await mongo.close();
const open = (await S.loadOpenIssues(db)).filter((i) => i.source !== 'manual');
const people = new Map((await S.loadPeople(db)).map((p) => [p.dms_user_id, p]));
const key = (x) => `${x.category}::${x.campaign_id}`;
const wanted = new Map(fetched.map((f) => [key(f), f.items?.length ? f.items : [{ key: 'main', at: null }]]));
let changed = 0; let items = 0; const rows = [];
for (const i of open) {
  if (!wanted.has(key(i))) continue;
  const p = planItemSync({ issue: i, wanted: wanted.get(key(i)), existing: [], nowIso: new Date().toISOString() });
  items += p.insert.length;
  if (p.issueUpdate) { changed++; rows.push(`${i.category} | ${i.campaign_name} | ${people.get(i.owner_dms_user_id)?.name} | count ${i.nudge_count} -> ${p.issueUpdate.nudge_count} | items ${p.insert.map((x) => `${x.item_key.slice(0, 8)}:${x.nudge_count}`).join(',')}`); }
}
console.log(`ITEMCHECK issues: ${open.length}; items that would be created: ${items}; issues whose nudge count would change: ${changed}`);
for (const r of rows.slice(0, 40)) console.log(`ITEMCHECK change | ${r}`);
const multi = fetched.filter((f) => (f.items || []).length > 1).length;
console.log(`ITEMCHECK issues with more than one individual item: ${multi}`);
