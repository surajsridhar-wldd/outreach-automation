import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cutoffs, creatorSubmissionPipeline, screenshotApprovalPipeline, invoiceApprovalPipeline,
  closingFilter, proposalFilter, fetchOpenIssues, SCREENSHOT_INDEX_HINT,
} from '../lib/mongoCategories.js';
import { CATEGORY } from '../lib/planner.js';

const now = new Date('2026-09-19T06:00:00Z');

test('cutoffs reproduce the boundaries verified against the owner CSVs on 2026-09-19', () => {
  const c = cutoffs(now);
  assert.equal(c.closingEnd.toISOString(), '2026-09-12T23:59:59.999Z');     // posting ended >= 7 days ago
  assert.equal(c.proposalCreated.toISOString(), '2026-09-04T23:59:59.999Z'); // in Proposal > 14 days (>= 15)
});

test('creator submissions require a real submitted_at date (drops 8 legacy rows)', () => {
  const match = creatorSubmissionPipeline()[0].$match;
  assert.equal(match.approved, 0);
  assert.deepEqual(match.submitted_at, { $type: 'date' });
  assert.equal(match.url.$regex, '\\S');
});

test('screenshot approvals need an explicit 0; invoices are -2 starting from the small invoice set', () => {
  assert.deepEqual(screenshotApprovalPipeline()[0], { $match: { latest_screenshot_status: 0 } });
  assert.deepEqual(invoiceApprovalPipeline()[0], { $match: { invoice_status: -2 } });
});

test('closings exclude On Hold; proposals are Proposal status only', () => {
  assert.deepEqual(closingFilter(now).campaign_status, { $in: ['Active', 'Approved'] });
  assert.equal(proposalFilter(now).campaign_status, 'Proposal');
});

// A tiny in-memory stand-in for the Mongo driver.
function fakeDb({ hintFails = false } = {}) {
  const data = {
    invoices: [{ _id: 'c-inv', item_count: 2 }],
    creator: [{ _id: 'c-cre', item_count: 3 }, { _id: 'c-gone', item_count: 1 }],
    shots: [{ _id: 'c-inv', item_count: 4 }],
  };
  const campaigns = {
    'c-inv': { campaign_id: 'c-inv', name: 'Invoice Camp', campaign_status: 'Complete', campaign_lead: 'u-active' },
    'c-cre': { campaign_id: 'c-cre', name: 'Creator Camp', campaign_status: 'Active', campaign_lead: 'u-deleted' },
    'c-close': { campaign_id: 'c-close', name: 'Closing Camp', campaign_status: 'Active', campaign_lead: 'u-missing', posting_end_date: new Date('2026-09-01T18:30:00Z') },
    'c-prop': { campaign_id: 'c-prop', name: 'Proposal Camp', campaign_status: 'Proposal', campaign_lead: null, createdAt: new Date('2026-08-20T10:00:00Z') },
  };
  const users = [{ id: 'u-active', is_deleted: false, name: 'A', email: 'a@x' }, { id: 'u-deleted', is_deleted: true, name: 'D', email: 'd@x' }];
  const toArray = (rows) => ({ toArray: async () => rows });
  const calls = { hinted: 0, unhinted: 0 };
  return {
    calls,
    collection: (name) => ({
      aggregate: (pipeline, options) => {
        if (name === 'invoices') return toArray(data.invoices);
        if (options?.hint) { calls.hinted++; if (hintFails) throw new Error('bad hint'); return toArray(data.shots); }
        if (pipeline[0].$match.latest_screenshot_status === 0) { calls.unhinted++; return toArray(data.shots); }
        return toArray(data.creator);
      },
      find: (filter) => {
        if (name === 'users') return toArray(users.filter((u) => filter.id.$in.includes(u.id)));
        if (filter.posting_end_date) return toArray([campaigns['c-close']]);
        if (filter.createdAt) return toArray([campaigns['c-prop']]);
        return toArray(filter.campaign_id.$in.map((id) => campaigns[id]).filter(Boolean));
      },
    }),
  };
}

test('fetchOpenIssues resolves owners, drops orphans, and computes ages', async () => {
  const { issues, orphans } = await fetchOpenIssues(fakeDb(), now);
  const by = (cat, id) => issues.find((i) => i.category === cat && i.campaign_id === id);

  assert.equal(by(CATEGORY.INVOICE, 'c-inv').item_count, 2);
  assert.equal(by(CATEGORY.INVOICE, 'c-inv').owner_state, 'active');
  assert.equal(by(CATEGORY.SCREENSHOT, 'c-inv').item_count, 4);
  assert.equal(by(CATEGORY.CREATOR, 'c-cre').owner_state, 'deleted');
  assert.equal(by(CATEGORY.CLOSING, 'c-close').owner_state, 'missing');       // lead has no user record
  assert.equal(by(CATEGORY.CLOSING, 'c-close').detail.overdue_days, 18);      // Sep 1 -> Sep 19
  assert.equal(by(CATEGORY.PROPOSAL, 'c-prop').owner_state, 'missing');       // no lead at all
  assert.equal(by(CATEGORY.PROPOSAL, 'c-prop').detail.pending_days, 30);
  assert.deepEqual(orphans, [{ category: CATEGORY.CREATOR, campaign_id: 'c-gone', item_count: 1 }]);
  assert.ok(!issues.some((i) => i.campaign_id === 'c-gone'));
});

test('screenshot query uses the index hint and falls back to a plain scan if the hint fails', async () => {
  const ok = fakeDb();
  await fetchOpenIssues(ok, now);
  assert.equal(ok.calls.hinted, 1);

  const bad = fakeDb({ hintFails: true });
  const logs = [];
  const { issues } = await fetchOpenIssues(bad, now, { log: (m) => logs.push(m) });
  assert.equal(bad.calls.unhinted, 1);
  assert.ok(logs[0].includes(SCREENSHOT_INDEX_HINT));
  assert.ok(issues.some((i) => i.category === CATEGORY.SCREENSHOT));
});
