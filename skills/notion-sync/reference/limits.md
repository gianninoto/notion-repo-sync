# What Notion's API refuses, and how the engine encodes it

Every entry carries an evidence state. **PROVISIONAL**: one run observed it;
recorded so it is not lost, and it is not an instruction — say what would
confirm it. **CONFIRMED**: two independent runs, or one run plus a deliberate
re-probe. **SUPERSEDED**: a better answer was observed; kept, struck, with what
replaced it. A better-sourced observation supersedes a worse-sourced
instruction the day it lands. A PROVISIONAL entry is never promoted by being
re-read.

## REST API limits the engine encodes (CONFIRMED)

Verified 2026-08-18 against `Notion-Version: 2026-03-11` from
developers.notion.com and live runs; each is a line of `lib/api.mjs` or
`lib/render.mjs`.

| Limit | Where enforced |
|---|---|
| ~3 requests/second average per integration | `throttle()` — one token bucket, 360ms spacing |
| 429 and 529 carry `Retry-After` | `notionFetch()` honours it; backoff otherwise 500ms × 2ⁿ, capped 30s, 6 attempts |
| 5xx is retried only on idempotent methods (GET, DELETE) | `IDEMPOTENT` set; a failed POST/PATCH throws |
| ≤100 blocks per children append | `appendChunked()` |
| ≤500KB per payload | 450KB guard in `appendChunked()` halves the chunk |
| rich_text content ≤2000 chars per element | `codeBlock()`/`paragraph()` split; martian splits prose |
| Payloads nested deeper than two levels are rejected | `needsSlowPath()` → append childless, recurse (`writeBlocks`) |
| `child_page` / `child_database` blocks **are** the page or database | `computeDoomed()` never returns one; `flattenBlocks()` never descends into one |
| Trashing a page is `in_trash: true`, not `archived` (renamed 2025-09) | `lib/database.mjs` reconcile; observed as a live 400 naming the field |
| A database's rows live in a data source; query `/data_sources/{id}/query`, create with `parent: { data_source_id }` | `--init` resolves database → first data source |
| Positional append: `position: { type: 'after_block', after_block: { id } }` | `appendChunked()`; later chunks chain after the last created block |

## Renderer facts (CONFIRMED by fixture, `tests/render.test.mjs`)

- `@tryfabric/martian` silently drops thematic breaks (`---`). The engine splits
  on them outside fences and interleaves real `divider` blocks.
- A blockquote containing a fenced block renders lossless as a quote with a
  code child. A four-backtick fence keeps inner fences as literal text.
- A GFM table renders as `table` with `table_row` children; that pair is
  exactly two levels and exempt from the slow path.
- A rendered `table_row`'s plain text joins cells with a space; the read-back
  probe strips `|` to match. Both were observed wrong once (a same-day false
  negative each way).

## Observed 2026-10-10 (claude-ops' first sync; Manifest's session, asked read-only)

- CONFIRMED · a soft wrap in the source (a newline inside a paragraph) reached
  Notion as a line break mid-sentence. The renderer now joins them in every
  block but code (`joinSoftWraps`, tests in `render.test.mjs`); a full run
  re-renders pages written before it.
- PROVISIONAL · a markdown hard break (two trailing spaces, or a backslash)
  renders as two text runs with no break between them — the words run
  together. Seen in a local render only, not on a page.
- CONFIRMED · a GFM table row whose cell holds a bare `|` (even inside
  backticks) is wider than its table, and Notion refuses the whole page:
  "Number of cells in table row must match the table width". `\|` renders
  correctly. A project's docs check should fail ragged tables.
- PROVISIONAL (Manifest, log 2026-09-12, one run) · a POST under a trashed
  parent is refused: "Can't edit block that is archived".
- PROVISIONAL (Manifest, INFERRED there) · a select value with no matching
  option creates a new option, so an unmapped raw id becomes a board option.
- PROVISIONAL (Manifest) · the stamp regex takes the first `gen:` match in the
  stamp column, so prose in that column after the key is ignored, not
  rejected. Undocumented until now.

## Historical: the Notion MCP's markdown converter

These were measured 2026-08-15 to 2026-08-17 against the **MCP** path, which
the old agent-driven sync used. The REST path sends structured block JSON and
does not have this bug class. Kept as record, and as a warning to anyone about
to build a sync on the MCP.

- CONFIRMED · a standalone `+` is rewritten to `•`.
- CONFIRMED · an unlabelled fence is re-tagged as `javascript`.
- CONFIRMED · a nested fence cannot be rendered: a four-backtick outer fence
  silently swallows content; `~~~` is escaped to literal text. The workaround
  was three sibling blocks. *(Superseded on the REST path: lossless.)*
- PROVISIONAL · an `update_content` anchor that is a substring of a longer run
  matches inside it, garbles the page and reports success.
- CONFIRMED · inline code nested inside bold comes back with stray markers.
- CONFIRMED · `update-data-source` is often denied by the permission classifier.
- CONFIRMED · a database row cannot be archived through the MCP, only deleted.
- PROVISIONAL · batch `create-pages` in groups of ~4 or fewer.
- CONFIRMED · long documents need splitting by top-level heading.
- CONFIRMED · `<details><summary>` wrapping a fenced block renders correctly.
