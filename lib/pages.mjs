/**
 * Writing a rendered page and reading it back.
 *
 * The read-back is not optional. Every structural write is followed by a
 * count and two probes, or the page is reported failed and its hash does not
 * advance. The two false positives this module has had — recursing into
 * unrelated nested pages, and a probe that could never match a table row —
 * are documented inline because a check that cries wolf on correct writes is
 * its own hazard: it trains the reader to ignore red.
 */
import { getChildren, appendChunked, sameId } from './api.mjs';
import { needsSlowPath, stripChildren, plainText } from './render.mjs';

/* Appends blocks, taking the slow path for any block nested deeper than the
 * payload limit allows: append it childless, then recurse into the created id.
 * Shallow runs between deep blocks still go in bulk chunks. */
export async function writeBlocks(parentId, blocks, token, { afterBlockId } = {}) {
  let appended = 0;
  let after = afterBlockId;
  let buffer = [];
  const flush = async () => {
    if (!buffer.length) return;
    const created = await appendChunked(parentId, buffer, token, { afterBlockId: after });
    appended += created.length;
    after = created.at(-1)?.id ?? after;
    buffer = [];
  };
  for (const block of blocks) {
    if (!needsSlowPath(block)) {
      buffer.push(block);
      continue;
    }
    await flush();
    const { block: shallow, children } = stripChildren(block);
    const [created] = await appendChunked(parentId, [shallow], token, { afterBlockId: after });
    appended += 1;
    after = created.id;
    appended += await writeBlocks(created.id, children, token);
  }
  await flush();
  return appended;
}

/* Nested content (a quote's paragraphs, a table's rows) is invisible to a
 * single-level getChildren call, so the check walks down to find it. But it
 * must never recurse INTO a child_page or child_database — those are real
 * nested pages with their own large content trees, unrelated to whatever
 * generated the page being checked. Walking into them once pulled in hundreds
 * of unrelated blocks and pushed the page's actual last line out of the probe
 * window even though the write was complete and correct. */
export async function flattenBlocks(blocks, token, depth = 0, maxDepth = 5) {
  let all = [];
  for (const b of blocks) {
    all.push(b);
    if (b.has_children && depth < maxDepth && b.type !== 'child_page' && b.type !== 'child_database') {
      const kids = await getChildren(b.id, token);
      all = all.concat(await flattenBlocks(kids, token, depth + 1, maxDepth));
    }
  }
  return all;
}

/* `sinceBlockId` scopes the whole check to what comes after a marker: without
 * it, a hand-written header dominates the "first N" probe window on a page
 * whose generated content sits well past the top, and a check from block 0
 * reports genuinely-present content as missing. */
export async function readBack(pageId, token, { expectAtLeast, firstProbe, lastProbe, label, sinceBlockId }) {
  const topLevel = await getChildren(pageId, token);
  let scoped = topLevel;
  if (sinceBlockId) {
    const at = topLevel.findIndex(b => sameId(b.id, sinceBlockId));
    scoped = at === -1 ? topLevel : topLevel.slice(at + 1);
  }
  const all = await flattenBlocks(scoped, token);
  const texts = all.map(plainText).filter(t => t.trim());
  const problems = [];
  if (scoped.length < expectAtLeast) {
    problems.push(`only ${scoped.length} top-level blocks, expected >= ${expectAtLeast}`);
  }
  if (firstProbe && !texts.slice(0, 12).some(t => t.includes(firstProbe))) {
    problems.push(`neither the first blocks nor their nested content contain "${firstProbe.slice(0, 60)}"`);
  }
  if (lastProbe && !texts.slice(-12).some(t => t.includes(lastProbe))) {
    problems.push(`neither the last blocks nor their nested content contain "${lastProbe.slice(0, 60)}"`);
  }
  if (problems.length) throw new Error(`read-back failed for ${label}: ${problems.join('; ')}`);
  return scoped.length;
}
