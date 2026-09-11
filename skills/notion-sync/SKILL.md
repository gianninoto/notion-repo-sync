---
name: notion-sync
description: Set up, extend, or debug notion-repo-sync in a project — the engine that mirrors a repo's markdown docs into Notion pages and databases on every push. Use when a project wants its planning docs (state, plan, log, changelog, runbook, decisions) readable in Notion without anyone maintaining Notion by hand, when adding a page or database to an existing sync, or when a sync run failed and needs diagnosing.
---

# notion-sync — a repo's docs, rendered in Notion, with nobody waiting

This skill installs and configures **notion-repo-sync**, a Node CLI that
mirrors markdown documents from a git repo into Notion. It is one-way, repo →
Notion, and it is meant to run in CI on every push, so "session end" is `git
push` and nothing more. The engine was extracted from the Manifest project,
where the same job had cost an LLM agent 16–21 minutes and 200–300k tokens per
run; as a script it is a 27-second no-op and a couple of minutes for a real
sync.

**The one rule the whole design follows:** *if it exists in the repo, Notion
renders it; if it does not exist in the repo, Notion does not have it.* Every
page is replaced wholesale, never merged, so there is nothing to reconcile and
no drift to detect. The exceptions are exactly two: a hand-written header on the
hub page (kept above a marker block), and the user-owned columns on a database
(declared `forbidden`, never written).

The files bundled with this skill:

- `templates/notion-sync.config.mjs` — the config to copy into the project
- `templates/notion-sync.yml` — the GitHub Actions workflow
- `reference/limits.md` — what Notion's API refuses and how the engine encodes it
- `reference/lessons.md` — the bugs that shaped the engine, so you do not re-learn them

Read `reference/lessons.md` before changing engine behaviour. Read
`reference/limits.md` before writing any new block-building code.

## When to use this skill

- A project wants its docs readable in Notion and nobody wants to maintain Notion.
- An existing sync needs a new page, a new database, or a new extractor.
- A CI sync run failed and the log needs interpreting.
- Someone is about to write a Notion sync by hand or through the Notion MCP.
  Stop them: the MCP has no non-interactive auth and its markdown converter is
  where every parser quirk in `reference/limits.md` came from.

## What the engine does (so you can explain it)

| Piece | What it does |
|---|---|
| **Diff gate** | Every source a page reads is fingerprinted with a git blob hash. A page is rewritten only if a hash moved. Hashes advance only for pages that succeeded, so a failed page retries next run on its own. |
| **Three strategies** | `replace` deletes the page body and re-renders it. `marker` does the same but only below a callout block the engine placed, so a hand-written header survives. `append` adds the new tail of an append-only document when the old extracted section is a strict prefix of the new one, and falls back to replace otherwise. |
| **Renderer** | Markdown → Notion block JSON via `@tryfabric/martian`, with the two things it gets wrong wrapped: dividers are re-inserted, and blocks nested deeper than Notion's two-level payload limit are written in a slow path rather than flattened. A `> **Prompt:**` blockquote renders as one copyable code block. |
| **Read-back** | After every write: block count, a probe of the first line, a probe of the last line, walking nested content but never into child pages. A failed read-back fails the page. |
| **Databases** | `reconcile` keeps a key set in step with rows the project derives from its docs (create missing, trash stale, never touch what it does not manage). `upsert` is an intake: create rows whose id is new, never edit or delete. Property payloads follow the data source's live schema. |
| **Safety** | Ids are resolved by walking one seeded hub page's children, never by workspace search. `child_page`/`child_database` blocks are never in a delete set. Forbidden columns throw at plan time. State files are scoped to the id file that produced them. |

## Procedure: adopting it in a project

Do these in order. Each step ends with something you can verify.

### 1. Preconditions the user has to do in Notion

The engine cannot create these; say so plainly and wait.

1. **An internal integration** at notion.so/my-integrations with read, update and
   insert content capabilities. Its token is `NOTION_TOKEN`.
2. **A hub page** in the workspace, shared with the integration (Share → invite
   the integration). Everything the sync owns lives directly under it.
3. **One child page per generated page**, created by hand under the hub, titled
   exactly as the config will say. The engine finds them by title under the hub
   and refuses to guess.
4. **For each database**: a child database under the hub with a title property
   and a `rich_text` property to stamp keys or ids into (`Key` for reconcile,
   or whatever `idProperty` names for upsert). User-owned columns (a triage
   status, a decision column) exist too and get declared `forbidden`.

### 2. Install

```bash
npm i -D github:gianninoto/notion-repo-sync#<commit-sha>
```

Pin to a commit; a moving branch in CI is not reproducible. Add scripts:

```json
"sync": "notion-repo-sync",
"sync:dry": "notion-repo-sync --dry-run",
"sync:check": "notion-repo-sync --check"
```

Put `NOTION_TOKEN=ntn_...` in a git-ignored `.env` at the project root for
local runs. Confirm `.env` is in `.gitignore` before writing it.

### 3. Author the config

Copy `templates/notion-sync.config.mjs` to the project root as
`notion-sync.config.mjs`. Then **walk the project's docs and propose a page
table** before writing it. For each document the user wants in Notion, decide:

- **`replace`** — the default. Any document that is edited in place.
- **`marker`** — the hub, or any page where a human writes a header above the
  generated part. There is normally exactly one.
- **`append`** — an append-only document (a log, a changelog) where the page
  should carry only the newest section plus a pointer to the repo for the rest.
  Needs `fileKey` and an `extract(text, ctx)` that returns the mirrored section
  from any version of the file. Set `pointer` to the sentence that tells a
  reader where the rest lives; the pointer is what keeps the cap honest.

