/**
 * Loads a project's `notion-sync.config.mjs`, validates it, and turns its
 * declarative page table into the assembled pages the planner consumes.
 *
 * The config is code, not JSON, on purpose: the escape hatch for a document
 * shaped like nothing the helpers anticipated is a function in the config,
 * not a fork of the engine.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as extract from './extract.mjs';
import { RENDER_KEY, RENDER_VERSION, STAMP_DEFAULTS, stampFor } from './stamp.mjs';

const { blobHash } = extract;

export const DEFAULT_CONFIG_FILE = 'notion-sync.config.mjs';

export async function loadConfig(configPath) {
  const abs = path.resolve(configPath);
  if (!fs.existsSync(abs)) {
    throw new Error(`no config at ${abs} — create ${DEFAULT_CONFIG_FILE} (the skill has a template)`);
  }
  const mod = await import(pathToFileURL(abs).href);
  const raw = typeof mod.default === 'function' ? await mod.default() : mod.default;
  return normalize(raw, path.dirname(abs));
}

export function normalize(raw, configDir) {
  if (!raw || typeof raw !== 'object') throw new Error('config must export an object');
  const root = path.resolve(raw.root ?? configDir);
  const pages = raw.pages ?? [];
  const databases = raw.databases ?? [];
  if (!pages.length && !databases.length) throw new Error('config declares no pages and no databases');

  const keys = new Set();
  for (const p of [...pages, ...databases]) {
    if (!p.key) throw new Error('every page and database needs a key');
    if (keys.has(p.key)) throw new Error(`duplicate key "${p.key}"`);
    keys.add(p.key);
  }
  for (const p of pages) {
    if (!['marker', 'replace', 'append'].includes(p.strategy)) {
      throw new Error(`page "${p.key}": strategy must be marker | replace | append`);
    }
    if (!p.title) throw new Error(`page "${p.key}" needs a title (it is how --init finds it under the hub)`);
    if (!Array.isArray(p.sources) || !p.sources.length) {
      throw new Error(`page "${p.key}" needs at least one source`);
    }
    if (p.strategy === 'append' && (!p.fileKey || typeof p.extract !== 'function')) {
      throw new Error(`page "${p.key}" (append) needs fileKey and extract(text)`);
    }
  }
  for (const d of databases) {
    if (!d.title) throw new Error(`database "${d.key}" needs a title`);
    if (d.mode === 'reconcile' && typeof d.desired !== 'function') {
      throw new Error(`database "${d.key}" (reconcile) needs desired(ctx)`);
    }
    if (d.mode === 'upsert' && typeof d.rows !== 'function') {
      throw new Error(`database "${d.key}" (upsert) needs rows(ctx)`);
    }
  }

  for (const d of databases) {
    if (d.calibrate !== undefined && typeof d.calibrate?.canary !== 'function') {
      throw new Error(`database "${d.key}": calibrate needs canary(row) — the row that proves the read reached real data`);
    }
  }

  const hub = raw.hub ?? pages.find(p => p.strategy === 'marker')?.key ?? pages[0]?.key;
  if (!keys.has(hub)) throw new Error(`hub "${hub}" is not a declared page`);

  return {
    root,
    ids: raw.ids ?? 'docs/.notion-ids.json',
    state: raw.state ?? null,
    branch: raw.branch === undefined ? null : raw.branch,
    tokenEnv: raw.tokenEnv ?? 'NOTION_TOKEN',
    hub,
    promptQuote: raw.promptQuote,
    marker: {
      text:
        raw.marker?.text ??
        'Everything below this line is generated from the repo by notion-repo-sync. Edit the repo, not this page.',
      match: raw.marker?.match ?? 'generated from the repo',
    },
    track: raw.track ?? [],
    /* Opt-in: `stamp: true` or `{ timeZone, label, prefix }`. Off, pages are
     * exactly what they were before the stamp existed. */
    stamp: raw.stamp ? { ...STAMP_DEFAULTS, ...(raw.stamp === true ? {} : raw.stamp) } : null,
    pages,
    databases,
  };
}

