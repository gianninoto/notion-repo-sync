# notion-repo-sync

Mirror a repo's markdown documents into Notion pages and databases. One way,
repo → Notion, run by CI on every push. Diff-driven, replace-not-merge, read
back after every write.

It is an **npm package** (the engine and a CLI), a **GitHub Action** (`uses:
gianninoto/notion-repo-sync@<commit-sha>` — the whole CI half in one step), and
a **Claude Code plugin** (a skill that sets it up in a project, writes the
config, and knows what Notion's API refuses).

Extracted from the [Manifest](https://github.com/gianninoto/manifest) project,
where it replaced an LLM-driven sync that cost 16–21 minutes and 200–300k
tokens a run. As a script it is a 27-second no-op and a couple of minutes for a
real sync.

## The rule

> If it exists in the repo, Notion renders it. If it does not exist in the
> repo, Notion does not have it.

Every page is replaced wholesale, so there is nothing to reconcile. Two
exceptions: a hand-written header on the hub page, kept above a marker block;
and the user-owned columns on a database, declared `forbidden` and never
written.

## Install

```bash
npm i -D github:gianninoto/notion-repo-sync#<commit-sha>
```

As a Claude Code plugin:

```
/plugin marketplace add gianninoto/notion-repo-sync
/plugin install notion-repo-sync@notion-repo-sync
/notion-repo-sync:notion-sync
```

Or, to try the skill from a local checkout: `claude --plugin-dir ./notion-repo-sync`.

## Quick start

1. In Notion: create an internal integration, a hub page shared with it, one
   child page per generated page (titled as your config will say), and any
   databases with a `rich_text` property to stamp keys into.
2. Copy `skills/notion-sync/templates/notion-sync.config.mjs` to your project
   root and edit the page table.
3. `NOTION_TOKEN=ntn_...` in a git-ignored `.env`.
4. ```bash
   npx notion-repo-sync --init --hub <hub page url>
   npx notion-repo-sync --init-marker      # then drag the callout below your header
   npx notion-repo-sync --dry-run
   npx notion-repo-sync full
   npx notion-repo-sync --check            # ✓ in step with the board
   ```
5. Copy `skills/notion-sync/templates/notion-sync.yml` to
   `.github/workflows/`, pin the action to a commit, add the `NOTION_TOKEN`
   secret, commit the id and state files. The action runs `full` every Friday
   and replays the state file onto the branch tip, three attempts, never a
   rebase. Session end is `git push`.

The skill walks through all of this, including proposing the page table from
your docs.

## CLI

```
notion-repo-sync [sync|full|<database-key>] [flags]

  sync              (default) diff-gated pages + every database whose `when` is not 'command'
  full              ignore recorded state, rewrite every page
  <database-key>    run one database only (an intake)

  --dry-run         print the plan, write nothing
  --check           which sources changed since the recorded state (no network)
  --page <key>      restrict to one page
  --init            resolve ids under the hub, write the id file
  --hub <id|url>    seed the hub id for --init
  --init-marker     place the boundary callout on marker pages
  --config <path>   config file (default ./notion-sync.config.mjs)
  --ids <path>      alternate id file (a test tree); state is re-derived
  --force           skip the branch guard
```

## Config

`notion-sync.config.mjs` exports an object:

| Field | |
|---|---|
| `root` | project root; default: the config's directory |
| `ids` | id file path, written by `--init`; default `docs/.notion-ids.json` |
| `state` | state file path or `idsPath => path`; default `<ids>.state.json`. Ignored when `--ids` overrides, on purpose |
| `branch` | the branch the docs live on; `null` disables the guard |
| `hub` | key of the seeded page everything is resolved under; default: the marker page |
| `marker` | `{ text, match }` for the boundary callout |
| `promptQuote` | regex for the blockquote label that renders as a copyable code block; default `> **Prompt:**`; `false` disables |
| `track` | files to fingerprint without gating any page |
| `pages[]` | `{ key, title, strategy, sources, md?, fileKey?, extract?, pointer? }` |
| `databases[]` | `{ key, title, mode, forbidden?, when?, ... }` |

**Strategies.** `replace` rewrites the page body. `marker` rewrites only below
the callout. `append` adds the new tail of an append-only document when the old
extracted section is a strict prefix of the new one, else replaces; needs
`fileKey` and `extract(text, ctx)`.

**Sources.** A string is a file, hashed whole. `{ key: 'docs/x.md#slice', text:
ctx => ... }` is a virtual source, hashed as the extracted text, so an edit
elsewhere in the file does not re-render the page.

**`md`.** A string, a function of the context, or omitted: a single-file
`replace` page reads the file; an `append` page uses `extract(read(fileKey))`.
`pointer` is appended to `md` and re-placed after every append.

**Context.** `read(rel)`, `exists(rel)`, and the pure helpers: `splitAt`,
`sectionNamed`, `firstSections`, `newestWithChildren`, `partition`,
`entriesWith`, `headingText`, `blobHash`.

**Databases.** `mode: 'reconcile'` with `desired(ctx) → [{ key, properties,
body }]`, `stampProperty` (default `Key`), `stampPrefix` (default `gen:`),
`managed` (regex of key families the engine may trash), `trashStale`. `mode:
'upsert'` with `rows(ctx) → [{ id, properties, body }]` and `idProperty`.
Both: `forbidden` (columns the engine must never write; a provider naming one
throws at plan time), `onCreateOnly` (values written once at birth), `when:
'command'` (off the every-push sync).

## Proving it against real Notion

`fixtures/sample-project/` exercises every strategy. Create a page "Sample —
Hub" shared with your integration, with child pages "Plan", "Runbook", "Log"
and a database "Roadmap" (title property, `Key` rich_text, `Stage` status or
select, `Owner call` select). Then:

```bash
cd fixtures/sample-project
NOTION_TOKEN=... npx notion-repo-sync --init --hub <url> && npx notion-repo-sync --init-marker
npx notion-repo-sync full
```

Then edit `docs/log.md` by adding a `###` under the last phase and run `sync`:
the Log page should report `append`. Edit an existing line and run again: it
should report `replace`.

## Development

```bash
npm test                 # 65 assertions, node:test, no network (some use git in a temp folder)
npm run fixture:dry      # plan the fixture project
```

Every rule has a test that was observed failing with the rule neutered. Keep it
that way: neuter, watch red, restore. Read
`skills/notion-sync/reference/lessons.md` before changing engine behaviour and
`reference/limits.md` before building blocks by hand.

## License

MIT
