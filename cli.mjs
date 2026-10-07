#!/usr/bin/env node
/**
 * notion-repo-sync — mirror a repo's documents into Notion, driven by the
 * project's notion-sync.config.mjs.
 *
 *   notion-repo-sync [sync|full|<database-key>] [flags]
 *
 *   sync              (default) diff-gated page sync + every database whose
 *                     `when` is not 'command'
 *   full              ignore the recorded state and rewrite every page
 *   <database-key>    run one database only (an intake, e.g. `feedback`)
 *
 *   --dry-run         print the per-page plan and write nothing
 *   --check           report which sources changed since the recorded state
 *                     (no network)
 *   --page <key>      restrict to one page
 *   --init            resolve page/database ids under the hub, write the id file
 *   --hub <id|url>    seed the hub page id for --init (the one id never guessed)
 *   --init-marker     insert the boundary marker on marker-strategy pages
 *   --config <path>   config file (default ./notion-sync.config.mjs)
 *   --ids <path>      alternate id file (a test tree); state is re-derived
 *   --force           skip the branch guard
 *
 * Safety rules enforced here rather than remembered:
 *   - sync only from the configured branch
 *   - a marker page is never written without its marker — abort, never guess
 *   - state hashes advance only for pages that succeeded
 *   - a --force run off the configured branch writes pages but records no state
 *   - read-back after every structural write: count and probe, or fail
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  readToken, notionFetch, getChildren, appendChunked, deleteBlocks, deleteChildrenAfter,
} from './lib/api.mjs';
import { renderMarkdown, callout, plainText, probesOf } from './lib/render.mjs';
import { writeBlocks, readBack } from './lib/pages.mjs';
import {
  statePathFor, loadState, saveState, planPages, blobContent, git, shouldRecordState,
} from './lib/state.mjs';
import { isStamp } from './lib/stamp.mjs';
import { syncDatabase } from './lib/database.mjs';
import {
  DEFAULT_CONFIG_FILE, loadConfig, makeContext, currentHashes, assemblePages,
} from './lib/config.mjs';

/* ---- args ---- */
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const opt = name => {
  const i = args.indexOf(name);
  return i !== -1 && !args[i + 1]?.startsWith('--') ? args[i + 1] : null;
};
const log = (...xs) => console.log(...xs);
const fail = msg => {
  console.error(`✗ ${msg}`);
  process.exit(2);
};

const configPath = path.resolve(opt('--config') ?? DEFAULT_CONFIG_FILE);
const config = await loadConfig(configPath).catch(err => fail(err.message));
const ctx = makeContext(config);
const dryRun = flag('--dry-run');

const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--page', '--config', '--ids', '--hub'].includes(args[i - 1])));
const mode = positional[0] ?? 'sync';
const dbKeys = new Set(config.databases.map(d => d.key));
if (!['sync', 'full'].includes(mode) && !dbKeys.has(mode)) {
  fail(`unknown mode "${mode}" — sync, full, or one of: ${[...dbKeys].join(', ') || '(no databases declared)'}`);
}

const idsOverridden = Boolean(opt('--ids'));
const idsPath = path.resolve(config.root, opt('--ids') ?? config.ids);
const statePath = statePathFor(idsPath, config.state ? path.resolve(config.root, config.state) : null, { idsOverridden });
if (idsOverridden && typeof config.state === 'string') {
  log(`  (ids overridden — state re-derived to ${path.relative(config.root, statePath)}, not the configured path)`);
}

const loadIds = () => (fs.existsSync(idsPath) ? JSON.parse(fs.readFileSync(idsPath, 'utf8')) : null);
const saveIds = ids => {
  fs.mkdirSync(path.dirname(idsPath), { recursive: true });
  fs.writeFileSync(idsPath, JSON.stringify(ids, null, 2) + '\n');
};
const token = () => readToken(config.root, config.tokenEnv);

/* ---- guards ---- */
const branch = git(['branch', '--show-current'], config.root);
if (config.branch && branch !== config.branch && !flag('--force') && !dryRun && !flag('--check')) {
  fail(`sync runs from ${config.branch}, not ${branch ?? 'unknown'} — the docs live there (--force to override)`);
}

