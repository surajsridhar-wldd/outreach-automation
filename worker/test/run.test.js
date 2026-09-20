import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveMode } from '../run.js';

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
