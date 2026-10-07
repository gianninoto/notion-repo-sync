/**
 * Drift 3 — the state-commit replay, run against real git in a temp folder:
 * a remote that moved underneath the run still gets this run's state on its
 * tip; a state already current commits nothing; a push that keeps failing
 * stops after three attempts and fails the job.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const script = new URL('../scripts/commit-state.sh', import.meta.url).pathname;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nrs-commit-'));
  const remote = path.join(dir, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const clone = name => {
    const c = path.join(dir, name);
    execFileSync('git', ['clone', '-q', remote, c]);
    git(c, 'config', 'user.name', 't');
    git(c, 'config', 'user.email', 't@example.invalid');
    return c;
  };
  const seed = clone('seed');
  fs.mkdirSync(path.join(seed, 'docs'));
  fs.writeFileSync(path.join(seed, 'docs/state.json'), '{"v":0}\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'seed');
  git(seed, 'push', '-q', 'origin', 'main');
  return { dir, remote, clone, seed };
}
const run = (cwd, env = {}) =>
  spawnSync('bash', [script, 'docs/state.json', 'main'], {
    cwd, encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: cwd, ...env },
  });

test('the run\'s state lands on a tip that moved underneath it', () => {
  const w = world();
  const runner = w.clone('runner');
  fs.writeFileSync(path.join(w.seed, 'other.md'), 'someone else\n');
  git(w.seed, 'add', '.');
  git(w.seed, 'commit', '-qm', 'pushed underneath');
  git(w.seed, 'push', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(runner, 'docs/state.json'), '{"v":1}\n');
  const r = run(runner);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /committed on attempt 1/);
  assert.equal(git(w.seed, 'fetch', '-q') || git(w.seed, 'show', 'origin/main:docs/state.json'), '{"v":1}');
  assert.equal(git(w.seed, 'show', 'origin/main:other.md'), 'someone else');
});

test('an unchanged state commits nothing', () => {
  const w = world();
  const runner = w.clone('runner');
  const before = git(runner, 'rev-parse', 'origin/main');
  const r = run(runner);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /nothing to commit/);
  assert.equal(git(w.seed, 'ls-remote', 'origin', 'main').split('\t')[0], before);
});

test('a push that keeps failing stops after three attempts and fails', () => {
  const w = world();
  const runner = w.clone('runner');
  fs.writeFileSync(path.join(w.remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(runner, 'docs/state.json'), '{"v":2}\n');
  const r = run(runner);
  assert.equal(r.status, 1);
  assert.equal((r.stdout.match(/retrying/g) ?? []).length, 3);
  assert.match(r.stderr, /after 3 attempts/);
});
