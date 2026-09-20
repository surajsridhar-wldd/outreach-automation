import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveMode, resolveNow } from '../run.js';

test('a dispatch can always pick a safer mode', () => {
  assert.equal(effectiveMode('shadow', 'live'), 'shadow');
  assert.equal(effectiveMode('rehearsal', 'live'), 'rehearsal');
  assert.equal(effectiveMode('shadow', 'shadow'), 'shadow');
});

test('a dispatch can never make a run more dangerous than the database setting', () => {
  assert.throws(() => effectiveMode('live', 'shadow'), /refused/);
  assert.throws(() => effectiveMode('canary', 'shadow'), /refused/);
  assert.throws(() => effectiveMode('live', 'canary'), /refused/);
  assert.equal(effectiveMode('live', 'live'), 'live');
  assert.equal(effectiveMode('canary', 'canary'), 'canary');
});

test('no request means the configured mode; junk is rejected', () => {
  assert.equal(effectiveMode(null, 'rehearsal'), 'rehearsal');
  assert.throws(() => effectiveMode('yolo', 'shadow'), /Unknown RUN_MODE/);
});

test('AS_OF plans as another moment in shadow/rehearsal, and is refused when anything can really be sent', () => {
  const real = new Date('2026-09-20T06:00:00Z');
  assert.equal(resolveNow(null, 'shadow', real), real);
  assert.equal(resolveNow('2026-09-21T05:30:00Z', 'shadow', real).toISOString(), '2026-09-21T05:30:00.000Z');
  assert.equal(resolveNow('2026-09-21T05:30:00Z', 'rehearsal', real).toISOString(), '2026-09-21T05:30:00.000Z');
  assert.throws(() => resolveNow('2026-09-21T05:30:00Z', 'live', real), /not allowed/);
  assert.throws(() => resolveNow('2026-09-21T05:30:00Z', 'canary', real), /not allowed/);
  assert.throws(() => resolveNow('garbage', 'shadow', real), /valid date-time/);
});