/* ---- --check: staleness report, no network ---- */
if (flag('--check')) {
  const state = loadState(statePath);
  const current = currentHashes(config, ctx);
  if (!state) fail('no recorded state — a full sync has never run');
  const stale = Object.keys(current).filter(k => state.sources[k] !== current[k]);
  if (!stale.length) {
    log(`✓ in step with the board — nothing changed since ${state.at} (${state.commit})`);
  } else {
    log(`${stale.length} source(s) changed since the last sync (${state.at}):`);
    for (const k of stale) log(`  ~ ${k}`);
  }
  process.exit(0);
}

/* ---- --init: resolve ids by walking a trusted hub, never by global search ----
 *
 * A workspace-wide title search cannot tell a production page from a
 * test-tree duplicate of it. The hub id is the one id nothing here may guess:
 * seed it (--hub, or by hand in the id file) and every other id is resolved by
 * walking that page's own child_page/child_database blocks, which the API
 * scopes to that page's actual children. Only when the hub is unseeded does
 * this fall back to a global search, and it says loudly that the result needs
 * verifying by hand. */
const idOf = s => {
  const m = String(s).replace(/-/g, '').match(/[0-9a-f]{32}/i);
  return m ? m[0] : null;
};
const norm = s => s.replace(/^[^\p{L}\p{N}]+/u, '').trim();

if (flag('--init')) {
  const tok = token();
  const hubPage = config.pages.find(p => p.key === config.hub);
  const existing = loadIds();
  let hubId = idOf(opt('--hub') ?? '') ?? existing?.pages?.[config.hub];

  if (!hubId) {
    log('  no hub seed — falling back to a global title search for it only.');
    log(`  UNVERIFIED: if this workspace has more than one page titled "${hubPage.title}"`);
    log('  (a test-tree duplicate, for instance), this can silently pick the wrong one.');
    log('  Confirm the id by hand before trusting anything resolved from it.');
    const res = await notionFetch('/search', {
      method: 'POST',
      token: tok,
      body: { query: hubPage.title, filter: { property: 'object', value: 'page' }, page_size: 10 },
    });
    const titleOf = r => (r.properties?.title?.title ?? []).map(t => t.plain_text).join('');
    const hit = res.results.find(h => titleOf(h) === hubPage.title) ?? res.results[0];
    if (!hit) fail(`--init: no page found for "${hubPage.title}" — is it shared with the integration?`);
    hubId = hit.id;
    log(`  ${config.hub} → ${titleOf(hit)} (${hubId}) — UNVERIFIED, confirm by hand`);
  } else {
    log(`  ${config.hub} → ${hubId} (seeded)`);
  }

  const children = await getChildren(hubId, tok);
  const ids = { pages: { [config.hub]: hubId }, markers: existing?.markers ?? {}, databases: {} };

  for (const page of config.pages) {
    if (page.key === config.hub) continue;
    const hit = children.find(b => b.type === 'child_page' && norm(b.child_page.title) === page.title);
    if (!hit) fail(`--init: no child page titled "${page.title}" directly under the hub (${hubId}) — create it there first`);
    ids.pages[page.key] = hit.id;
    log(`  ${page.key} → ${hit.child_page.title} (${hit.id})`);
  }

  for (const db of config.databases) {
    const hit = children.find(b => b.type === 'child_database' && norm(b.child_database.title) === db.title);
    if (!hit) {
      log(`  ${db.key} — no child database titled "${db.title}" under the hub; this database stays off`);
      continue;
    }
    const dsRes = await notionFetch(`/databases/${hit.id}`, { token: tok });
    const dataSourceId = dsRes.data_sources?.[0]?.id;
    if (!dataSourceId) {
      log(`  ${db.key} — database found (${hit.id}) but it has no data source; skipped`);
      continue;
    }
    ids.databases[db.key] = dataSourceId;
    log(`  ${db.key} → data source ${dataSourceId} (database ${hit.id})`);
  }

  saveIds(ids);
  log(`✓ wrote ${path.relative(config.root, idsPath)} — every id scoped under the hub (${hubId})`);
  process.exit(0);
}

