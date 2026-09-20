import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idFromReportsTo, nameFromReportsTo, parseTeamRows, fetchTeamRows, makeManagerResolver, overlayManagers } from '../lib/teamSheet.js';

// Invented people only.
const row = (id, name, email, reportsTo = '') => ({ id, name, email, reportsTo });
const ROWS = [
  row('WLDD/001/EMP', 'Asha Verma', 'asha.verma@wldd.in', 'Bikram Nair WLDD/002/EMP'),
  row('WLDD/002/EMP', 'Bikram Nair', 'bikramnair@wldd.in', 'Chitra Rao WLDD/003/CNT'),
  row('WLDD/003/CNT', 'Chitra Rao', 'chitra@wldd.in', ''),
  row('WLDD/004/EMP', 'Dev Shah', 'devshah@wldd.in', 'Asha Verma WLDD/999/EMP'),        // id not in sheet, name is
  row('WLDD/005/EMP', 'Esha Rao', 'eshar@wldd.in', 'Nobody Known WLDD/998/EMP'),         // unresolvable
  row('WLDD/006/EMP', 'Farid Khan', 'farid@wldd.in', 'Farid Khan WLDD/006/EMP'),         // reports to self
  row('WLDD/007/EMP', 'Gita Iyer', 'gita@wldd.in', 'Outsider Vendor WLDD/008/EMP'),
  row('WLDD/008/EMP', 'Outsider Vendor', 'vendor@scoopwhoop.com', ''),
  row('WLDD/009/EMP', 'Hari Om', 'hari1@wldd.in', 'Bikram Nair WLDD/002/EMP'),
  row('WLDD/010/EMP', 'Hari Om', 'hari2@wldd.in', 'Bikram Nair WLDD/002/EMP'),          // same name twice
];
const resolve = makeManagerResolver(ROWS);

test('the employee id at the end of "Reporting To" is extracted; the printed name is separable', () => {
  assert.equal(idFromReportsTo('Ishita Singh WLDD/427/EMP'), 'WLDD/427/EMP');
  assert.equal(idFromReportsTo('Jayant Singh WLDD/480/CNT'), 'WLDD/480/CNT');
  assert.equal(idFromReportsTo('Srividhya C WLDD/620/EMP '), 'WLDD/620/EMP');
  assert.equal(idFromReportsTo('No id here'), null);
  assert.equal(nameFromReportsTo('Ishita Singh WLDD/427/EMP'), 'Ishita Singh');
});

test('person matched by email, manager matched by employee id, manager email taken from the sheet', () => {
  assert.deepEqual(resolve({ email: 'ASHA.VERMA@wldd.in', name: 'whatever' }), { status: 'ok', matchedBy: 'email', manager_email: 'bikramnair@wldd.in', manager_name: 'Bikram Nair' });
  assert.equal(resolve({ email: 'bikramnair@wldd.in' }).manager_email, 'chitra@wldd.in');
});

test('falls back to a UNIQUE name when the email is not in the sheet, never to an ambiguous one', () => {
  assert.equal(resolve({ email: 'other@wldd.in', name: 'Asha  Verma' }).matchedBy, 'name');
  assert.equal(resolve({ email: 'other@wldd.in', name: 'Hari Om' }).status, 'person_not_in_sheet');
});

test('when the printed id is not in the sheet, the printed name is used only if unique', () => {
  assert.equal(resolve({ email: 'devshah@wldd.in' }).manager_email, 'asha.verma@wldd.in');
  assert.equal(resolve({ email: 'eshar@wldd.in' }).status, 'manager_not_found');
});

test('the odd cases: nobody above, self, non-company manager email, unknown person', () => {
  assert.equal(resolve({ email: 'chitra@wldd.in' }).status, 'no_reporting_to');
  assert.equal(resolve({ email: 'farid@wldd.in' }).status, 'self');
  assert.equal(resolve({ email: 'gita@wldd.in' }).status, 'manager_email_not_company');
  assert.equal(resolve({ email: 'ghost@wldd.in', name: 'Ghost Person' }).status, 'person_not_in_sheet');
});

test('overlay: the sheet wins over the DMS-derived manager; DMS is kept when the sheet cannot answer', () => {
  const people = [
    { dms_user_id: 'a', email: 'asha.verma@wldd.in', name: 'Asha Verma', manager_email: 'stale-cohort-lead@wldd.in', manager_source: 'cohort' },
    { dms_user_id: 'b', email: 'bikramnair@wldd.in', name: 'Bikram Nair', manager_email: 'chitra@wldd.in', manager_source: 'pod' },
    { dms_user_id: 'c', email: 'eshar@wldd.in', name: 'Esha Rao', manager_email: 'dms-lead@wldd.in', manager_source: 'cohort' },
    { dms_user_id: 'd', email: 'nobody@wldd.in', name: 'Nobody', manager_email: null },
  ];
  const { people: out, stats } = overlayManagers(people, resolve);
  assert.equal(out[0].manager_email, 'bikramnair@wldd.in');
  assert.equal(out[0].manager_source, 'sheet');
  assert.equal(out[1].manager_source, 'sheet');
  assert.equal(out[2].manager_email, 'dms-lead@wldd.in', 'sheet could not resolve, DMS answer kept');
  assert.equal(out[2].manager_source, 'cohort');
  assert.equal(out[3].manager_email, null);
  assert.deepEqual([stats.fromSheet, stats.agreeWithDms, stats.differFromDms, stats.keptDms, stats.none], [2, 1, 1, 1, 1]);
});

test('endpoint errors and truncated answers are failures, never data', async () => {
  const mk = (body, ok = true, status = 200) => async () => ({ ok, status, json: async () => body });
  await assert.rejects(fetchTeamRows({ url: 'u', fetchImpl: mk({ error: 'unauthorized' }) }), /unauthorized/);
  await assert.rejects(fetchTeamRows({ url: 'u', fetchImpl: mk({ rows: [{ id: 'WLDD/1/EMP', name: 'A', email: 'a@wldd.in' }] }) }), /incomplete/);
  await assert.rejects(fetchTeamRows({ url: 'u', fetchImpl: async () => ({ ok: false, status: 500, json: async () => { throw new Error('x'); } }) }), /not JSON/);
  const big = { rows: Array.from({ length: 60 }, (_, i) => ({ id: `WLDD/${i}/EMP`, name: `P${i}`, email: `p${i}@wldd.in`, reportsTo: '' })) };
  assert.equal((await fetchTeamRows({ url: 'u', fetchImpl: mk(big) })).length, 60);
});

test('rows without an id are dropped and fields are normalised', () => {
  const rows = parseTeamRows({ rows: [{ id: ' wldd/1/emp ', name: ' A B ', email: ' A@WLDD.IN ', reportsTo: ' X ' }, { id: '', name: 'blank' }] });
  assert.deepEqual(rows, [{ id: 'WLDD/1/EMP', name: 'A B', email: 'a@wldd.in', reportsTo: 'X' }]);
});
