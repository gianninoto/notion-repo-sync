/**
 * The diff gate's decisions, made without git or a filesystem: readOld and
 * readNew are injected. And the state-path rule that keeps a test tree's run
 * from ever overwriting a production state file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPages, statePathFor } from '../lib/state.mjs';

const page = over => ({
  key: 'log',
  strategy: 'append',
  sourceKeys: ['docs/log.md'],
  fileKey: 'docs/log.md',
  extract: t => t.split('## ').at(-1),
  ...over,
});

test('unchanged sources skip, whatever the strategy', () => {
  const [p] = planPages([page({ strategy: 'replace' })], { 'docs/log.md': 'a' }, { 'docs/log.md': 'a' }, {});
  assert.equal(p.action, 'skip');
});

test('no recorded state at all means full: replace, or marker for marker pages', () => {
  const [r, m] = planPages(
    [page({ strategy: 'replace' }), page({ key: 'hq', strategy: 'marker' })],
    null,
    { 'docs/log.md': 'a' },
    {},
  );
  assert.equal(r.action, 'replace');
  assert.equal(m.action, 'marker');
});

test('append iff the old section is a strict prefix of the new one', () => {
  const io = {
    readOld: () => '## one\nbody\n## two\nold',
    readNew: () => '## one\nbody\n## two\nold and more',
  };
  const [p] = planPages([page()], { 'docs/log.md': 'a' }, { 'docs/log.md': 'b' }, io);
  assert.equal(p.action, 'append');
  assert.equal(p.appendMd, ' and more');
});

test('an edit inside the old section is not additive: replace', () => {
  const io = {
    readOld: () => '## two\nold text',
    readNew: () => '## two\nnew text',
  };
  const [p] = planPages([page()], { 'docs/log.md': 'a' }, { 'docs/log.md': 'b' }, io);
  assert.equal(p.action, 'replace');
});

test('file moved but the extracted section did not: skip', () => {
  const io = { readOld: () => '## two\nsame', readNew: () => 'preamble changed\n## two\nsame' };
  const [p] = planPages([page()], { 'docs/log.md': 'a' }, { 'docs/log.md': 'b' }, io);
  assert.equal(p.action, 'skip');
});

test('old blob never committed (readOld null) falls back to replace', () => {
  const io = { readOld: () => null, readNew: () => 'x' };
  const [p] = planPages([page()], { 'docs/log.md': 'a' }, { 'docs/log.md': 'b' }, io);
  assert.equal(p.action, 'replace');
});

test('state path is derived from the id file unless configured and not overridden', () => {
  assert.equal(statePathFor('/p/docs/.notion-ids.json', null), '/p/docs/.notion-ids.state.json');
  assert.equal(statePathFor('/p/docs/.notion-ids.json', '/p/docs/.sync.json'), '/p/docs/.sync.json');
  // The bug this exists for: an --ids override must never reuse the configured
  // production state path.
  assert.equal(
    statePathFor('/p/docs/.notion-ids.test.json', '/p/docs/.sync.json', { idsOverridden: true }),
    '/p/docs/.notion-ids.test.state.json',
  );
  assert.equal(statePathFor('/p/x.json', p => p + '.s'), '/p/x.json.s');
});
