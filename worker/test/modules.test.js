import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRecipients } from '../lib/recipients.js';
import { diffIssues, peopleFromIssues } from '../lib/sync.js';
import { buildRawEmail, encodeHeader } from '../../lib/nudgeSend.mjs';
import { buildEmail, buildSlackPing, itemLine, FIRST_SUBJECT } from '../lib/templates.js';
import { CATEGORY } from '../lib/planner.js';

// ---------- recipients ----------
const base = { owner_dms_user_id: 'lead', owner_state: 'active' };

test('recipients: the DMS lead only; deleted lead with no override needs an owner', () => {
  assert.deepEqual(resolveRecipients(base, []), { ownerIds: ['lead'], needsOwner: false });
  assert.deepEqual(resolveRecipients({ ...base, owner_state: 'deleted' }, []), { ownerIds: [], needsOwner: true });
  assert.equal(resolveRecipients({ owner_dms_user_id: null, owner_state: 'missing' }, []).needsOwner, true);
});

test('recipients: a co-owner is added, a reassignment replaces the lead', () => {
  const co = { role: 'co_owner', dms_user_id: 'helper', lead_at_creation: 'lead', active: true };
  assert.deepEqual(resolveRecipients(base, [co]).ownerIds.sort(), ['helper', 'lead']);
  const re = { role: 'reassigned_to', dms_user_id: 'newbie', lead_at_creation: 'lead', active: true };
  assert.deepEqual(resolveRecipients(base, [re]).ownerIds, ['newbie']);
});

test('recipients: if the DMS lead changed, old overrides are ignored (DMS wins)', () => {
  const stale = { role: 'reassigned_to', dms_user_id: 'newbie', lead_at_creation: 'previous-lead', active: true };
  assert.deepEqual(resolveRecipients(base, [stale]).ownerIds, ['lead']);
});

test('recipients: inactive lead can still be served by a co-owner', () => {
  const co = { role: 'co_owner', dms_user_id: 'helper', lead_at_creation: 'lead', active: true };
  const r = resolveRecipients({ ...base, owner_state: 'deleted' }, [co]);
  assert.deepEqual(r, { ownerIds: ['helper'], needsOwner: false });
});

// ---------- sync ----------
const mk = (category, campaign_id, extra = {}) => ({ category, campaign_id, campaign_name: campaign_id, ...extra });
const existing = (category, campaign_id, id) => ({ id, category, campaign_id });

test('sync diff: new issues are inserted, known ones updated, vanished ones cleared', () => {
  const d = diffIssues(
    [existing('pending_closings', 'a', 1), existing('pending_closings', 'b', 2)],
    [mk('pending_closings', 'a'), mk('pending_closings', 'c')],
  );
  assert.deepEqual(d.toInsert.map((x) => x.campaign_id), ['c']);
  assert.deepEqual(d.toUpdate.map((x) => x.id), [1]);
  assert.deepEqual(d.toClear.map((x) => x.id), [2]);
  assert.deepEqual(d.suspectCategories, []);
});

test('sync diff: same campaign in two categories is two separate issues', () => {
  const d = diffIssues([existing('creator_submissions', 'a', 1)], [mk('creator_submissions', 'a'), mk('screenshot_approvals', 'a')]);
  assert.equal(d.toInsert.length, 1);
  assert.equal(d.toInsert[0].category, 'screenshot_approvals');
});

test('sync diff: a sudden mass disappearance is treated as a bad read and NOT cleared', () => {
  const open = Array.from({ length: 20 }, (_, i) => existing('pending_closings', `c${i}`, i));
  const d = diffIssues(open, [mk('pending_closings', 'c0'), mk('pending_closings', 'c1')]);
  assert.equal(d.toClear.length, 0);
  assert.deepEqual(d.suspectCategories, [{ category: 'pending_closings', wasOpen: 20, wouldClear: 18 }]);
});

test('sync diff: a normal number of clears goes through, small categories are not guarded', () => {
  const open = Array.from({ length: 20 }, (_, i) => existing('pending_closings', `c${i}`, i));
  const fetched = open.slice(0, 15).map((o) => mk(o.category, o.campaign_id));
  assert.equal(diffIssues(open, fetched).toClear.length, 5);
  const few = [existing('invoice_approvals', 'x', 1), existing('invoice_approvals', 'y', 2)];
  assert.equal(diffIssues(few, []).toClear.length, 2);
});

test('people are collected once per owner', () => {
  const p = peopleFromIssues([
    { owner_dms_user_id: 'u1', owner_name: 'A', owner_email: 'a@x', owner_state: 'active' },
    { owner_dms_user_id: 'u1', owner_name: 'A', owner_email: 'a@x', owner_state: 'active' },
    { owner_dms_user_id: 'u2', owner_name: 'B', owner_email: 'b@x', owner_state: 'deleted' },
    { owner_dms_user_id: null, owner_state: 'missing' },
  ]);
  assert.deepEqual(p.map((x) => [x.dms_user_id, x.is_deleted]), [['u1', false], ['u2', true]]);
});

