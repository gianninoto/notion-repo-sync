import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  blobHash, splitAt, sectionNamed, firstSections, newestWithChildren, partition, entriesWith,
} from '../lib/extract.mjs';

test('blobHash is byte-identical to git hash-object', () => {
  const text = 'hello\n— with unicode · and a tab\t\n';
  const expected = execFileSync('git', ['hash-object', '--stdin'], { input: text, encoding: 'utf8' }).trim();
  assert.equal(blobHash(text), expected);
});

test('splitAt keeps the preamble as section 0 and each heading with its body', () => {
  const s = splitAt('intro\n## A\na1\n### A.1\n## B\nb1', 2);
  assert.deepEqual(s.map(x => x.heading), ['', '## A', '## B']);
  assert.equal(s[1].text, '## A\na1\n### A.1');
});

test('sectionNamed matches by heading prefix; firstSections takes the newest n', () => {
  const md = '## Right now — 0.1\nx\n## Blocked on Justin\ny\n## 0.3\n3\n';
  assert.equal(sectionNamed(md, 2, 'Blocked').trim(), '## Blocked on Justin\ny');
  assert.equal(sectionNamed(md, 2, 'nope'), '');
  assert.equal(firstSections('## 3\nc\n## 2\nb\n## 1\na', 2, 2), '## 3\nc\n## 2\nb');
});

test('newestWithChildren skips a trailing stub with no child sections', () => {
  const md = '## Phase 1\n### s1\n## Phase 2\n### s2\n## Phases 3–4 — not started\nstub';
  assert.equal(newestWithChildren(md), '## Phase 2\n### s2');
});

test('partition: DONE headings go to archived, the preamble and the rest stay active', () => {
  const md = ['pre', '# Half', '## A · DONE', 'a', '## B', 'b', '### B.1 DONE', 'b1'].join('\n');
  const { active, archived } = partition(md, h => h.includes('DONE'));
  assert.equal(active, 'pre\n# Half\n## B\nb');
  assert.equal(archived, '## A · DONE\na\n### B.1 DONE\nb1');
});

test('entriesWith finds the leaf-most section carrying the marker, in file order', () => {
  const md = [
    '## Out of sequence',
    'intro',
    '### Fix the thing',
    '> **Prompt:**',
    '> do it',
    '## Session 3',
    '> **Prompt:**',
    '> session three',
    '### Session 3 notes',
    'none here',
  ].join('\n');
  const entries = entriesWith(md, '> **Prompt:**');
  assert.deepEqual(entries.map(e => e.heading), ['### Fix the thing', '## Session 3']);
  assert.ok(!entries[1].text.includes('Session 3 notes'), 'an h2 entry is its own body, not its children');
});

test('partition: the preamble stays active even when the predicate would accept an empty heading', () => {
  // A predicate like "everything not marked TODO is archived" returns true
  // for ''. The preamble has no heading and must never be archived on that
  // technicality — it is the framing both halves are read through.
  const { active, archived } = partition('pre\n## A\na\n## B TODO\nb', h => !h.includes('TODO'));
  assert.equal(active, 'pre\n## B TODO\nb');
  assert.equal(archived, '## A\na');
});
