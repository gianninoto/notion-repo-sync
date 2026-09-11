#!/usr/bin/env node
/**
 * Creates the page tree fixtures/sample-project expects, under a parent page
 * the integration can already see. Prints the hub url for --init --hub.
 *
 *   NOTION_TOKEN=... node fixtures/create-scratch-tree.mjs --parent <page id or url>
 *
 * Everything it creates is a child of the parent; trash the hub to remove it
 * all. The database creation uses the data-source shape of Notion-Version
 * 2026-03-11 (`initial_data_source.properties`).
 */
import { notionFetch, readToken } from '../lib/api.mjs';
import { paragraph } from '../lib/render.mjs';

const args = process.argv.slice(2);
const parentArg = args[args.indexOf('--parent') + 1];
if (!parentArg || args.indexOf('--parent') === -1) {
  console.error('usage: create-scratch-tree.mjs --parent <page id or url>');
  process.exit(2);
}
const parentId = String(parentArg).replace(/-/g, '').match(/[0-9a-f]{32}/i)?.[0];
if (!parentId) {
  console.error('could not find a 32-hex page id in --parent');
  process.exit(2);
}
const token = readToken();
const title = t => [{ type: 'text', text: { content: t } }];

const hub = await notionFetch('/pages', {
  method: 'POST',
  token,
  body: {
    parent: { type: 'page_id', page_id: parentId },
    properties: { title: { title: title('Sample — Hub') } },
    children: [
      {
        object: 'block',
        type: 'heading_1',
        heading_1: { rich_text: title('Sample project') },
      },
      paragraph('This header is hand-written and must survive every sync. The marker goes below it.'),
    ],
  },
});
console.log(`hub      ${hub.id}  ${hub.url}`);

for (const t of ['Plan', 'Runbook', 'Log']) {
  const p = await notionFetch('/pages', {
    method: 'POST',
    token,
    body: { parent: { type: 'page_id', page_id: hub.id }, properties: { title: { title: title(t) } } },
  });
  console.log(`${t.padEnd(8)} ${p.id}`);
}

const db = await notionFetch('/databases', {
  method: 'POST',
  token,
  body: {
    parent: { type: 'page_id', page_id: hub.id },
    title: title('Roadmap'),
    initial_data_source: {
      properties: {
        Item: { title: {} },
        Key: { rich_text: {} },
        Stage: { select: { options: [{ name: 'Backlog' }, { name: 'Building' }, { name: 'Shipped' }] } },
        'Owner call': { select: { options: [{ name: 'Yes' }, { name: 'No' }] } },
      },
    },
  },
});
console.log(`Roadmap  ${db.id}  data source ${db.data_sources?.[0]?.id ?? '(none reported)'}`);
console.log(`\nnext: cd fixtures/sample-project && notion-repo-sync --init --hub ${hub.id}`);
