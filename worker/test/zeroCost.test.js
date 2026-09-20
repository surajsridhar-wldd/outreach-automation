import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyNote, classifyZeroCost, zeroCostPipeline, ZERO_COST_SERVICES } from '../lib/zeroCost.js';

test('notes that clearly say the internal / our / in-house team did the work are excluded (methodology examples)', () => {
  for (const n of [
    'content made by internal designer team', 'All these content were created by our team', 'created by our own AI team',
    'AI videos made by internal team', 'Content done by internal team', 'Video made by internal team', 'Ai videos made by internal team',
    'No external costs incurred for content creation [everything was done internally]',
    'We do postings for Canva’s whatsapp channel - 20 deliverables per month. Content is made by internal designer team.',
  ]) assert.equal(classifyNote(n, 'Some campaign'), 'exclude', n);
});

test('AI-only notes and Chiraiya campaigns go to a person; ordinary notes and empty notes are action cases', () => {
  assert.equal(classifyNote('7 AI video for their social page'), 'manual');
  assert.equal(classifyNote('a minimal cost and will be absorbing the Gen AI video outputs within our retainer'), 'manual');
  assert.equal(classifyNote('500 comments', 'Chiraiya X WLDD Extension 4'), 'manual');
  for (const n of ['', 'Das will be doing ORM for this', 'used Prayag tiwari for comment seeding!', 'KFC shot and edited the content, no vendor was involved',
    'Comments by DAS Vendor - This is FOC', 'This is creative fee that we charged to the client', 'Vendor - Chandu', 'subreddit creation']) {
    assert.equal(classifyNote(n, 'Some campaign'), 'action', n);
  }
});

test('only Complete/Active campaigns of real clients count; excluded and manual rows are not nudged', () => {
  const svc = Object.keys(ZERO_COST_SERVICES)[1];
  const campaigns = new Map([
    ['a', { campaign_id: 'a', name: 'A', campaign_status: 'Complete', client_id: '1' }],
    ['b', { campaign_id: 'b', name: 'B', campaign_status: 'Cancel', client_id: '1' }],
    ['c', { campaign_id: 'c', name: 'C', campaign_status: 'Active', client_id: '2' }],
    ['d', { campaign_id: 'd', name: 'D', campaign_status: 'Active', client_id: '1' }],
    ['e', { campaign_id: 'e', name: 'E', campaign_status: 'Active', client_id: '1' }],
  ]);
  const clients = new Map([['1', 'Real Client'], ['2', ' TEST client ']]);
  const r = classifyZeroCost([
    { campaign_id: 'a', service_id: svc, notes: ['', 'Das did it'] }, { campaign_id: 'b', service_id: svc, notes: [] },
    { campaign_id: 'c', service_id: svc, notes: [] }, { campaign_id: 'd', service_id: svc, notes: ['made by internal team'] },
    { campaign_id: 'e', service_id: svc, notes: ['AI videos'] }, { campaign_id: 'zz', service_id: svc, notes: [] },
  ], campaigns, clients);
  assert.deepEqual(r.issues.map((i) => [i.campaign.campaign_id, i.service, i.note]), [['a', 'ORM', 'Das did it']]);
  assert.deepEqual(r.review.map((i) => i.campaign.campaign_id), ['e']);
});

test('pipeline: plan rows win over the service summary and any plan deliverable removes the row', () => {
  const p = zeroCostPipeline();
  const match = p.find((st) => st.$match?.effDeliv === 0);
  assert.deepEqual(match.$match, { effDeliv: 0, effCost: 0 });
  const add = p.find((st) => st.$addFields?.effDeliv).$addFields;
  assert.deepEqual(add.effDeliv.$cond[0], '$hasPlan');
  assert.deepEqual(p[0].$match.service_id.$in.sort(), Object.keys(ZERO_COST_SERVICES).sort());
});
