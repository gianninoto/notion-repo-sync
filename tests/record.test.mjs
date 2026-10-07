/**
 * Drift 4 — a forced run off the working branch writes pages but records no
 * state (Manifest 2026-09-16: a hand-run from another branch recorded hashes
 * for content the branch did not hold, and CI then skipped a damaged page).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRecordState } from '../lib/state.mjs';

test('on the configured branch, state is recorded', () => {
  assert.equal(shouldRecordState({ branch: 'dev', configBranch: 'dev', forced: false }), true);
});
test('forced off the configured branch, state is not recorded', () => {
  assert.equal(shouldRecordState({ branch: 'feature', configBranch: 'dev', forced: true }), false);
  assert.equal(shouldRecordState({ branch: null, configBranch: 'dev', forced: true }), false);
});
test('forced on the configured branch, or no branch configured, state is recorded', () => {
  assert.equal(shouldRecordState({ branch: 'dev', configBranch: 'dev', forced: true }), true);
  assert.equal(shouldRecordState({ branch: 'feature', configBranch: null, forced: true }), true);
});
