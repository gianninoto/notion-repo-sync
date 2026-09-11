/**
 * computeDoomed's one job: never return a child_page or child_database block.
 * Those blocks ARE the pages/databases they name — archiving one trashes the
 * real object, not a reference to it. Found 2026-08-18 by inspecting Product
 * HQ's real block list before ever running a replace against it: its nested
 * pages (Runbook, PLAN, Log, Changelog, Decisions, both databases) sit after
 * the generated text as exactly these block types, and the pre-fix version of
 * this function would have included every one of them in the deletable set.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDoomed } from '../lib/api.mjs';

const p = (id, type = 'paragraph') => ({ id, type });

test('marker replace stops before the first structural child, mirroring Product HQ', () => {
  const children = [
    p('header-1'), p('header-2'),
    p('marker', 'callout'),
    p('now-1'), p('now-2'), p('blocked-1'),
    { id: 'runbook', type: 'child_page' },
    { id: 'plan', type: 'child_page' },
    { id: 'roadmap-db', type: 'child_database' },
  ];
  const { doomed, markerFound } = computeDoomed(children, 'marker');
  assert.equal(markerFound, true);
  assert.deepEqual(doomed.map(b => b.id), ['now-1', 'now-2', 'blocked-1']);
  assert.ok(!doomed.some(b => b.type.startsWith('child_')), 'no structural child in the doomed list');
});

test('a structural child interleaved mid-content still halts deletion at it', () => {
  const children = [
    p('marker', 'callout'),
    p('a'),
    { id: 'sub-page', type: 'child_page' },
    p('b'),
  ];
  const { doomed } = computeDoomed(children, 'marker');
  assert.deepEqual(doomed.map(b => b.id), ['a']);
});

test('no marker (ordinary replace page) still exempts structural children', () => {
  const children = [p('a'), p('b'), { id: 'sub', type: 'child_page' }, p('c')];
  const { doomed, markerFound } = computeDoomed(children, undefined);
  assert.equal(markerFound, true);
  assert.deepEqual(doomed.map(b => b.id), ['a', 'b']);
});

test('marker not found reports markerFound: false and touches nothing', () => {
  const children = [p('a'), p('b')];
  const { doomed, markerFound } = computeDoomed(children, 'missing-marker');
  assert.equal(markerFound, false);
  assert.equal(doomed, null);
});

test('all structural children, nothing after the marker to delete', () => {
  const children = [p('marker', 'callout'), { id: 'sub', type: 'child_page' }];
  const { doomed } = computeDoomed(children, 'marker');
  assert.deepEqual(doomed, []);
});
