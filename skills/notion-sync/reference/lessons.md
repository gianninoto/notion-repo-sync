# The lessons the engine is built on

Read before changing engine behaviour. Each one cost a real run to learn.
Source: the Manifest project's `docs/log.md` (2026-08-18) and
`docs/operating-review.md`.

## Five bugs found before production was touched, none by trusting the tool's own report

1. **Global title search picked the wrong page.** `--init` searched the
   workspace by title and pointed a *test* config at the *real* production
   pages, because Notion's relevance ranking favoured them. Fix: the hub id is
   seeded by hand and never guessed; every other id is resolved by walking the
   hub's own `child_page`/`child_database` blocks, which the API scopes to that
   page's actual children. Now `--init --hub <url>`.
2. **The near-miss.** A `child_page`/`child_database` block *is* the page or
   database it names, not a reference to it. A hub's real nested children sit
   after the generated text as exactly these block types. A marker-based
   replace with no exception for them would have trashed the entire page tree
   on the first real sync. Caught by inspecting the block list before ever
   pointing the sync at production. `computeDoomed()` is that exception, and it
   has a test.
3. **Marker replace had no `afterBlockId`.** Fresh content landed after the
   structural children instead of between the marker and them.
4. **`archived` vs `in_trash`.** The API renamed the field; the old name is a
   hard 400.
5. **A test-tree run overwrote the production state file.** State paths are
   derived from the id file that produced them, so a test run can never share
   tracking state with a real one. The rule survives an `--ids` override even
   when the config names a state path explicitly.

## Two false positives in the verification itself

A check that cries wolf on correct writes is its own hazard: it trains the
reader to ignore red.

6. **The read-back recursed into unrelated nested pages.** Scoping the hub's
   check from the marker, it walked into the child pages that follow, pulled
   in hundreds of unrelated blocks, and pushed the hub's actual last line out
   of the probe window. Fix: never descend into `child_page`/`child_database`.
7. **A table row's rendered plain text did not match the probe.** Only the
   row's leading `|` was stripped; the rendered row had no pipes at all. Fix:
   strip decoration everywhere in the probe line, and join a rendered row's
   cells with a space to match.

All seven are regression tests, each observed failing against its pre-fix logic
before being trusted.

## Design decisions, and why

- **Fingerprints, not history.** The state file records a git blob hash per
  source, not a commit. A recorded commit is a position in one branch's
  history; a sync from a branch off `main` could not see a `dev` commit, fell
  back to a full rebuild by design, and cost triple. Blob hashes compare
  content and work across any branch split. `blobHash()` is byte-identical to
  `git hash-object` so file-backed and extracted-string sources share one
  scheme.
- **Replace, do not fetch to edit.** Every page is rewritten wholesale so there
  is nothing to reconcile. The hub's hand-written header is the one exception,
  and it is protected by a marker block, not by a diff.
- **Hash the slice, not the file.** Two pages generated from one file is worth
  nothing if one changed hash re-renders both. Virtual sources
  (`docs/x.md#slice`) fingerprint the extracted text.
- **Append iff strict prefix.** "Purely additive" is decided by comparison of
  the old and new extracted sections, never by reading a diff. Anything else
  replaces, which is always correct and merely costlier.
- **Hash each source at the moment you render it.** A sync once ran before the
  session finished editing and stated an unmerged build as shipped.
- **A cap needs a pointer.** An append-only page mirrors the newest section
  only, and ends with a sentence saying where the rest lives. Without it the
  cap reads as the whole.
- **One user-owned field per database is the entire two-way channel.** The
  repo is the source of truth; the person gets one column (`Status`, `Owner
  call`) the engine never writes, read at session start as a priority signal.
  "One field, not a board."
- **Hashes advance only on success.** A failed page keeps its old hash and
  retries on its own next run. Corollary, accepted: a crash between delete and
  re-append leaves a blank page until then. A blank page that self-heals beats
  a half-written page that reports success.
- **A fingerprint is only meaningful against another computed the same way.**
  The Manifest runbook's partition hash once moved without its content moving,
  because two runs had to pick a method and could not know each other's. The
  method is code now, and `partition()` keeps the original algorithm byte for
  byte.
- **Never publish an unanswered decision as settled.** A generated page that
  states a pending call as fact is worse than one a day stale, because it is
  read instead of asked about.

## Boards drift when "generated" means "generated once" (2026-10-10)

Reconcile created and trashed rows but never rewrote an existing one, so a
card's Stage and title were set at creation and frozen. Manifest's Roadmap was
documented as generated ("you do not drag them") and was 12 of 32 cards stale
(per Manifest's session, live query 2026-10-10). Now reconcile rewrites every
generated column that drifted, never a `forbidden` one, never the stamp or an
`onCreateOnly` value; `updateExisting: false` restores set-once. **A board
should say who owns each column after creation — generated every run, or a
person's — and the engine should make that true.**

## Two ways a sync silently does not run (Manifest, 2026-10-11)

- PROVISIONAL (Manifest, GitHub run history) · a commit that only moves the
  pin — `package.json` and the workflow file — triggers no run when the
  workflow's `paths:` filter lists only docs. The new engine first runs on
  the next docs push. Put `package.json` and the workflow file in `paths:`
  (the template now does).
- PROVISIONAL (Manifest, INFERRED there) · a commit whose message spells out
  the CI-skip marker — even to describe it — is skipped by Actions (and by
  Cloudflare), so its doc changes are not synced until a later push. Never
  write the marker literally in a commit message unless the skip is meant.

## What the old agent-driven skill cost, for scale

Seventeen measured runs: floor 7 minutes / 178k tokens to add zero rows;
typical 10–11 minutes / 220k; ceiling 242k. The script: 27 seconds for a no-op
CI run, a couple of minutes for a real one, zero tokens.
