import { test } from 'node:test';
import assert from 'node:assert/strict';
import { propPayload, buildProperties, reconcilePlan } from '../lib/database.mjs';

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
