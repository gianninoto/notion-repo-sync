#!/usr/bin/env node
/**
 * fixture:live — the engine against real Notion, held to the probe standard.
 *
 *   npm run fixture:live -- --parent <scratch page url or id>
 *
 * Builds the sample project's page tree under a scratch page the integration
 * can see, then runs init → marker → full → append → replace → --check, and
 * checks every step with an independent read from Notion — never by trusting
 * the engine's own report. The probe standard (Manifest's testing rules):
 *
 *   - calibration: before anything is written, a known quantity is read (the
 *     scratch page's child-page count) and afterwards it must have moved by
 *     exactly one (the new hub), so a read that reaches nothing cannot pass;
 *   - control: `--check` must say stale after an edit and in step after a
 *     sync — a check that always says "in step" fails here;
 *   - throw on a non-answer: an exit code, a missing id, a response that is
 *     not a list is an error, never a pass.
 *
 * Works on a copy of fixtures/sample-project in a temp folder with its own
 * git history (appends are decided from committed blobs), with the stamp on.
 * The committed fixture is never changed. The tree is left in place to look
 * at; trash its hub page in Notion to remove all of it.
 *
 * The token comes from NOTION_TOKEN or this package's git-ignored .env, and
 * is never printed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { notionFetch, getChildren, queryDataSource, readToken } from '../lib/api.mjs';
import { plainText } from '../lib/render.mjs';
import { stampFor, STAMP_DEFAULTS, RENDER_KEY } from '../lib/stamp.mjs';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const parentArg = args.includes('--parent') ? args[args.indexOf('--parent') + 1] : null;
const parentId = String(parentArg ?? '').replace(/-/g, '').match(/[0-9a-f]{32}/i)?.[0];
if (!parentId) {
  console.error('usage: npm run fixture:live -- --parent <scratch page url or id>');
  process.exit(2);
}
process.env.NOTION_TOKEN ??= readToken(pkg);
const token = process.env.NOTION_TOKEN;

let n = 0;
const step = msg => console.log(`\n[${++n}] ${msg}`);
const must = (cond, msg) => {
  if (!cond) throw new Error(`PROBE FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
};
const list = (x, what) => {
  if (!Array.isArray(x)) throw new Error(`non-answer: ${what} did not come back as a list`);
  return x;
};
const childPages = async id => list(await getChildren(id, token), `children of ${id}`).filter(b => b.type === 'child_page');
const texts = async id => list(await getChildren(id, token), `children of ${id}`).map(plainText);

/* ---- a copy of the sample project, with its own history ---- */
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'nrs-live-'));
fs.cpSync(path.join(pkg, 'fixtures/sample-project'), proj, { recursive: true });
fs.rmSync(path.join(proj, 'docs/.notion-ids.json'), { force: true });
fs.renameSync(path.join(proj, 'notion-sync.config.mjs'), path.join(proj, 'base.config.mjs'));
fs.writeFileSync(
  path.join(proj, 'notion-sync.config.mjs'),
  "import base from './base.config.mjs';\nexport default { ...base, stamp: true };\n",
);
const git = (argv, date) =>
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...argv], {
    cwd: proj, encoding: 'utf8', env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  }).trim();
git(['init', '-q', '-b', 'main']);
git(['add', '.']);
git(['commit', '-qm', 'fixture'], '2026-10-01T09:00:00Z');

const cfg = path.join(proj, 'notion-sync.config.mjs');
const cli = (argv, expect = 0) => {
  const r = spawnSync(process.execPath, [path.join(pkg, 'cli.mjs'), ...argv, '--config', cfg], {
    cwd: proj, encoding: 'utf8', env: process.env,
  });
  const out = `${r.stdout}${r.stderr}`;
  if (r.status !== expect) throw new Error(`non-answer: \`${argv.join(' ')}\` exited ${r.status}, expected ${expect}\n${out}`);
  return out;
};
const ids = () => JSON.parse(fs.readFileSync(path.join(proj, 'docs/.notion-ids.json'), 'utf8'));
const expectedStamp = file => {
  const last = rel => git(['log', '-1', '--format=%cI', '--', rel]) || null;
  return stampFor([file, RENDER_KEY], last, { ...STAMP_DEFAULTS }).replace(/\*/g, '');
};

