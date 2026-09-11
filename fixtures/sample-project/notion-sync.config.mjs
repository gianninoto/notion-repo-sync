/**
 * A small project that exercises every strategy the engine has. Used by the
 * live fixture run (see README → "Proving it against real Notion") and by
 * `npm run fixture:dry`.
 *
 * The hub page "Sample — Hub" has a hand-written header, then the marker, then
 * generated text, then child pages titled exactly as below.
 */
export default {
  ids: 'docs/.notion-ids.json',
  branch: null, // no branch guard for a fixture
  hub: 'hub',
  pages: [
    {
      key: 'hub',
      title: 'Sample — Hub',
      strategy: 'marker',
      sources: ['docs/STATE.md'],
      md: ({ read, sectionNamed }) => {
        const state = read('docs/STATE.md');
        return ['# Now', sectionNamed(state, 2, 'Right now'), '# Blocked', sectionNamed(state, 2, 'Blocked')].join('\n\n');
      },
    },
    {
      key: 'plan',
      title: 'Plan',
      strategy: 'replace',
      sources: ['docs/PLAN.md'],
    },
    {
      key: 'runbook',
      title: 'Runbook',
      strategy: 'replace',
      sources: [{ key: 'docs/runbook.md#active', text: ({ read, partition }) => partition(read('docs/runbook.md'), h => h.includes('DONE')).active }],
      md: ({ read, partition }) => partition(read('docs/runbook.md'), h => h.includes('DONE')).active,
    },
    {
      key: 'log',
      title: 'Log',
      strategy: 'append',
      sources: ['docs/log.md'],
      fileKey: 'docs/log.md',
      extract: (text, { newestWithChildren }) => newestWithChildren(text),
      pointer: 'Earlier phases: `docs/log.md` in the repo — this page mirrors the newest phase only.',
    },
  ],
  databases: [
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
          .map(s => {
            const n = s.heading.match(/Phase (\d+)/)[1];
            return {
              key: `gen:phase-${n}`,
              properties: { title: headingText(s.heading).replace(/\s*·.*$/, ''), Stage: /done/i.test(s.heading) ? 'Shipped' : 'Backlog' },
              body: [headingText(s.heading)],
            };
          }),
    },
  ],
};