/* The context every config function receives: a root-relative reader and the
 * pure helpers, so a typical page needs no parsing code of its own. */
export function makeContext(config, { today } = {}) {
  const read = rel => fs.readFileSync(path.join(config.root, rel), 'utf8');
  const exists = rel => fs.existsSync(path.join(config.root, rel));
  /* The newest commit touching a file, for the stamp. Null when uncommitted. */
  const lastCommit = rel => {
    try {
      return execFileSync('git', ['log', '-1', '--format=%cI', '--', rel], {
        cwd: config.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null;
    } catch {
      return null;
    }
  };
  /* Today's date, for a dated page such as a digest ("as of", "N days ago").
   * A page that reads it moves only when a source moves or on a `full` run —
   * which is why the workflow runs `full` every Friday. */
  const day = today ?? new Date().toISOString().slice(0, 10);
  const ageOf = date => {
    if (!date) return 'undated';
    const days = Math.round((Date.parse(day) - Date.parse(date)) / 86_400_000);
    return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  };
  return { root: config.root, read, exists, lastCommit, today: day, ageOf, ...extract };
}

const sourceKey = s => (typeof s === 'string' ? s : s.key);

/* One hash per source any page reads (plus `track`). File-backed keys hash the
 * file; virtual keys `{ key, text(ctx) }` hash the extracted string. */
export function currentHashes(config, ctx) {
  const hashes = {};
  const virtuals = [];
  for (const page of config.pages) {
    for (const s of page.sources) {
      if (typeof s === 'string') hashes[s] = blobHash(ctx.read(s));
      else virtuals.push(s);
    }
    if (page.strategy === 'append' && !(page.fileKey in hashes)) {
      hashes[page.fileKey] = blobHash(ctx.read(page.fileKey));
    }
  }
  for (const rel of config.track) hashes[rel] = blobHash(ctx.read(rel));
  if (config.stamp) hashes[RENDER_KEY] = blobHash(RENDER_VERSION);
  for (const s of virtuals) {
    if (typeof s.text !== 'function') throw new Error(`virtual source "${s.key}" needs text(ctx)`);
    hashes[s.key] = blobHash(s.text(ctx));
  }
  return hashes;
}

/* Every page with its markdown resolved. `md` may be a string or a function
 * of the context; an append page defaults to `extract(read(fileKey))` plus its
 * pointer. */
export function assemblePages(config, ctx) {
  return config.pages.map(page => {
    let md;
    if (typeof page.md === 'function') md = page.md(ctx);
    else if (typeof page.md === 'string') md = page.md;
    else if (page.strategy === 'append') md = page.extract(ctx.read(page.fileKey), ctx);
    else if (page.sources.length === 1 && typeof page.sources[0] === 'string') md = ctx.read(page.sources[0]);
    else throw new Error(`page "${page.key}" needs md (string or function) — it reads more than one source`);
    if (page.pointer) md = `${md}\n\n${page.pointer}`;
    const sourceKeys = page.sources.map(sourceKey);
    /* Each page reads the render version too, and opens with its stamp; an
     * append page keeps the stamp apart, since only its first block changes on
     * an append (cli.mjs moves it on in place). */
    const stamp = config.stamp ? stampFor(sourceKeys, ctx.lastCommit, config.stamp) : '';
    if (config.stamp) sourceKeys.push(RENDER_KEY);
    if (stamp) md = `${stamp}\n\n${md}`;
    const extractFn = page.extract ? text => page.extract(text, ctx) : null;
    return {
      key: page.key,
      title: page.title,
      strategy: page.strategy,
      sourceKeys,
      stamp: stamp || null,
      fileKey: page.fileKey ?? null,
      extract: extractFn,
      pointer: page.pointer ?? null,
      md,
    };
  });
}
