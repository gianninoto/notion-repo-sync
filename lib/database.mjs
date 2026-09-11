/**
 * Database sync — the two mechanisms a repo-driven board needs, with the
 * policy (which rows, which columns) injected by the project's config.
 *
 *   reconcile  a key set. The project supplies the rows it wants to exist,
 *              each with a `key`; the engine stamps that key into a text
 *              property, creates missing rows, and trashes rows whose key
 *              matches a `managed` family but is no longer wanted. Rows the
 *              engine does not manage — other key families, or no stamp at
 *              all — are reported and never touched. Runs on every sync and
 *              is never gated on hashes: a missing card is invisible to a
 *              diff.
 *
 *   upsert     an intake. The project supplies rows keyed by `id`; the engine
 *              creates the ones whose id is not already on the board and
 *              never deletes or edits an existing one.
 *
 * Both:
 *   - read the data source's live schema and build each property payload from
 *     its declared type, so a select that is actually rich_text cannot corrupt
 *     a row; unknown columns are skipped — blank rather than invented.
 *   - treat `forbidden` properties as the user's. They are stripped from every
 *     payload, and a provider that names one is an error at plan time, not a
 *     silent no-op. `onCreateOnly` is the single exception: a value written
 *     once when a row is born (a triage column's "New") and never again.
 */
import { notionFetch, queryDataSource } from './api.mjs';
import { paragraph } from './render.mjs';

/* Build one property payload from the schema's declared type. */
export function propPayload(schema, name, value) {
  const decl = schema[name];
  if (!decl || value == null || value === '') return null;
  const text = String(value);
  switch (decl.type) {
    case 'title': return { title: [{ type: 'text', text: { content: text.slice(0, 200) } }] };
    case 'rich_text': return { rich_text: [{ type: 'text', text: { content: text.slice(0, 2000) } }] };
    case 'select': return { select: { name: text.slice(0, 100) } };
    case 'status': return { status: { name: text.slice(0, 100) } };
    case 'multi_select': return { multi_select: (Array.isArray(value) ? value : [text]).map(v => ({ name: String(v).slice(0, 100) })) };
    case 'number': return { number: Number(value) };
    case 'date': return { date: { start: text } };
    case 'checkbox': return { checkbox: Boolean(value) };
    case 'url': return { url: text };
    default: return null;
  }
}

/* Properties as name→value, through the schema, minus the forbidden set. A
 * forbidden name in the provider's output throws: the project asked the
 * engine to write the user's column, which it must never do quietly. */
export function buildProperties(schema, values, { forbidden = [], onCreateOnly = {}, titleProp } = {}) {
  const forbid = new Set(forbidden);
  const properties = {};
  for (const [name, value] of Object.entries(values ?? {})) {
    if (forbid.has(name)) {
      throw new Error(`refusing to write forbidden property "${name}" — it belongs to the user, not the sync`);
    }
    const payload = propPayload(schema, name, value);
    if (payload) properties[name] = payload;
  }
  for (const [name, value] of Object.entries(onCreateOnly)) {
    const payload = propPayload(schema, name, value);
    if (payload) properties[name] = payload;
  }
  /* A row must have a title; if the provider gave `title` generically, map it. */
  if (titleProp && !properties[titleProp] && values?.title != null) {
    properties[titleProp] = propPayload(schema, titleProp, values.title);
  }
  return properties;
}

const plainOf = prop => (prop?.rich_text ?? prop?.title ?? []).map(t => t.plain_text).join('');

const titlePropOf = schema => Object.keys(schema).find(k => schema[k].type === 'title');

/* Pure: what a reconcile would do, given the board's stamps and the desired
 * rows. Testable without a network. */
export function reconcilePlan(stamps, desired, managed) {
  const desiredKeys = new Set(desired.map(c => c.key));
  const missing = desired.filter(c => !stamps.has(c.key));
  const stale = [...stamps].filter(k => managed.test(k) && !desiredKeys.has(k));
  const foreign = [...stamps].filter(k => !managed.test(k));
  return { missing, stale, foreign };
}

