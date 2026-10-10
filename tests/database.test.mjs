import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propPayload, buildProperties, reconcilePlan, driftOf } from '../lib/database.mjs';

const schema = {
  Item: { type: 'title' },
  Stage: { type: 'status' },
  Kind: { type: 'select' },
  Notes: { type: 'rich_text' },
  Status: { type: 'select' },
  "Justin's call": { type: 'select' },
  Count: { type: 'number' },
};

test('payloads follow the live schema type, not the value shape', () => {
  assert.deepEqual(propPayload(schema, 'Stage', 'Backlog'), { status: { name: 'Backlog' } });
  assert.deepEqual(propPayload(schema, 'Kind', 'Bug'), { select: { name: 'Bug' } });
  assert.deepEqual(propPayload(schema, 'Count', '3'), { number: 3 });
  assert.equal(propPayload(schema, 'Missing', 'x'), null, 'unknown column is skipped, not invented');
  assert.equal(propPayload(schema, 'Notes', ''), null);
});

test('a forbidden property in the provider output throws — never silently dropped', () => {
  assert.throws(
    () => buildProperties(schema, { Item: 'x', "Justin's call": 'Yes' }, { forbidden: ["Justin's call"] }),
    /forbidden property "Justin's call"/,
  );
});

test('onCreateOnly writes a forbidden column exactly at birth', () => {
  const props = buildProperties(schema, { Item: 'x' }, { forbidden: ['Status'], onCreateOnly: { Status: 'New' } });
  assert.deepEqual(props.Status, { select: { name: 'New' } });
  assert.deepEqual(props.Item, { title: [{ type: 'text', text: { content: 'x' } }] });
});

test('a generic `title` maps onto whichever property is the title', () => {
  const props = buildProperties(schema, { title: 'Phase 1' }, { titleProp: 'Item' });
  assert.equal(props.Item.title[0].text.content, 'Phase 1');
});

test('reconcilePlan: create missing, trash stale managed, report foreign', () => {
  const stamps = new Set(['gen:phase-1', 'gen:phase-9', 'gen:review-3']);
  const desired = [{ key: 'gen:phase-1' }, { key: 'gen:phase-2' }];
  const { missing, stale, foreign } = reconcilePlan(stamps, desired, /^gen:phase-/);
  assert.deepEqual(missing.map(c => c.key), ['gen:phase-2']);
  assert.deepEqual(stale, ['gen:phase-9']);
  assert.deepEqual(foreign, ['gen:review-3']);
});

/* A card's generated columns follow the repo on every run, not only at
 * creation (2026-10-10: Manifest's Roadmap had 12 of 32 cards on a stale
 * Stage; claude-ops' Loops board would never mark a loop Done). */
const page = (props) => ({ id: 'p1', properties: props });
const sel = name => ({ type: 'select', select: name ? { name } : null });
const txt = (type, s) => ({ type, [type]: [{ plain_text: s, text: { content: s } }] });

test('driftOf: a generated column that changed in the repo is rewritten', () => {
  const current = page({ Item: txt('title', 'Phase 5'), Kind: sel('Backlog'), Notes: txt('rich_text', 'old') });
  const d = driftOf(schema, current, { properties: { title: 'Phase 5', Kind: 'Shipped', Notes: 'old' } }, { titleProp: 'Item' });
  assert.deepEqual(d, { Kind: { select: { name: 'Shipped' } } });
});

test('driftOf: a card already in step yields nothing to write', () => {
  const current = page({ Item: txt('title', 'Phase 5'), Kind: sel('Shipped') });
  assert.deepEqual(driftOf(schema, current, { properties: { title: 'Phase 5', Kind: 'Shipped' } }, { titleProp: 'Item' }), {});
});

test('driftOf: a renamed title is rewritten through the title property', () => {
  const current = page({ Item: txt('title', 'Phase 5 — old name') });
  const d = driftOf(schema, current, { properties: { title: 'Phase 5 — new name' } }, { titleProp: 'Item' });
  assert.deepEqual(Object.keys(d), ['Item']);
});

test("driftOf: the user's column is never in the write, whatever it holds", () => {
  const current = page({ Item: txt('title', 'x'), Kind: sel('Backlog'), "Justin's call": sel('Do next') });
  const d = driftOf(schema, current, { properties: { title: 'x', Kind: 'Shipped' } }, { titleProp: 'Item', forbidden: ["Justin's call"] });
  assert.ok(!("Justin's call" in d));
  assert.throws(() => driftOf(schema, current, { properties: { "Justin's call": 'Drop' } }, { forbidden: ["Justin's call"] }), /forbidden/);
});

test('driftOf: the stamp column and onCreateOnly values are never rewritten', () => {
  const current = page({ Item: txt('title', 'x'), Status: sel('Triaged'), Notes: txt('rich_text', 'gen:a — generated') });
  const d = driftOf(schema, current, { properties: { title: 'x' } }, { titleProp: 'Item', stampProperty: 'Notes', onCreateOnly: { Status: 'New' } });
  assert.deepEqual(d, {});
});