/* ---- --init-marker: the boundary callout on every marker page ---- */
if (flag('--init-marker')) {
  const tok = token();
  const ids = loadIds() ?? fail(`no id file at ${idsPath} — run --init first`);
  ids.markers ??= {};
  for (const page of config.pages.filter(p => p.strategy === 'marker')) {
    const pageId = ids.pages[page.key] ?? fail(`no id for page "${page.key}"`);
    const children = await getChildren(pageId, tok);
    const found = children.find(b => b.type === 'callout' && plainText(b).includes(config.marker.match));
    if (found) {
      ids.markers[page.key] = found.id;
      log(`✓ ${page.key}: marker already present (${found.id}) — recorded`);
    } else {
      const created = await appendChunked(pageId, [callout(config.marker.text)], tok, {
        afterBlockId: children.at(-1)?.id,
      });
      ids.markers[page.key] = created[0].id;
      log(`✓ ${page.key}: marker inserted at the end of the page (${created[0].id})`);
      log('  Drag it up to sit just below the hand-written header before the first sync.');
    }
  }
  saveIds(ids);
  process.exit(0);
}

/* ---- the sync ---- */

const renderOpts = { promptQuote: config.promptQuote };

async function syncPages(ids) {
  const state = mode === 'full' ? null : loadState(statePath);
  const current = currentHashes(config, ctx);
  const only = opt('--page');
  const plan = planPages(assemblePages(config, ctx), state?.sources ?? null, current, {
    readOld: sha => blobContent(sha, config.root),
    readNew: page => ctx.read(page.fileKey),
  }).filter(p => !only || p.key === only);

  log(`\nnotion-repo-sync · ${mode}${dryRun ? ' · DRY RUN' : ''} · branch ${branch ?? 'unknown'} · ids ${path.relative(config.root, idsPath)}`);
  for (const p of plan) log(`  ${p.action.padEnd(7)} ${p.key.padEnd(16)} ${p.reason}`);

  if (dryRun) return { results: [], current };

  const tok = token();
  const results = [];
  for (const page of plan) {
    if (page.action === 'skip') {
      results.push({ ...page, ok: true, skipped: true });
      continue;
    }
    const pageId = ids.pages?.[page.key];
    if (!pageId) {
      results.push({ ...page, ok: false, error: 'no page id in the id file — run --init' });
      continue;
    }
    try {
      let appended = 0;
      let topLevelRendered = 0;
      const markerId = ids.markers?.[page.key];
      if (page.action === 'marker') {
        if (!markerId) throw new Error('no marker recorded — run --init-marker; never guessing a boundary on this page');
        const { markerFound } = await deleteChildrenAfter(pageId, tok, { markerId });
        if (!markerFound) throw new Error('marker not found on the page — run --init-marker; never guessing a boundary');
        const rendered = renderMarkdown(page.md, renderOpts);
        topLevelRendered = rendered.length;
        appended = await writeBlocks(pageId, rendered, tok, { afterBlockId: markerId });
      } else if (page.action === 'append') {
        const children = await getChildren(pageId, tok);
        /* The trailing pointer (if this page carries one) comes off before the
         * new sections go on, and goes back after them. */
        const tail = children.at(-1);
        const pointerProbe = page.pointer ? probesOf(page.pointer, renderOpts).first : null;
        let after = tail?.id;
        if (pointerProbe && tail && plainText(tail).includes(pointerProbe)) {
          await deleteBlocks([tail.id], tok);
          after = children.at(-2)?.id;
        }
        const addition = page.appendMd + (page.pointer ? `\n\n${page.pointer}` : '');
        const rendered = renderMarkdown(addition, renderOpts);
        topLevelRendered = rendered.length;
        appended = await writeBlocks(pageId, rendered, tok, { afterBlockId: after });
        /* The page's first block is its stamp (written on its last replace); an
         * append moves the time on in place. A page without one gets it at its
         * next replace. */
        const first = children[0];
        if (page.stamp && first?.type === 'paragraph' && isStamp(plainText(first), config.stamp.prefix)) {
          const [fresh] = renderMarkdown(page.stamp, renderOpts);
          await notionFetch(`/blocks/${first.id}`, {
            method: 'PATCH', token: tok, body: { paragraph: { rich_text: fresh.paragraph.rich_text } },
          });
        }
      } else {
        await deleteChildrenAfter(pageId, tok);
        const rendered = renderMarkdown(page.md, renderOpts);
        topLevelRendered = rendered.length;
        appended = await writeBlocks(pageId, rendered, tok);
      }

      const probes = probesOf(page.action === 'append' ? page.appendMd : page.md, renderOpts);
      /* expectAtLeast is the rendered markdown's own top-level block count —
       * not the recursive `appended` accumulator, which counts nested blocks
       * too and made this threshold meaningless once. */
      const blockCount = await readBack(pageId, tok, {
        expectAtLeast: Math.max(1, topLevelRendered),
        firstProbe: page.action === 'append' ? null : probes.first,
        lastProbe: page.pointer ? null : probes.last,
        label: page.key,
        sinceBlockId: page.action === 'marker' ? markerId : null,
      });
      results.push({ ...page, ok: true, appended, blockCount });
      log(`  ✓ ${page.key} — ${page.action}, ${appended} blocks written, ${blockCount} on page`);
    } catch (err) {
      results.push({ ...page, ok: false, error: err.message });
      log(`  ✗ ${page.key} — ${err.message}`);
    }
  }
  return { results, current };
}

