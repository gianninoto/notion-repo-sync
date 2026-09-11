import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalize, makeContext, currentHashes, assemblePages } from '../lib/config.mjs';
import { blobHash } from '../lib/extract.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nrs-'));

const project = files => {
  const root = tmp();
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
};

test('normalize rejects what the planner cannot run', () => {
  assert.throws(() => normalize({}, '/x'), /no pages/);
  assert.throws(() => normalize({ pages: [{ key: 'a', title: 'A', strategy: 'weird', sources: ['a.md'] }] }, '/x'), /strategy/);
  assert.throws(() => normalize({ pages: [{ key: 'a', title: 'A', strategy: 'append', sources: ['a.md'] }] }, '/x'), /fileKey/);
  assert.throws(
    () => normalize({ pages: [{ key: 'a', title: 'A', strategy: 'replace', sources: ['a.md'] }, { key: 'a', title: 'B', strategy: 'replace', sources: ['b.md'] }] }, '/x'),
    /duplicate key/,
  );
  assert.throws(() => normalize({ databases: [{ key: 'd', title: 'D', mode: 'reconcile' }] }, '/x'), /desired/);
});

test('the hub defaults to the marker page, and root defaults to the config directory', () => {
  const c = normalize(
    { pages: [{ key: 'plan', title: 'P', strategy: 'replace', sources: ['p.md'] }, { key: 'home', title: 'H', strategy: 'marker', sources: ['s.md'] }] },
    '/proj',
  );
  assert.equal(c.hub, 'home');
  assert.equal(c.root, '/proj');
});

test('hashes: file sources hash the file, virtual sources hash the extracted text, track is recorded', () => {
  const root = project({ 'docs/a.md': 'A\n', 'docs/b.md': '## one\nx\n## two\ny\n', 'docs/c.md': 'c' });
  const c = normalize(
    {
      track: ['docs/c.md'],
      pages: [
        { key: 'a', title: 'A', strategy: 'replace', sources: ['docs/a.md'] },
        {
          key: 'b',
          title: 'B',
          strategy: 'replace',
          sources: [{ key: 'docs/b.md#two', text: ({ read, sectionNamed }) => sectionNamed(read('docs/b.md'), 2, 'two') }],
          md: ({ read, sectionNamed }) => sectionNamed(read('docs/b.md'), 2, 'two'),
        },
      ],
    },
    root,
  );
  const h = currentHashes(c, makeContext(c));
  assert.equal(h['docs/a.md'], blobHash('A\n'));
  assert.equal(h['docs/b.md#two'], blobHash('## two\ny\n'));
  assert.equal(h['docs/c.md'], blobHash('c'));
  assert.ok(!('docs/b.md' in h), 'a virtual-only page does not hash the whole file');
});

test('assemblePages: single-source replace reads the file; append defaults to extract + pointer', () => {
  const root = project({ 'docs/plan.md': '# Plan\n', 'docs/log.md': '## p1\n### s\n## p2\n### t\n' });
  const c = normalize(
    {
      pages: [
        { key: 'plan', title: 'PLAN', strategy: 'replace', sources: ['docs/plan.md'] },
        {
          key: 'log',
          title: 'Log',
          strategy: 'append',
          sources: ['docs/log.md'],
          fileKey: 'docs/log.md',
          extract: (text, { newestWithChildren }) => newestWithChildren(text),
          pointer: 'Older: the repo.',
        },
      ],
    },
    root,
  );
  const ctx = makeContext(c);
  const [plan, log] = assemblePages(c, ctx);
  assert.equal(plan.md, '# Plan\n');
  assert.equal(log.md, '## p2\n### t\n\n\nOlder: the repo.');
  assert.equal(log.extract('## a\n### x\n## b\n### y'), '## b\n### y', 'extract is bound to the context');
  assert.deepEqual(log.sourceKeys, ['docs/log.md']);
});

test('a multi-source page without md is an error, not a guess', () => {
  const root = project({ 'a.md': 'a', 'b.md': 'b' });
  const c = normalize({ pages: [{ key: 'x', title: 'X', strategy: 'replace', sources: ['a.md', 'b.md'] }] }, root);
  assert.throws(() => assemblePages(c, makeContext(c)), /needs md/);
});
