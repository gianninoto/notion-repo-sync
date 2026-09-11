/**
 * Markdown → Notion block JSON.
 *
 * @tryfabric/martian does the conversion and was adopted by fixture, not
 * preference (tests/render.test.mjs holds the evidence): the
 * blockquote-with-fence and nested-fence shapes that were unrenderable on the
 * MCP path come out lossless here, and >2000-char text is split into legal
 * rich_text elements. Its one observed defect is wrapped, not tolerated:
 *
 *   - Thematic breaks (`---`) are silently dropped. Docs use them as section
 *     dividers, so the source is split on them and real divider blocks are
 *     interleaved.
 *
 * Depth: Notion rejects payloads nested deeper than two levels. Rather than
 * flatten (lossy), `needsSlowPath` tells the writer which top-level blocks
 * need the slow path — appended childless first, children recursed after.
 */
import { markdownToBlocks } from '@tryfabric/martian';

/* A thematic break: three-plus dashes, stars or underscores alone on a line.
 * Table delimiter rows start with `|` and never match. */
const HR = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;

/* A "prompt blockquote" is a `> **Prompt:**` block in the source that should
 * render as one flat CODE block rather than a quote: verbatim, with a
 * one-click copy button, because the page exists to be copied out of. The
 * generic markdown mapping (`>` → quote) is correct but loses that
 * affordance. So a prompt blockquote is pulled out before the rest of the
 * page goes through martian and rendered as a code block: its `>` markers
 * stripped, everything else — including a nested fence — kept as literal
 * text. The label line is configurable; `false` disables the behaviour. */
export const DEFAULT_PROMPT_QUOTE = /^>\s*\*\*Prompt:\*\*\s*$/;

const promptRe = opts =>
  opts?.promptQuote === false ? null : opts?.promptQuote ?? DEFAULT_PROMPT_QUOTE;

export function extractPromptBlocks(md, opts) {
  const re = promptRe(opts);
  const lines = md.split('\n');
  const segments = [];
  let buf = [];
  const flush = () => {
    if (buf.length) segments.push({ type: 'md', text: buf.join('\n') });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (!re || !re.test(lines[i])) {
      buf.push(lines[i]);
      continue;
    }
    flush();
    const quoted = [];
    while (i < lines.length && lines[i].startsWith('>')) {
      quoted.push(lines[i].replace(/^>\s?/, ''));
      i++;
    }
    i--; // the for-loop's own increment accounts for the line just past the quote
    quoted.shift(); // drop the label line itself
    if (quoted[0] === '') quoted.shift(); // drop the blank separator line
    segments.push({ type: 'prompt', text: quoted.join('\n').replace(/\n+$/, '') });
  }
  flush();
  return segments;
}

function renderMarkdownSegment(md) {
  const segments = [];
  let current = [];
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && HR.test(line)) {
      segments.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  segments.push(current.join('\n'));

  const out = [];
  segments.forEach((seg, i) => {
    if (i > 0) out.push({ object: 'block', type: 'divider', divider: {} });
    if (seg.trim()) out.push(...markdownToBlocks(seg));
  });
  return out;
}

export function renderMarkdown(md, opts) {
  const out = [];
  for (const seg of extractPromptBlocks(md, opts)) {
    if (seg.type === 'prompt') out.push(codeBlock(seg.text));
    else out.push(...renderMarkdownSegment(seg.text));
  }
  return out;
}

/* ---- composer helpers ---- */

export const paragraph = text => ({
  object: 'block',
  type: 'paragraph',
  paragraph: { rich_text: [{ type: 'text', text: { content: text.slice(0, 2000) } }] },
});

/* Splits, not truncates: a prompt regularly exceeds the 2000-char rich_text
 * limit, and the point of a copyable block is that it loses nothing. */
export const codeBlock = (text, language = 'plain text') => {
  const chunks = [];
  for (let i = 0; i < text.length || i === 0; i += 2000) chunks.push(text.slice(i, i + 2000));
  return {
    object: 'block',
    type: 'code',
    code: { rich_text: chunks.map(c => ({ type: 'text', text: { content: c } })), language },
  };
};

export const callout = (text, emoji = '⚙️') => ({
  object: 'block',
  type: 'callout',
  callout: {
    icon: { type: 'emoji', emoji },
    rich_text: [{ type: 'text', text: { content: text.slice(0, 2000) } }],
  },
});

/* ---- structure utilities the writer and read-back share ---- */

const childrenOf = block => block[block.type]?.children ?? [];

export function depthOf(block) {
  const kids = childrenOf(block);
  return kids.length ? 1 + Math.max(...kids.map(depthOf)) : 1;
}

/* Tables are exempt from the slow path: their rows are mandatory children and
 * the pair is exactly two levels, which the payload limit allows. */
export function needsSlowPath(block) {
  return block.type !== 'table' && depthOf(block) > 2;
}

export function stripChildren(block) {
  const { [block.type]: body, ...rest } = block;
  const { children, ...bodyRest } = body ?? {};
  return { block: { ...rest, [block.type]: bodyRest }, children: children ?? [] };
}

/* Plain text of a block's own rich_text — the read-back probe. A table_row's
 * cells join with a space: matches probesOf below, which strips a table's `|`
 * separators down to the single space either side collapses to. */
export function plainText(block) {
  const cellText = rt => rt.map(r => r.plain_text ?? r.text?.content ?? '').join('');
  if (block.type === 'table_row') return block.table_row.cells.map(cellText).join(' ');
  return cellText(block[block.type]?.rich_text ?? []);
}

/* First and last non-empty plain-text lines of a markdown chunk — the
 * read-back probes. Strips markdown decoration everywhere in the line, not
 * just leading: rendered plain text has no `*emphasis*`, `` `code` `` or table
 * `|` separators, so a probe that keeps any of those mid-line looks for text
 * that will never appear verbatim even though the write is correct.
 *
 * Prompt segments are the opposite case: their rendered text is a `code`
 * block, which shows `**`/backtick/`|` literally, so a probe landing inside a
 * prompt keeps them. Splitting on extractPromptBlocks before probing, mirroring
 * renderMarkdown, is what keeps the two from drifting apart. */
export function probesOf(md, opts) {
  const segments = extractPromptBlocks(md, opts);
  const linesOf = seg =>
    seg.text
      .split('\n')
      .map(l =>
        seg.type === 'prompt'
          ? l.trim()
          : l
              .replace(/^[#>\-\s]+/, '')
              .replace(/\*\*?|`|_|\|/g, '')
              .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
              .replace(/\s+/g, ' ')
              .trim(),
      )
      .filter(l => l.length > 8);
  const first = linesOf(segments[0] ?? { text: '', type: 'md' })[0];
  const lastSeg = segments.at(-1) ?? { text: '', type: 'md' };
  const last = linesOf(lastSeg).at(-1);
  return { first: first?.slice(0, 60), last: last?.slice(0, 60) };
}