async function runDatabase(db, ids) {
  const dataSourceId = ids?.databases?.[db.key];
  if (!dataSourceId) {
    log(`  – ${db.key}: no data source in the id file, skipped`);
    return true;
  }
  /* A dry run reads the board — a plan for a database is a comparison with
   * what is on it — and writes nothing. Without a token it says so and skips,
   * rather than sending a request that can only be refused. */
  let tok;
  try {
    tok = token();
  } catch {
    if (!dryRun) throw new Error(`${config.tokenEnv} not found`);
    log(`  – ${db.key} (dry): no token, so the board was not read`);
    return true;
  }
  try {
    const summary = await syncDatabase(db, dataSourceId, tok, { dryRun, ctx });
    log(summary.line);
    return summary.ok;
  } catch (err) {
    log(`  ✗ ${db.key} — ${err.message}`);
    return false;
  }
}

const run = async () => {
  const ids = loadIds();
  if (!ids && !dryRun) fail(`no id file at ${idsPath} — run --init first`);

  if (dbKeys.has(mode)) {
    const db = config.databases.find(d => d.key === mode);
    if (dryRun && !ids?.databases?.[db.key]) fail(`no data source for "${db.key}" in the id file`);
    const ok = await runDatabase(db, ids);
    process.exit(ok ? 0 : 1);
  }

  const { results, current } = await syncPages(ids);

  /* Databases with `when: 'always'` (the default) run on every sync and are
   * never gated on hashes — a missing card is invisible to a diff. */
  let dbOk = true;
  for (const db of config.databases.filter(d => d.when !== 'command')) {
    if (dryRun && !ids?.databases?.[db.key]) continue;
    if (!(await runDatabase(db, ids))) dbOk = false;
  }

  if (dryRun) process.exit(0);

  /* Hashes advance only for what succeeded; failures keep the old hash and
   * retry next run. Keys no page reads anymore are dropped. */
  const prior = loadState(statePath)?.sources ?? {};
  const sources = { ...prior };
  const succeeded = results.filter(r => r.ok);
  for (const r of succeeded) for (const k of r.sourceKeys) sources[k] = current[k];
  for (const k of Object.keys(sources)) if (!(k in current)) delete sources[k];
  for (const rel of config.track) sources[rel] = current[rel];

  const failed = results.filter(r => !r.ok);
  const written = succeeded.filter(r => !r.skipped);
  const record = shouldRecordState({ branch, configBranch: config.branch, forced: flag('--force') });
  if (!record) {
    log(`  state not recorded — forced run off ${config.branch}; CI will re-sync these pages from ${config.branch}`);
  } else saveState(
    statePath,
    {
      mode,
      sources,
      note: `notion-repo-sync: ${written.length} written (${written.map(r => r.key).join(', ') || 'none'}), ${
        results.filter(r => r.skipped).length
      } skipped${failed.length ? `, FAILED: ${failed.map(r => r.key).join(', ')}` : ''}.`,
    },
    config.root,
  );

  log(
    `\n${failed.length || !dbOk ? '✗' : '✓'} ${written.length} written, ${
      results.filter(r => r.skipped).length
    } skipped${failed.length ? `, ${failed.length} FAILED` : ''}`,
  );
  process.exit(failed.length || !dbOk ? 1 : 0);
};

run().catch(err => {
  console.error(`✗ sync crashed: ${err.stack ?? err}`);
  process.exit(1);
});