async function reconcile(db, dataSourceId, token, { dryRun, ctx }) {
  const stampProperty = db.stampProperty ?? 'Key';
  const stampPrefix = db.stampPrefix ?? 'gen:';
  const managed = db.managed ?? new RegExp(`^${stampPrefix}`);
  const ds = await notionFetch(`/data_sources/${dataSourceId}`, { token });
  const schema = ds.properties ?? {};
  const titleProp = titlePropOf(schema);
  if (!schema[stampProperty]) {
    throw new Error(`data source has no "${stampProperty}" property to stamp keys into — add it (rich_text) in Notion`);
  }

  const rows = await queryDataSource(dataSourceId, token, {
    filterProperties: [schema[titleProp]?.id, schema[stampProperty]?.id].filter(Boolean),
  });
  const stampRe = new RegExp(`${stampPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\w.-]+`);
  const byKey = new Map();
  for (const page of rows) {
    const stamp = (plainOf(page.properties?.[stampProperty]).match(stampRe) ?? [null])[0];
    if (stamp) byKey.set(stamp, page);
  }

  const desired = await db.desired(ctx);
  for (const card of desired) {
    if (!card.key?.startsWith(stampPrefix)) {
      throw new Error(`desired row key "${card.key}" must start with the stamp prefix "${stampPrefix}"`);
    }
  }
  const { missing, stale, foreign } = reconcilePlan(new Set(byKey.keys()), desired, managed);

  /* Validate every payload before touching the board, so a forbidden column
   * fails the run at plan time rather than after some rows were created. */
  const payloads = missing.map(card => ({
    card,
    properties: {
      ...buildProperties(schema, card.properties, { forbidden: db.forbidden, titleProp }),
      [stampProperty]: propPayload(schema, stampProperty, `${card.key} — generated by notion-repo-sync`),
    },
  }));

  if (dryRun) {
    return {
      ok: true,
      line: `  – ${db.key} (dry): ${rows.length} rows, ${byKey.size} stamped · create ${
        missing.map(c => c.key).join(', ') || 'none'
      } · trash ${db.trashStale === false ? 'off' : stale.join(', ') || 'none'} · unmanaged (report-only): ${foreign.length}`,
    };
  }

  for (const { card, properties } of payloads) {
    await notionFetch('/pages', {
      method: 'POST',
      token,
      body: {
        parent: { type: 'data_source_id', data_source_id: dataSourceId },
        properties,
        children: [
          ...(card.body ?? []).map(paragraph),
          paragraph('Generated from the repo by notion-repo-sync; the repo is the source of truth.'),
        ],
      },
    });
  }

  let trashed = 0;
  if (db.trashStale !== false) {
    for (const key of stale) {
      await notionFetch(`/pages/${byKey.get(key).id}`, {
        method: 'PATCH',
        token,
        /* `archived` is the field name on the pre-2025-09 API; the current one
         * split trash from archive and calls this `in_trash` — confirmed
         * 2026-08-18 against a live 400 naming the field it wanted. */
        body: { in_trash: true },
      });
      trashed += 1;
    }
  }

  const parts = [`${rows.length} rows`, `${missing.length} created`, `${trashed} trashed`];
  if (db.trashStale === false && stale.length) parts.push(`${stale.length} stale left in place (trashStale off)`);
  if (foreign.length) parts.push(`${foreign.length} unmanaged stamped rows left alone (${foreign.join(', ')})`);
  return { ok: true, line: `  ✓ ${db.key}: ${parts.join(', ')}` };
}

async function upsert(db, dataSourceId, token, { dryRun, ctx }) {
  const idProperty = db.idProperty;
  if (!idProperty) throw new Error(`database "${db.key}" (upsert) needs an idProperty`);
  const rows = await db.rows(ctx);

  const ds = await notionFetch(`/data_sources/${dataSourceId}`, { token });
  const schema = ds.properties ?? {};
  const titleProp = titlePropOf(schema);
  if (!schema[idProperty]) {
    throw new Error(`data source has no "${idProperty}" property to key rows on — add it (rich_text) in Notion`);
  }

  const existing = await queryDataSource(dataSourceId, token, {
    filterProperties: [schema[idProperty]?.id].filter(Boolean),
  });
  const known = new Set(existing.map(p => plainOf(p.properties?.[idProperty])));

  const fresh = rows.filter(r => !known.has(String(r.id)));
  const payloads = fresh.map(r => ({
    row: r,
    properties: {
      ...buildProperties(schema, r.properties, {
        forbidden: db.forbidden,
        onCreateOnly: db.onCreateOnly,
        titleProp,
      }),
      [idProperty]: propPayload(schema, idProperty, r.id),
    },
  }));

  if (dryRun) {
    return { ok: true, line: `  – ${db.key} (dry): ${rows.length} rows, ${fresh.length} new` };
  }

  let created = 0;
  for (const { row, properties } of payloads) {
    await notionFetch('/pages', {
      method: 'POST',
      token,
      body: {
        parent: { type: 'data_source_id', data_source_id: dataSourceId },
        properties,
        children: (row.body ?? []).filter(l => l.trim()).slice(0, 20).map(paragraph),
      },
    });
    created += 1;
  }

  return {
    ok: true,
    line: `  ✓ ${db.key}: ${rows.length} rows from the provider, ${created} created, ${known.size} already on the board`,
  };
}

export async function syncDatabase(db, dataSourceId, token, opts) {
  if (db.mode === 'reconcile') return reconcile(db, dataSourceId, token, opts);
  if (db.mode === 'upsert') return upsert(db, dataSourceId, token, opts);
  throw new Error(`database "${db.key}": mode must be "reconcile" or "upsert", got ${db.mode}`);
}
