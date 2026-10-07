/**
 * Drift 5 — a row provider's read is calibrated before it is trusted
 * (Manifest's history reads): a known canary row proves the read reached real
 * data, and every expected group must be non-empty. A read that cannot prove
 * itself throws; it never returns an empty, plausible answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibrate } from '../lib/calibrate.mjs';
import { normalize } from '../lib/config.mjs';

const rows = [{ id: 1, trip: 'sandbox' }, { id: 2, trip: 'portugal' }];
const spec = {
  canary: r => r.trip === 'sandbox',
  expect: { portugal: r => r.trip === 'portugal' },
};

test('a read that holds its canary and every expected group passes through unchanged', () => {
  assert.deepEqual(calibrate(rows, spec, 'feedback'), rows);
});
test('a read without its canary throws and trusts nothing', () => {
  assert.throws(() => calibrate(rows.slice(1), spec, 'feedback'), /calibration failed.*nothing was trusted/);
});
test('an empty read throws — empty is not an answer', () => {
  assert.throws(() => calibrate([], spec, 'feedback'), /calibration failed/);
});
test('a missing expected group throws by name', () => {
  assert.throws(() => calibrate([rows[0]], spec, 'feedback'), /expected rows for "portugal"/);
});
test('the config refuses a calibrate block without a canary', () => {
  const pages = [{ key: 'p', title: 'P', strategy: 'replace', sources: ['a.md'] }];
  assert.throws(
    () => normalize({ pages, databases: [{ key: 'f', title: 'F', mode: 'upsert', rows: () => [], calibrate: {} }] }, '/tmp'),
    /calibrate needs canary/,
  );
});