try {
  step('calibration: the scratch page can be read, and its child pages counted');
  const parent = await notionFetch(`/pages/${parentId}`, { token });
  must(parent?.id?.replace(/-/g, '') === parentId, `scratch page answers (${parent.url})`);
  const before = (await childPages(parentId)).length;
  must(Number.isInteger(before), `${before} child page(s) under it before`);

  step('build the sample tree under it');
  const made = spawnSync(process.execPath, [path.join(pkg, 'fixtures/create-scratch-tree.mjs'), '--parent', parentId], {
    cwd: proj, encoding: 'utf8', env: process.env,
  });
  if (made.status !== 0) throw new Error(`non-answer: create-scratch-tree exited ${made.status}\n${made.stderr}`);
  const hubId = made.stdout.match(/^hub\s+([0-9a-f-]{36})/m)?.[1];
  must(hubId, `hub created (${made.stdout.match(/https:\S+/)?.[0] ?? hubId})`);
  must((await childPages(parentId)).length === before + 1, `the scratch page now has ${before + 1} child page(s) — exactly one more`);
  const hubKids = list(await getChildren(hubId, token), 'hub children');
  must(hubKids.filter(b => b.type === 'child_page').length === 3 && hubKids.some(b => b.type === 'child_database'),
    'the hub holds Plan, Runbook, Log and the Roadmap database');

  step('--init resolves every id under the hub; --init-marker records the marker');
  cli(['--init', '--hub', hubId]);
  const got = ids();
  must(['hub', 'plan', 'runbook', 'log'].every(k => got.pages?.[k]), 'four page ids in the id file');
  must(got.databases?.roadmap, 'the Roadmap data source id in the id file');
  cli(['--init-marker']);
  must(ids().markers?.hub, 'the hub marker recorded');

  step('full: every page written, then read back from Notion independently');
  const full = cli(['full']);
  must(/4 written/.test(full), 'the engine reports 4 written');
  const { pages, databases } = ids();
  const plan = await texts(pages.plan);
  must(plan[0] === expectedStamp('docs/PLAN.md'), `Plan opens with its stamp: "${plan[0]}"`);
  must(plan.some(t => t.includes('Copy the generic modules')), 'Plan carries its text');
  const hub = await texts(pages.hub);
  must(hub.includes('Sample project') && hub.some(t => t.includes('hand-written')), 'the hub\'s hand-written header survived');
  must(hub.some(t => t.includes('generated from the repo')) && hub.includes('Now'), 'the marker, then the generated section');
  let log = await texts(pages.log);
  must(log.some(t => t.includes('first live run')) && log.at(-1).includes('Earlier phases'), 'Log carries the newest phase and ends with its pointer');
  const rows = list(await queryDataSource(databases.roadmap, token), 'roadmap rows');
  must(rows.length === 3, `the Roadmap holds ${rows.length} rows — one per phase in PLAN.md`);

  step('control: --check says in step after a sync');
  must(/in step/.test(cli(['--check'])), '--check: in step');

  step('append: a new entry under the newest phase');
  fs.appendFileSync(path.join(proj, 'docs/log.md'), '\n### 2026-10-08 · the live fixture appends\n\nAppended by fixture:live.\n');
  git(['add', 'docs/log.md']);
  git(['commit', '-qm', 'append'], '2026-10-08T12:34:00Z');
  const stale = cli(['--check']);
  must(/~ docs\/log\.md/.test(stale) && !/in step/.test(stale), 'control: --check says docs/log.md is stale after the edit');
  must(/append\s+log/.test(cli(['--dry-run'])), 'the plan says append for Log, not replace');
  must(/log — append/.test(cli(['sync'])), 'the engine appended');
  log = await texts(pages.log);
  must(log.some(t => t.includes('Appended by fixture:live')), 'the new entry is on the page');
  must(log.some(t => t.includes('first live run')), 'the earlier entry is still there — appended, not rewritten');
  must(log.at(-1).includes('Earlier phases'), 'the pointer is still last');
  must(log[0] === expectedStamp('docs/log.md'), `the stamp moved on in place: "${log[0]}"`);
  must(/in step/.test(cli(['--check'])), '--check: in step again');

  step('replace: an edit inside an existing line');
  const planPath = path.join(proj, 'docs/PLAN.md');
  fs.writeFileSync(planPath, fs.readFileSync(planPath, 'utf8').replace('Copy the generic modules', 'Copy the generic modules (edited live)'));
  git(['add', 'docs/PLAN.md']);
  git(['commit', '-qm', 'edit'], '2026-10-09T08:00:00Z');
  must(/replace\s+plan/.test(cli(['--dry-run'])), 'the plan says replace for Plan');
  must(/plan — replace/.test(cli(['sync'])), 'the engine replaced');
  const plan2 = await texts(pages.plan);
  must(plan2.some(t => t.includes('(edited live)')), 'the edit is on the page');
  must(plan2[0] === expectedStamp('docs/PLAN.md'), `the stamp is the edit's commit: "${plan2[0]}"`);
  must(list(await queryDataSource(databases.roadmap, token), 'roadmap rows').length === 3, 'the Roadmap still holds 3 rows');
  must(/in step/.test(cli(['--check'])), '--check: in step');

  console.log(`\n✓ fixture:live — every step proved by an independent read. The tree is left under the scratch page; trash "Sample — Hub" to remove it.`);
} catch (err) {
  console.error(`\n✗ ${err.message}\n  (project copy kept at ${proj})`);
  process.exit(1);
}
fs.rmSync(proj, { recursive: true, force: true });
