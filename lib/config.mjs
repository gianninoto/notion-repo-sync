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
import * as extract from './extract.mjs';

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
    pages,
    databases,
  };
}

/* The context every config function receives: a root-relative reader and the
 * pure helpers, so a typical page needs no parsing code of its own. */
export function makeContext(config) {
  const read = rel => fs.readFileSync(path.join(config.root, rel), 'utf8');
  const exists = rel => fs.existsSync(path.join(config.root, rel));
  return { root: config.root, read, exists, ...extract };
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
    const extractFn = page.extract ? text => page.extract(text, ctx) : null;
    return {
      key: page.key,
      title: page.title,
      strategy: page.strategy,
      sourceKeys: page.sources.map(sourceKey),
      fileKey: page.fileKey ?? null,
      extract: extractFn,
      pointer: page.pointer ?? null,
      md,
    };
  });
}
