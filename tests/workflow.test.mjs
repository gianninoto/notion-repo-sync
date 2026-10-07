/**
 * Drifts 2 and 3, and the action: CI runs through one composite action, a
 * scheduled run is `full` on Friday 14:00 UTC, and the state file is replayed
 * onto the branch tip with three retries — never rebased (Manifest
 * 2026-09-16: `git pull --rebase` conflicted on the state file three times in
 * ninety seconds, failing runs whose pages were already correct).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('the action checks out full history, resolves the mode, runs the engine, replays the state', () => {
  const action = read('action.yml');
  assert.match(action, /using: ['"]?composite/);
  assert.match(action, /fetch-depth: 0/);
  assert.match(action, /github\.event_name == 'schedule' && 'full'/);
  assert.match(action, /cli\.mjs/);
  assert.match(action, /commit-state\.sh/);
  assert.doesNotMatch(action, /pull --rebase/);
});

test('the template uses the action, runs full on Fridays, and neither rebases nor runs the engine itself', () => {
  const tpl = read('skills/notion-sync/templates/notion-sync.yml');
  assert.match(tpl, /uses: gianninoto\/notion-repo-sync@/);
  assert.match(tpl, /cron: '0 14 \* \* 5'/);
  assert.doesNotMatch(tpl, /pull --rebase/);
  assert.doesNotMatch(tpl, /npx notion-repo-sync|cli\.mjs/);
});

test('the skill is thin: it points at the action and carries no workflow body', () => {
  const skill = read('skills/notion-sync/SKILL.md');
  assert.ok(skill.trimEnd().split('\n').length <= 150, `SKILL.md is ${skill.split('\n').length} lines`);
  assert.match(skill, /gianninoto\/notion-repo-sync@/);
  for (const internal of [/fetch-depth/, /pull --rebase/, /RUNNER_TEMP/, /\[skip ci\]/, /concurrency group/]) {
    assert.doesNotMatch(skill, internal, `the skill still explains ${internal}`);
  }
  for (const ref of ['reference/lessons.md', 'reference/limits.md']) {
    assert.ok(fs.existsSync(new URL(`../skills/notion-sync/${ref}`, import.meta.url)), `${ref} kept`);
    assert.match(skill, new RegExp(ref.replace('.', '\\.')));
  }
});