// ---------- mime ----------
const decodeRaw = (raw) => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

test('mime: headers, threading headers, and a base64 body that survives non-ASCII text', () => {
  const raw = buildRawEmail({
    from: 'a@x.in', to: 'b@x.in', cc: ['m@x.in'], subject: 'Re: [Action Required] Pending items on DMS',
    body: 'Hi — “quoted” ₹5,000', inReplyTo: '<abc@mail>', references: '<abc@mail>',
  });
  const msg = decodeRaw(raw);
  assert.match(msg, /From: a@x.in\r\nTo: b@x.in\r\nCc: m@x.in\r\nSubject: Re: \[Action Required\] Pending items on DMS/);
  assert.match(msg, /In-Reply-To: <abc@mail>\r\nReferences: <abc@mail>/);
  const b64body = msg.split('\r\n\r\n')[1].replace(/\r\n/g, '');
  assert.equal(Buffer.from(b64body, 'base64').toString('utf8'), 'Hi — “quoted” ₹5,000');
});

test('mime: non-ASCII subjects are RFC 2047 encoded, ASCII ones are left alone', () => {
  assert.equal(encodeHeader('plain'), 'plain');
  assert.match(encodeHeader('₹ due'), /^=\?UTF-8\?B\?.+\?=$/);
});

// ---------- templates ----------
test('email: one numbered line per campaign, bullets under it, guidance once, sign-off', () => {
  const items = [
    { issueId: 'i3', category: CATEGORY.SCREENSHOT, campaign_name: 'Xiaomi Plan 3', item_count: 1, detail: {}, nextN: 1 },
    { issueId: 'i2', category: CATEGORY.CLOSING, campaign_name: 'Zeta', item_count: 1, detail: { overdue_days: 12 }, nextN: 1 },
    { issueId: 'i1', category: CATEGORY.INVOICE, campaign_name: 'Alpha', item_count: 2, detail: {}, nextN: 1 },
    { issueId: 'i4', category: CATEGORY.CREATOR, campaign_name: 'Xiaomi Plan 3', item_count: 1, detail: {}, nextN: 1 },
  ];
  const { body, itemNumbers } = buildEmail(items, { name: 'Priya Sharma', senderName: 'Suraj Sridhar', kind: 'first', hasInvoice: true, monthEnd: false });
  assert.match(body, /^Hi Priya,/);
  assert.match(body, /1\. Alpha\n   - 2 vendor invoices awaiting your approval/);
  assert.match(body, /2\. Xiaomi Plan 3\n   - 1 submitted creator link awaiting your approval\n   - 1 screenshot awaiting your approval/);
  assert.match(body, /3\. Zeta\n   - posting ended 12 days ago and the campaign is still open/);
  assert.equal((body.match(/Xiaomi Plan 3/g) || []).length, 1, 'a campaign is listed once');
  assert.equal((body.match(/please open DMS and approve or reject each item/g) || []).length, 1, 'guidance appears once');
  assert.match(body, /Invoices: please review the proof of work/);
  assert.match(body, /Closings: if the campaign is still live/);
  assert.ok(!/Proposals:/.test(body), 'no guidance for categories that are not present');
  assert.match(body, /tell me the item number and the date/);
  assert.match(body, /Thanks,\nSuraj Sridhar$/);
  assert.deepEqual(itemNumbers, { i1: 1, i3: 2, i4: 2, i2: 3 });
});

test('email: follow-up, final and month-end wording; "done" claims are called out', () => {
  const inv = [{ issueId: 'i1', category: CATEGORY.INVOICE, campaign_name: 'Alpha', item_count: 1, detail: {}, nextN: 2, claimedDone: true }];
  const f = buildEmail(inv, { name: 'X', senderName: 'S', kind: 'followup', hasInvoice: true, monthEnd: true, finalNoticeDay: false }).body;
  assert.match(f, /Following up on my earlier email/);
  assert.match(f, /auto-rejected/);
  assert.match(f, /You mentioned this was done, but DMS still shows it as pending/);
  const last = buildEmail(inv, { name: 'X', senderName: 'S', kind: 'followup', final: true, hasInvoice: true, monthEnd: true, finalNoticeDay: true }).body;
  assert.match(last, /final reminder/);
  assert.match(last, /please approve or reject the pending invoices today/);
});

test('slack ping is short and points to the email', () => {
  const t = buildSlackPing({ name: 'Priya Sharma', count: 3, emailDate: '20 Sep' });
  assert.match(t, /^Hi Priya, following up on my email of 20 Sep: 3 items on DMS are still pending/);
  assert.ok(t.length < 260);
});

test('every category has a line and the subject is stable so follow-ups thread', () => {
  for (const c of Object.values(CATEGORY)) assert.ok(itemLine({ category: c, item_count: 1, detail: {} }).length > 10);
  assert.equal(FIRST_SUBJECT, '[Action Required] Pending items on DMS');
});
