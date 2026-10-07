# What the engine does — so you can explain it

| Piece | What it does |
|---|---|
| **Diff gate** | Every source a page reads is fingerprinted with a git blob hash. A page is rewritten only if a hash moved. Hashes advance only for pages that succeeded, so a failed page retries next run on its own. |
| **Three strategies** | `replace` deletes the page body and re-renders it. `marker` does the same but only below a callout block the engine placed, so a hand-written header survives. `append` adds the new tail of an append-only document when the old extracted section is a strict prefix of the new one, and falls back to replace otherwise. |
| **Renderer** | Markdown → Notion block JSON via `@tryfabric/martian`, with the two things it gets wrong wrapped: dividers are re-inserted, and blocks nested deeper than Notion's two-level payload limit are written in a slow path rather than flattened. A `> **Prompt:**` blockquote renders as one copyable code block. |
| **Read-back** | After every write: block count, a probe of the first line, a probe of the last line, walking nested content but never into child pages. A failed read-back fails the page. |
| **Databases** | `reconcile` keeps a key set in step with rows the project derives from its docs (create missing, trash stale, never touch what it does not manage). `upsert` is an intake: create rows whose id is new, never edit or delete. Property payloads follow the data source's live schema. |
| **Safety** | Ids are resolved by walking one seeded hub page's children, never by workspace search. `child_page`/`child_database` blocks are never in a delete set. Forbidden columns throw at plan time. State files are scoped to the id file that produced them. |

| **Stamp** (opt-in) | `stamp: true` or `{ timeZone, label }` in the config: every page opens with when its source files last changed (newest commit, never the run time). Pages read a `notion-render` key; bumping the render version rewrites every page once. |
| **Calibration** | A database whose rows come from a live read declares `calibrate: { canary, expect }`: a known row must be present and each expected group non-empty, or the run throws and writes nothing. |
| **Forced runs** | `--force` off the configured branch writes pages but records no state; CI re-syncs them from the branch. |
