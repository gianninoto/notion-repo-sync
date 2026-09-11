/**
 * The Notion REST layer. Everything here is transport: auth, throttle, retry,
 * pagination, and the block-write helpers whose limits come from Notion's
 * documented request caps.
 *
 * Why REST and not the Notion MCP: the MCP is OAuth-only with no
 * non-interactive auth, and its markdown converter was the source of every
 * parser quirk the agent-driven sync had to work around. This layer sends
 * structured block JSON, so that bug class does not exist on this path.
 *
 * Documented limits this file encodes (developers.notion.com, verified
 * 2026-08-18 against Notion-Version 2026-03-11):
 *   - ~3 requests/second average per integration; 429/529 carry Retry-After
 *   - retry 500/502/503/504 only on idempotent methods; backoff capped 30s,
 *     max 6 attempts
 *   - <=100 blocks per children append; <=1000 blocks / 500KB per payload
 *   - rich_text content <=2000 chars per element (enforced by the renderer)
 */
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.notion.com/v1';
const VERSION = '2026-03-11';

/* Env var wins; a git-ignored `.env` at the project root is the local
 * fallback. No dotenv dependency for five lines of parsing. */
export function readToken(root = process.cwd(), envName = 'NOTION_TOKEN') {
  if (process.env[envName]) return process.env[envName];
  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, 'utf8').match(new RegExp(`^${envName}=(.+)$`, 'm'));
    if (m) return m[1].trim();
  }
  throw new Error(
    `${envName} not found. Set the env var, or put ${envName}=ntn_... in a project-root .env (git-ignored).`,
  );
}

/* One token bucket for the whole process. 360ms spacing keeps the average
 * under the documented 3 rps without relying on burst allowance. */
let nextSlot = 0;
const throttle = async () => {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 360;
  if (wait) await new Promise(r => setTimeout(r, wait));
};

const IDEMPOTENT = new Set(['GET', 'DELETE']);

export async function notionFetch(pathname, { method = 'GET', body, token, query } = {}) {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(query ?? {})) {
    for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item);
  }
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    await throttle();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': VERSION,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      /* Network failure: retry only what is safe to repeat. */
      lastErr = err;
      if (!IDEMPOTENT.has(method)) throw err;
      await backoff(attempt);
      continue;
    }
    if (res.ok) return res.status === 204 ? null : res.json();

    const text = await res.text();
    const retryAfter = Number(res.headers.get('Retry-After')) || null;
    const retriable =
      res.status === 429 || res.status === 529 ||
      ([500, 502, 503, 504].includes(res.status) && IDEMPOTENT.has(method));
    lastErr = new Error(`${method} ${pathname} → ${res.status}: ${text.slice(0, 300)}`);
    if (!retriable || attempt === 5) throw lastErr;
    await backoff(attempt, retryAfter);
  }
  throw lastErr;
}

const backoff = (attempt, retryAfter = null) => {
  const base = retryAfter != null ? retryAfter * 1000 : 500 * 2 ** attempt;
  const ms = Math.min(30_000, base) + Math.random() * 250;
  return new Promise(r => setTimeout(r, ms));
};

/* ---- pagination ---- */

export async function getChildren(blockId, token) {
  const out = [];
  let cursor;
  do {
    const page = await notionFetch(`/blocks/${blockId}/children`, {
      token,
      query: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
    });
    out.push(...page.results);
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return out;
}

export async function queryDataSource(dataSourceId, token, { filter, sorts, filterProperties } = {}) {
  const out = [];
  let cursor;
  do {
    const page = await notionFetch(`/data_sources/${dataSourceId}/query`, {
      method: 'POST',
      token,
      query: filterProperties ? { filter_properties: filterProperties } : {},
      body: {
        page_size: 100,
        ...(filter ? { filter } : {}),
        ...(sorts ? { sorts } : {}),
        ...(cursor ? { start_cursor: cursor } : {}),
      },
    });
    out.push(...page.results);
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return out;
}

/* ---- writes ---- */

/* <=100 blocks per call is the documented cap; the 450KB guard is headroom
 * under the 500KB payload limit for chunks dense with long code rich_texts. */
export async function appendChunked(blockId, blocks, token, { afterBlockId } = {}) {
  const created = [];
  let position = afterBlockId
    ? { type: 'after_block', after_block: { id: afterBlockId } }
    : undefined;
  for (let i = 0; i < blocks.length; ) {
    let n = Math.min(100, blocks.length - i);
    while (n > 1 && JSON.stringify(blocks.slice(i, i + n)).length > 450_000) n = Math.ceil(n / 2);
    const chunk = blocks.slice(i, i + n);
    const res = await notionFetch(`/blocks/${blockId}/children`, {
      method: 'PATCH',
      token,
      body: { children: chunk, ...(position ? { position } : {}) },
    });
    created.push(...res.results);
    /* Later chunks continue after the last block just written, so an append
     * into the middle of a page stays contiguous. */
    if (position) position = { type: 'after_block', after_block: { id: res.results.at(-1).id } };
    i += n;
  }
  return created;
}

export async function deleteBlocks(ids, token) {
  for (const id of ids) await notionFetch(`/blocks/${id}`, { method: 'DELETE', token });
  return ids.length;
}

/* A child_page or child_database block IS the page/database it names — the
 * block and the object are the same thing in Notion's model. Archiving one
 * does not remove a reference, it trashes the actual page. A hub page's real
 * nested children typically sit after the generated text as exactly these
 * block types. Discovered 2026-08-18 by inspecting the block list before ever
 * running a real replace — a marker placed before them and a naive "delete
 * everything after it" would have trashed the entire page tree on the first
 * sync. Never lifted. */
export const isStructuralChild = b => b.type === 'child_page' || b.type === 'child_database';

/* Pure so it is testable without a network mock. Given a page's children and
 * an optional marker id, returns exactly the blocks a replace is allowed to
 * delete: everything after the marker (or everything, if no marker), up to
 * but excluding the first structural child. Structural children are never in
 * the returned list no matter where they sit. */
export function computeDoomed(children, markerId) {
  let scope = children;
  if (markerId) {
    const at = children.findIndex(b => sameId(b.id, markerId));
    if (at === -1) return { doomed: null, markerFound: false };
    scope = children.slice(at + 1);
  }
  const firstStructural = scope.findIndex(isStructuralChild);
  const doomed = firstStructural === -1 ? scope : scope.slice(0, firstStructural);
  return { doomed, markerFound: true };
}

export const sameId = (a, b) => a.replaceAll('-', '') === b.replaceAll('-', '');

/* Replace everything after a marker block, or everything (markerId omitted)
 * — stopping before the first structural child either way. Returns what it
 * deleted so the caller can log it; the append is the caller's, so a failed
 * render never deletes a page. */
export async function deleteChildrenAfter(pageId, token, { markerId } = {}) {
  const children = await getChildren(pageId, token);
  const { doomed, markerFound } = computeDoomed(children, markerId);
  if (!markerFound) return { deleted: 0, markerFound: false, children };
  await deleteBlocks(doomed.map(b => b.id), token);
  return { deleted: doomed.length, markerFound: true, children };
}

export { API, VERSION };
