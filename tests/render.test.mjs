/**
 * The renderer's golden fixtures — the evidence that decided martian over a
 * hand-rolled converter (2026-08-18), kept as regression tests.
 *
 * Every case here is a shape that broke, or could not exist, on the MCP path:
 * the blockquote-with-fence (every runbook prompt), the nested fence (Session
 * 1's prompt, previously three sibling blocks with an apology), the divider
 * martian drops silently, and the 2000-char rich_text cap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderMarkdown, paragraph, callout, codeBlock, extractPromptBlocks,
  depthOf, needsSlowPath, stripChildren, plainText, probesOf,
} from '../lib/render.mjs';

test('a blockquote containing a fenced block renders as quote with a code child', () => {
  // Not a "**Prompt:**" blockquote deliberately — those take the code-block
  // path now (see "a session prompt renders as one copyable code block"
  // below). This covers any other blockquote-with-fence in the docs.
  const md = '> **Note:**\n>\n> Read the plan.\n>\n> ```\n> npm run verify\n> ```';
  const blocks = renderMarkdown(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'quote');
  const kids = blocks[0].quote.children;
  assert.ok(kids.some(b => b.type === 'code'), 'code block survives inside the quote');
  const code = kids.find(b => b.type === 'code');
  assert.match(plainText(code), /npm run verify/);
});

test('a four-backtick fence keeps inner fences as literal text — lossless', () => {
  const blocks = renderMarkdown('````\nOuter\n```js\nconst x = 1;\n```\nAfter\n````');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'code');
  const text = plainText(blocks[0]);
  assert.match(text, /```js/, 'inner fence markers preserved');
  assert.match(text, /const x = 1;/);
});

test('a thematic break becomes a divider block, not nothing', () => {
  const blocks = renderMarkdown('above\n\n---\n\nbelow');
  assert.deepEqual(blocks.map(b => b.type), ['paragraph', 'divider', 'paragraph']);
});

test('a --- inside a fence is code, not a divider', () => {
  const blocks = renderMarkdown('```\n---\n```');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'code');
  assert.equal(plainText(blocks[0]), '---');
});

test('code and prose longer than 2000 chars split into legal rich_text elements', () => {
  const code = renderMarkdown('```\n' + 'x'.repeat(4500) + '\n```');
  const lengths = code[0].code.rich_text.map(r => r.text.content.length);
  assert.ok(lengths.every(n => n <= 2000), `all elements <=2000, got ${lengths}`);
  assert.equal(lengths.reduce((a, b) => a + b, 0), 4500, 'nothing trimmed');
});

test('a GFM table renders as a table with a column header', () => {
  const [table] = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.equal(table.type, 'table');
  assert.equal(table.table.has_column_header, true);
  assert.equal(table.table.children.length, 2);
});

test('depth accounting: tables are exempt, deep lists take the slow path', () => {
  const [table] = renderMarkdown('| a |\n|---|\n| 1 |');
  assert.equal(needsSlowPath(table), false, 'table+rows is two levels and legal');

  const [list] = renderMarkdown('- one\n  - two\n    - three');
  assert.equal(depthOf(list), 3);
  assert.equal(needsSlowPath(list), true);

  const { block, children } = stripChildren(list);
  assert.equal(block[block.type].children, undefined, 'stripped block is childless');
  assert.equal(children.length, 1, 'subtree preserved for the recursive append');
});

test('a probe from a table row matches the row after it renders — no leftover pipe', () => {
  // The real PLAN.md row that produced this bug 2026-08-18: the probe kept a
  // mid-line `|` (only the leading one was stripped), but a rendered
  // table_row joins its cells with nothing, so the two could never match. A
  // lone row with no header/delimiter isn't valid GFM (martian renders it as
  // a paragraph, not a table), so the fixture needs a real header above it.
  const md = '| Doc | What |\n|---|---|\n| `archive/` | **History.** Reasoning preserved; superseded for planning. |';
  const { last } = probesOf(md);
  const table = renderMarkdown(md).find(b => b.type === 'table');
  const lastRow = table.table.children.at(-1);
  assert.equal(last.includes('|'), false, 'probe must not keep a mid-line pipe');
  assert.ok(
    plainText(lastRow).includes(last),
    `rendered row should contain the probe; row was "${plainText(lastRow)}"`,
  );
});

test('a probe with mid-line emphasis matches the rendered plain text', () => {
  // "steps 1–5 of 7 done" was wrapped in single asterisks mid-sentence; only
  // a leading strip was applied before, so the asterisks survived into the
  // probe and could never match Notion's markup-free plain text.
  const md = 'Phase 4 — The rebuild · *steps 1–5 of 7 done* · started 2026-08-15';
  const { first } = probesOf(md);
  assert.equal(first.includes('*'), false);
  const rendered = plainText(renderMarkdown(md)[0]);
  assert.ok(rendered.includes(first), `rendered text should contain the probe; got "${rendered}"`);
});

test('a session prompt renders as one copyable code block, not a quote', () => {
  // Justin's ask, 2026-08-19: the pre-script sync rendered prompts as code
  // blocks (one-click copy); the generic renderer maps `>` to `quote`, losing
  // that affordance. Session 1's real prompt has a fence nested inside the
  // blockquote — the exact shape that has to survive as literal text.
  const md = [
    '## Session 1',
    '',
    '> **Prompt:**',
    '>',
    '> Read `docs/STATE.md` and `docs/PLAN.md` Phase 2.',
    '>',
    '> Here is the Vietnam JSON:',
    '> ```',
    '> [paste]',
    '> ```',
    '',
    '**Done when:** the switcher moves.',
  ].join('\n');
  const blocks = renderMarkdown(md);
  const code = blocks.find(b => b.type === 'code');
  assert.ok(code, 'a code block exists');
  const text = plainText(code);
  assert.match(text, /Read `docs\/STATE\.md`/);
  assert.match(text, /```\n\[paste\]\n```/, 'the nested fence survives as literal text');
  assert.equal(blocks.some(b => b.type === 'quote'), false, 'no quote block for the prompt');
  // surrounding content still renders normally, in order
  assert.equal(blocks[0].type, 'heading_2');
  assert.ok(blocks.some(b => b.type === 'paragraph' && plainText(b).includes('Done when')));
});

test('a probe landing inside a prompt matches the literal code-block text', () => {
  // A prompt's rendered text is a code block: `**bold**` shows literally, it
  // is not interpreted. A probe stripped as if it were markdown (the md-
  // segment rule) would ask for text with no asterisks, which the literal
  // code block will never contain.
  const md = [
    '### Session X',
    '',
    '> **Prompt:**',
    '>',
    '> Read the plan. **A finding that needs a decision is a question.**',
  ].join('\n');
  const { last } = probesOf(md);
  const blocks = renderMarkdown(md);
  const code = blocks.find(b => b.type === 'code');
  assert.ok(last.includes('**'), 'probe keeps the literal asterisks for a prompt segment');
  assert.ok(plainText(code).includes(last), `code block should contain the probe; got "${plainText(code)}"`);
});

test('extractPromptBlocks strips the label line and the blank separator', () => {
  const md = '> **Prompt:**\n>\n> the actual text\n> second line';
  const [seg] = extractPromptBlocks(md);
  assert.equal(seg.type, 'prompt');
  assert.equal(seg.text, 'the actual text\nsecond line');
});

test('a prompt over 2000 chars splits into multiple rich_text elements, not truncated', () => {
  const long = 'x'.repeat(4500);
  const block = codeBlock(long);
  const lengths = block.code.rich_text.map(r => r.text.content.length);
  assert.ok(lengths.every(n => n <= 2000));
  assert.equal(lengths.reduce((a, b) => a + b, 0), 4500);
});

test('composer helpers emit legal blocks', () => {
  const p = paragraph('hello');
  assert.equal(p.type, 'paragraph');
  const c = callout('generated below this line');
  assert.equal(c.type, 'callout');
  assert.equal(c.callout.icon.emoji, '⚙️');
});

/* Source markdown is hard-wrapped; GitHub joins a paragraph's lines with a
 * space, Notion showed every wrap as a line break (claude-ops hub and Manifest
 * HQ, 2026-10-10). Code keeps its newlines. */
test('a soft-wrapped paragraph renders as one line, as GitHub shows it', () => {
  const [b] = renderMarkdown('one line\nnext line');
  assert.equal(b.paragraph.rich_text.map(t => t.text.content).join(''), 'one line next line');
});

test('soft wraps join in list items, quotes and table cells too', () => {
  const [li] = renderMarkdown('- item one\n  continues');
  assert.equal(li.bulleted_list_item.rich_text.map(t => t.text.content).join(''), 'item one continues');
  const [q] = renderMarkdown('> quoted\n> on two lines');
  assert.ok(!JSON.stringify(q).includes('\\n'), JSON.stringify(q));
});

test('a code block keeps its newlines', () => {
  const [c] = renderMarkdown('```\na\nb\n```');
  assert.equal(c.code.rich_text.map(t => t.text.content).join(''), 'a\nb');
});
