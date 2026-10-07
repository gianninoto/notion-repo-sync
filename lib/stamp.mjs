/**
 * The last-updated stamp (Manifest, 2026-10-05). Every page opens with when
 * the repo text it mirrors last changed: the newest commit among its source
 * files, never the moment the sync ran — that would call a page updated whose
 * content did not move.
 *
 * RENDER_KEY is a virtual source every stamped page reads. Its value changes
 * only when what every page looks like changes, so bumping RENDER_VERSION
 * rewrites each page once — how the stamp first got on. The version string
 * is Manifest's, verbatim, so a project moving onto this package from
 * Manifest's own copy keeps its recorded hashes (an all-skip first run).
 */
export const RENDER_KEY = 'notion-render';
export const RENDER_VERSION = 'v2 · the last-updated stamp, 2026-10-05';
export const STAMP_DEFAULTS = { prefix: 'Last updated', timeZone: 'UTC', label: 'UTC' };

export function formatStamp(iso, { timeZone, label }) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone, weekday: 'short', day: 'numeric', month: 'short',
      year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    }).formatToParts(new Date(iso)).map(p => [p.type, p.value]),
  );
  return `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${label}`;
}

export function stampLine(isoDates, opts) {
  const newest = isoDates.filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  return newest ? `🕒 *${opts.prefix} ${formatStamp(newest, opts)}*` : '';
}

export const isStamp = (text, prefix = STAMP_DEFAULTS.prefix) => text.replace(/^🕒\s*/, '').startsWith(prefix);

/* A virtual source `docs/x.md#part` is stamped from its file, `docs/x.md`. */
export const stampFor = (sourceKeys, lastCommit, opts) =>
  stampLine([...new Set(sourceKeys.filter(k => k !== RENDER_KEY).map(k => k.split('#')[0]))].map(lastCommit), opts);