Sources gate the page. A page that reads the whole file lists the path. A page
that reads a slice of a file lists a **virtual source** — `{ key:
'docs/x.md#slice', text: ctx => ... }` — so editing an unrelated part of that
file does not re-render it. Two pages generated from one file is worth nothing
if one changed hash re-renders both.

The context passed to every config function has `read(rel)`, `exists(rel)` and
the pure helpers from `lib/extract.mjs`: `splitAt`, `sectionNamed`,
`firstSections`, `newestWithChildren`, `partition`, `entriesWith`,
`headingText`, `blobHash`. A document shaped like none of these gets a function
in the config, not a fork of the engine.

For a database, `reconcile` wants `desired(ctx)` returning `[{ key, properties,
body }]` with every key starting with the stamp prefix (`gen:` by default) and
`managed` a regex over the families the engine may trash. `upsert` wants
`rows(ctx)` returning `[{ id, properties, body }]` and an `idProperty`. Declare
`forbidden` for every column a person owns; `onCreateOnly` is the one way a
forbidden column gets a value, once, at birth.

Present the proposed table to the user as a short list — page, strategy,
sources, one line each — and get a yes before running anything against Notion.

### 4. Resolve ids and place the marker

```bash
npx notion-repo-sync --init --hub <hub page url>
npx notion-repo-sync --init-marker
```

`--init` writes the id file (default `docs/.notion-ids.json`) with every id
scoped under the hub. It fails loudly for any child page it cannot find by
title; that is the user's step 1.3 to fix, not something to work around with a
search. `--init-marker` appends the boundary callout to the end of each
marker-strategy page and records its block id. **Tell the user to drag the
marker up to sit just below their hand-written header before the first sync.**
Everything below the marker will be deleted and regenerated.

### 5. First run

```bash
npx notion-repo-sync --dry-run      # the plan: every page, its action, why
npx notion-repo-sync full           # the write, with read-back per page
npx notion-repo-sync --check        # should now say: in step with the board
```

Read the `full` output line by line. Each page reports `N blocks written, M on
page`; a `✗` line names the page and the read-back problem. Then **open the hub
in Notion and look**: the header intact, the marker where it was dragged, the
generated text between the marker and the child-page links, every child page
still present. The read-back is a floor, not the whole review.

Commit the id file and the state file (`docs/.notion-ids.state.json` unless the
config names another path). The state file is what makes the next run cheap.

### 6. Wire CI

Copy `templates/notion-sync.yml` to `.github/workflows/notion-sync.yml`, set
the branch and paths, add `NOTION_TOKEN` as a repository secret. The template
already has the three things that matter: `fetch-depth: 0` (append decisions
read old content by blob hash), a non-cancelling concurrency group (a
cancelled run between delete and re-append leaves a blank page), and the
state-file commit with `[skip ci]`.

Push a docs change and read the Actions log once. Then it is done: session end
is `git push`.

## Adding a page or database later

Add the row to the config. Create the child page (or database) under the hub
by hand. Run `--init` again — it re-walks the hub and rewrites the id file,
keeping recorded markers. Dry-run, then `full --page <key>` for just the new
page. A new database needs its stamp or id property to exist first; the engine
names the missing property in its error.

## Debugging a failed run

Read the CI log; the engine says which page failed and why. The common ones:

| Log line | Meaning | Do |
|---|---|---|
| `no marker recorded` / `marker not found on the page` | The callout was deleted or the id file lost it. The engine will never guess a boundary on a marker page. | `--init-marker`, then drag it into place, then rerun. |
| `read-back failed … only N top-level blocks` | The write was cut short, or the page has fewer blocks than the render produced. | Rerun; the hash did not advance, so the page retries on its own. If it repeats, render the markdown locally and look for a block Notion refuses. |
| `read-back failed … neither the first blocks nor their nested content contain "…"` | The probe text is not on the page. Usually the write is fine and the probe is wrong — a new markdown shape whose plain text differs from the probe's stripping. | Compare `probesOf(md)` to `plainText` of the rendered block. Fix the probe rule, add the shape to `tests/render.test.mjs`, and only then trust the page. See `reference/lessons.md` → false positives. |
| `→ 400` on a database write | A property type or name changed in Notion, or a field name the API renamed. | Read the message; it names the field. |
| `no child page titled "…" directly under the hub` | Step 1.3 was skipped or the title differs. | Have the user create or rename it. Never fall back to search. |
| A blank page in Notion | A run crashed between delete and re-append. Accepted trade-off. | Rerun (or `workflow_dispatch`); the hash did not advance so exactly that page rebuilds. |

## Rules for what you learn along the way

- **A claim about Notion's behaviour carries its evidence.** One run observed it:
  PROVISIONAL, with what would confirm it. Two independent runs or a deliberate
  re-probe: CONFIRMED. A better-sourced observation supersedes a worse-sourced
  instruction the day it lands. A PROVISIONAL entry is never promoted by being
  re-read. Record new ones in `reference/limits.md` with the state named.
- **Every behaviour you rely on gets a regression test in `tests/`, observed
  failing once.** Neuter the rule, watch red, restore. An assertion written by
  reading the implementation is guaranteed green and asserts nothing.
- **Report what you ran and what you read back**, marked OBSERVED or INFERRED.
  Never report your own token count or wall clock; you cannot see either.
- **Never write the user's columns.** If a run needs a property added, ask the
  user to add it in Notion. Do not proceed as though it succeeded.
