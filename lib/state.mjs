/**
 * The diff gate — reads and writes the state file and turns "which hashes
 * moved" into a per-page plan.
 *
 * Rules, enforced by code:
 *   - a page is skipped iff every source it reads hashes identical
 *   - `commit`/`branch` in the state file are audit-only; no decision ever
 *     branches on them. Old content for append checks is retrieved by *blob
 *     hash* (`git cat-file blob <sha>`), which works across branches and
 *     rebases — the entire reason the fingerprints are blob hashes.
 *   - append is chosen only when the old extracted section is a strict prefix
 *     of the new one ("purely additive" decided by comparison, not judgment);
 *     anything else replaces, which is always correct and merely costlier.
 *   - the state file is written once, at the end, with new hashes only for
 *     the pages that actually succeeded — a failed page keeps its old hash so
 *     the next run retries exactly that page.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/* The state file must be scoped to the id file it tracks — a real-workspace
 * sync and a test-tree sync must never share one. They did, once: a test-tree
 * `full` run wrote its results into the production state file, and because
 * the diff gate only asks "does this hash match", the next real sync would
 * have read those hashes as already-synced and silently skipped content that
 * had only ever reached the test tree. So the state path is derived from the
 * id file's own name unless the config names one explicitly AND the id file
 * was not overridden on the command line. */
export function statePathFor(idsPath, configured, { idsOverridden = false } = {}) {
  if (typeof configured === 'function') return configured(idsPath);
  if (typeof configured === 'string' && !idsOverridden) return configured;
  return idsPath.replace(/\.json$/, '') + '.state.json';
}

export function loadState(statePath) {
  if (!fs.existsSync(statePath)) return null;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return state?.sources ? state : null;
}

export function saveState(statePath, { mode, sources, note }, root) {
  const commit = git(['rev-parse', '--short', 'HEAD'], root) ?? 'unknown';
  const branch = git(['branch', '--show-current'], root) ?? 'unknown';
  const state = {
    at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    mode,
    commit,
    branch,
    sources,
    note,
  };
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  return state;
}

/* A forced run off the configured branch writes pages but records nothing:
 * its hashes describe content the branch does not hold, and recording them
 * would make the next real sync skip pages it never wrote (Manifest,
 * 2026-09-16 — a hand-run off the branch made CI skip a damaged page). CI
 * re-syncs those pages on the branch's next push. */
export function shouldRecordState({ branch, configBranch, forced }) {
  return !(forced && configBranch && branch !== configBranch);
}

export const git = (args, cwd) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 25 }).trim();
  } catch {
    return null;
  }
};

/* Old content by content-address. Null when the blob was never committed
 * (a working-tree-only edit at the previous sync) — callers fall back to
 * replace, which is correct either way. */
export const blobContent = (sha, root) => (sha ? git(['cat-file', 'blob', sha], root) : null);

/**
 * Decide per page: skip | replace | append | marker.
 * `pages` are assembled pages (lib/config.mjs); `recorded`/`current` are hash
 * maps keyed by source. A page with no recorded hash for any source it reads
 * is treated as changed (first run, or a brand-new page).
 *
 * `readOld(sha)` and `readNew(page)` are injected so the decision is testable
 * without git or a filesystem.
 */
export function planPages(pages, recorded, current, { readOld, readNew }) {
  return pages.map(page => {
    const changed = page.sourceKeys.filter(k => recorded?.[k] !== current[k]);
    if (recorded && changed.length === 0) {
      return { ...page, action: 'skip', reason: 'sources unchanged' };
    }

    /* A moved render key means every page must look different: rewrite it,
     * never append to the old look. */
    const rerender = changed.includes('notion-render');

    if (page.strategy === 'append' && recorded && !rerender) {
      const oldFile = readOld(recorded[page.fileKey]);
      if (oldFile != null) {
        const oldSection = page.extract(oldFile);
        const newSection = page.extract(readNew(page));
        if (newSection.startsWith(oldSection) && newSection.length > oldSection.length) {
          return {
            ...page,
            action: 'append',
            appendMd: newSection.slice(oldSection.length),
            reason: `purely additive (${changed.join(', ')})`,
          };
        }
        if (newSection === oldSection) {
          return { ...page, action: 'skip', reason: 'section unchanged inside a moved file' };
        }
      }
      return { ...page, action: 'replace', reason: `not a pure addition (${changed.join(', ')})` };
    }

    return {
      ...page,
      action: page.strategy === 'marker' ? 'marker' : 'replace',
      reason: recorded ? `changed: ${changed.join(', ')}` : 'no recorded state (full)',
    };
  });
}
