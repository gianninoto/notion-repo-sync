---
name: notion-sync
description: Set up, extend, or debug notion-repo-sync in a project — the engine that mirrors a repo's markdown docs into Notion pages and databases on every push. Use when a project wants its planning docs (state, plan, log, changelog, runbook, decisions) readable in Notion without anyone maintaining Notion by hand, when adding a page or database to an existing sync, or when a sync run failed and needs diagnosing.
---

# notion-sync — a repo's docs, rendered in Notion, with nobody waiting

**notion-repo-sync** mirrors markdown documents from a git repo into Notion,
one way, repo → Notion, in CI on every push — so "session end" is `git push`.
Extracted from the Manifest project, where the same job cost an LLM agent
16–21 minutes per run; as a script it is a 27-second no-op and a couple of
minutes for a real sync.

**The one rule:** *if it exists in the repo, Notion renders it; if not, Notion
does not have it.* Pages are replaced wholesale, never merged. Two exceptions:
a hand-written header on the hub page (kept above a marker block), and the
person-owned columns on a database (declared `forbidden`, never written).

Bundled: `templates/notion-sync.config.mjs` (the config), `templates/notion-sync.yml`
(the workflow — one step, the action), `reference/engine.md` (what each piece
does), `reference/limits.md` (what Notion's API refuses — read before writing
block-building code), `reference/lessons.md` (the bugs that shaped the engine —
read before changing engine behaviour).

## When to use this skill

- A project wants its docs readable in Notion and nobody wants to maintain Notion.
- An existing sync needs a new page, database or extractor.
- A CI sync run failed and the log needs interpreting.
- Someone is about to write a Notion sync by hand or through the Notion MCP.
  Stop them: the MCP has no non-interactive auth, and its converter is where
  every quirk in `reference/limits.md` came from.

## Adopting it — in order, each step ends with something you can verify

1. **The person does, in Notion** (the engine cannot; say so and wait): an
   internal integration with read, update and insert (its token is
   `NOTION_TOKEN`); a hub page shared with it; one child page per generated
   page, titled exactly as the config will say; for each database, a child
   database with a title and a `rich_text` key property, and the person-owned
   columns that will be `forbidden`.
2. **Install, pinned to a commit:** `npm i -D github:gianninoto/notion-repo-sync#<commit-sha>`.
   For local runs the person puts the token in a git-ignored `.env` — they run
   that, you never see or print the token; check `.gitignore` first.
3. **Author the config.** Copy the template to `notion-sync.config.mjs`, walk
   the project's docs and propose a page table — page, strategy (`replace` by
   default, `marker` for the hub, `append` for a log), sources, one line each —
   and get a yes before anything touches Notion. A slice of a file is a
   virtual source `{ key: 'docs/x.md#slice', text: ctx => … }`, so an edit
   elsewhere in the file does not re-render it. Config functions receive
   `read`, `exists`, `today`, `ageOf` and the helpers in `lib/extract.mjs`;
   a document shaped like none of them gets a function, not a fork. Turn on
   `stamp`. A database fed by a live read declares `calibrate`.
4. **Resolve ids:** `npx notion-repo-sync --init --hub <hub url>`, then
   `--init-marker`, and tell the person to drag the marker just below their
   header — everything below it is regenerated.
5. **First run:** `--dry-run` (the plan), `full` (the write, read back per
   page), `--check` (should say in step). Then open the hub and look; the
   read-back is a floor, not the review. Commit the id file and the state file.
6. **Wire CI:** copy `templates/notion-sync.yml` to `.github/workflows/`, set
   the branch, the paths and the state file, pin the action to a commit:

   ```yaml
   - uses: gianninoto/notion-repo-sync@<commit-sha>
     with:
       token: ${{ secrets.NOTION_TOKEN }}
   ```

   The person adds the `NOTION_TOKEN` repository secret (`gh secret set
   NOTION_TOKEN` — theirs to run); verify by name with `gh secret list`. The
   action does the rest: a scheduled run is `full`, and the state file is
   committed onto the branch tip. Push a docs change and read the run once.

## Adding a page or database later

Add the row to the config, create the page or database under the hub by hand,
rerun `--init` (it keeps recorded markers), dry-run, then `full --page <key>`.

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
