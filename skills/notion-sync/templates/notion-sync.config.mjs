/**
 * notion-sync.config.mjs — which repo documents render as which Notion pages.
 *
 * Copy to the project root and edit. Everything is relative to `root`
 * (default: this file's directory). Functions receive a context with
 * `read(rel)`, `exists(rel)` and the pure helpers from notion-repo-sync's
 * lib/extract.mjs: splitAt, sectionNamed, firstSections, newestWithChildren,
 * partition, entriesWith, headingText, blobHash.
 */
export default {
  /* Where ids and state live. Both are committed. The state file defaults to
   * `<ids>.state.json` next to the id file; name it only if you must, and know
   * that an --ids override re-derives it regardless (a test tree must never
   * share state with production). */
  ids: 'docs/.notion-ids.json',

  /* The branch the docs live on. The sync refuses to run from any other
   * (--force overrides). null disables the guard. */
  branch: 'main',

  /* The page whose id is seeded by hand (--init --hub <url>) and whose child
   * pages/databases everything else is resolved from. Defaults to the marker
   * page. */
  hub: 'hq',

  /* The boundary callout on marker pages. `match` is the substring --init-marker
   * looks for to recognise an existing one. */
  marker: {
    text: 'Everything below this line is generated from the repo by notion-repo-sync. Edit the repo, not this page.',
    match: 'generated from the repo',
  },

  /* Optional: the blockquote label that renders as one copyable code block.
   * Default /^>\s*\*\*Prompt:\*\*\s*$/. Set false to disable. */
  // promptQuote: /^>\s*\*\*Prompt:\*\*\s*$/,

  /* Optional: whole files to fingerprint in the state file even though no page
   * reads them whole (audit only; --check reports them). */
  track: [],

  pages: [
    /* marker: a hand-written header above, generated text below the callout. */
    {
      key: 'hq',
      title: 'Project — HQ',
      strategy: 'marker',
      sources: ['docs/STATE.md'],
      md: ({ read, sectionNamed }) => {
        const s = read('docs/STATE.md');
        return ['# Now', sectionNamed(s, 2, 'Right now'), '# Blocked', sectionNamed(s, 2, 'Blocked')].join('\n\n');
      },
    },

    /* replace, whole file: the simplest page. */
    { key: 'plan', title: 'Plan', strategy: 'replace', sources: ['docs/PLAN.md'] },

    /* replace, a slice of a file: the virtual source gates on the slice, so an
     * edit elsewhere in the file does not re-render this page. */
    {
      key: 'runbook',
      title: 'Runbook',
      strategy: 'replace',
      sources: [{ key: 'docs/runbook.md#active', text: ({ read, partition }) => partition(read('docs/runbook.md'), h => h.includes('DONE')).active }],
      md: ({ read, partition }) => partition(read('docs/runbook.md'), h => h.includes('DONE')).active,
    },

    /* append: an append-only document capped to its newest section. `extract`
     * must work on any version of the file (it is run on the old blob too);
     * the pointer tells a reader where the rest lives. */
    {
      key: 'log',
      title: 'Log',
      strategy: 'append',
      sources: ['docs/log.md'],
      fileKey: 'docs/log.md',
      extract: (text, { newestWithChildren }) => newestWithChildren(text),
      pointer: 'Earlier entries: `docs/log.md` in the repo — this page mirrors the newest section only.',
    },

    /* replace, newest N sections of a changelog. */
    {
      key: 'changelog',
      title: 'Changelog',
      strategy: 'replace',
      sources: ['CHANGELOG.md'],
      md: ({ read, firstSections }) => firstSections(read('CHANGELOG.md'), 2, 5),
      pointer: 'Older releases: `CHANGELOG.md` in the repo — this page mirrors the newest five.',
    },
  ],

  databases: [
    /* reconcile: one row per thing the docs declare. Keys are stamped into
     * `stampProperty`; rows whose key matches `managed` and is no longer
     * desired are trashed (reversible for 30 days). Rows with other stamps, or
     * none, are never touched. Runs on every sync. */
    {
      key: 'roadmap',
      title: 'Roadmap',
      mode: 'reconcile',
      stampProperty: 'Key',
      managed: /^gen:phase-/,
      forbidden: ['Owner call'],
      desired: ({ read, splitAt, headingText }) =>
        splitAt(read('docs/PLAN.md'), 2)
          .filter(s => /^## Phase \d/.test(s.heading))
          .map(s => ({
            key: `gen:phase-${s.heading.match(/Phase (\d+)/)[1]}`,
            properties: { title: headingText(s.heading), Stage: /done/i.test(s.heading) ? 'Shipped' : 'Backlog' },
            body: [headingText(s.heading)],
          })),
    },

    /* upsert: an intake from somewhere else (an API, a JSON file). Creates rows
     * whose id is new; never edits or deletes. `when: 'command'` keeps it off
     * the every-push sync — run it as `notion-repo-sync feedback`. */
    // {
    //   key: 'feedback',
    //   title: 'Feedback',
    //   mode: 'upsert',
    //   idProperty: 'Feedback ID',
    //   forbidden: ['Status'],
    //   onCreateOnly: { Status: 'New' },
    //   when: 'command',
    //   rows: async () => (await fetchReports()).map(r => ({ id: r.id, properties: { title: r.summary, Kind: r.kind }, body: r.text.split('\n') })),
    // },
  ],
};
