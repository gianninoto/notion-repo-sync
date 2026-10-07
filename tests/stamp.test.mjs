/**
 * Drift 1 — the last-updated stamp and the render key (Manifest 2026-10-05).
 * Every page opens with when the repo text it mirrors last changed — the
 * newest commit among its source files, never the moment the sync ran. The
 * render key is a virtual source whose value changes only when what every
 * page looks like changes, so bumping it rewrites each page once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatStamp, stampLine, isStamp, RENDER_KEY, RENDER_VERSION } from '../lib/stamp.mjs';
import { normalize, currentHashes, assemblePages } from '../lib/config.mjs';
import { planPages } from '../lib/state.mjs';
import * as extract from '../lib/extract.mjs';

const PT = { timeZone: 'America/Los_Angeles', label: 'PT' };

test('the stamp reads like Manifest\'s, in the configured time zone', () => {
  assert.equal(formatStamp('2026-10-07T22:04:00Z', PT), 'Wed 7 Oct 2026, 3:04 PM PT');
  assert.equal(formatStamp('2026-10-07T22:04:00Z', { timeZone: 'UTC', label: 'UTC' }), 'Wed 7 Oct 2026, 10:04 PM UTC');
});

test('the stamp line names the newest commit among the sources, and is recognised', () => {
  const line = stampLine(['2026-10-01T10:00:00Z', null, '2026-10-05T10:00:00Z'], { prefix: 'Last updated', ...PT });
  assert.equal(line, '🕒 *Last updated Mon 5 Oct 2026, 3:00 AM PT*');
  assert.ok(isStamp('🕒 Last updated Mon 5 Oct 2026, 3:00 AM PT', 'Last updated'));
  assert.ok(!isStamp('Last week we shipped', 'Last updated'));
  assert.equal(stampLine([null], { prefix: 'Last updated', ...PT }), '');
});

test('the render version is Manifest\'s, so its recorded hashes still match', () => {
  assert.equal(RENDER_KEY, 'notion-render');
  assert.equal(RENDER_VERSION, 'v2 · the last-updated stamp, 2026-10-05');
});

const raw = {
  pages: [
    { key: 'state', title: 'State', strategy: 'replace', sources: ['docs/STATE.md'] },
    { key: 'todo', title: 'Todo', strategy: 'replace', sources: [{ key: 'docs/runbook.md#todo', text: () => 'todo' }], md: 'todo' },
  ],
  stamp: PT,
};
const ctx = {
  read: () => '# State\n',
  lastCommit: file => ({ 'docs/STATE.md': '2026-10-05T10:00:00Z', 'docs/runbook.md': '2026-10-06T10:00:00Z' })[file] ?? null,
  ...extract,
};

test('every page reads the render key and opens with its stamp (virtual sources stamp from their file)', () => {
  const config = normalize(raw, '/tmp/x');
  assert.equal(currentHashes(config, ctx)[RENDER_KEY], extract.blobHash(RENDER_VERSION));
  const [state, todo] = assemblePages(config, ctx);
  assert.ok(state.sourceKeys.includes(RENDER_KEY));
  assert.equal(state.stamp, '🕒 *Last updated Mon 5 Oct 2026, 3:00 AM PT*');
  assert.ok(state.md.startsWith(`${state.stamp}\n\n# State`));
  assert.equal(todo.stamp, '🕒 *Last updated Tue 6 Oct 2026, 3:00 AM PT*');
});

test('without stamp in the config, pages are exactly as before — no key, no stamp', () => {
  const { stamp, ...unstamped } = raw;
  const config = normalize(unstamped, '/tmp/x');
  assert.ok(!(RENDER_KEY in currentHashes(config, ctx)));
  const [state] = assemblePages(config, ctx);
  assert.ok(!state.sourceKeys.includes(RENDER_KEY));
  assert.equal(state.md, '# State\n');
});

test('a moved render key rewrites an append page instead of appending to it', () => {
  const page = {
    key: 'log', strategy: 'append', sourceKeys: ['docs/log.md', RENDER_KEY], fileKey: 'docs/log.md',
    extract: t => t,
  };
  const [p] = planPages([page], { 'docs/log.md': 'a', [RENDER_KEY]: 'old' }, { 'docs/log.md': 'b', [RENDER_KEY]: 'new' }, {
    readOld: () => 'one', readNew: () => 'one two',
  });
  assert.equal(p.action, 'replace');
});
