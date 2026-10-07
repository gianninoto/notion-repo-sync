/**
 * Drift 2 — the Friday `full` run and the digest. The digest itself is a
 * project's policy (Manifest's "Waiting on you · as of"), written in its
 * config; the engine gives it today's date and an age helper, and a scheduled
 * run is always `full`, so a dated page moves even in a week no hash moved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext, normalize } from '../lib/config.mjs';

const config = normalize({ pages: [{ key: 'p', title: 'P', strategy: 'replace', sources: ['a.md'] }] }, '/tmp');

test('the context carries today, overridable for a test', () => {
  assert.match(makeContext(config).today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(makeContext(config, { today: '2026-10-09' }).today, '2026-10-09');
});
test('ageOf says how old a dated document is, in words', () => {
  const { ageOf } = makeContext(config, { today: '2026-10-09' });
  assert.equal(ageOf('2026-10-09'), 'today');
  assert.equal(ageOf('2026-10-08'), 'yesterday');
  assert.equal(ageOf('2026-10-02'), '7 days ago');
  assert.equal(ageOf(null), 'undated');
});
