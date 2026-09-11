/**
 * Pure text helpers for slicing markdown documents into the pieces a Notion
 * page mirrors, plus the blob hash that fingerprints them.
 *
 * Every helper takes text and returns text. None reads a file — the config
 * context (lib/config.mjs) supplies `read()`, so these stay testable and a
 * project's config can compose them however its docs are shaped.
 */
import crypto from 'node:crypto';

/* A git blob hash, byte-identical to `git hash-object`, so file-backed and
 * virtual (extracted-string) sources share one hashing scheme across the whole
 * state file. A fingerprint is only meaningful against another one computed
 * the same way; this pins the way. */
export const blobHash = text => {
  const body = Buffer.from(text, 'utf8');
  return crypto
    .createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]))
    .digest('hex');
};

/* Split on headings of exactly `level`, keeping each heading with its body.
 * The text before the first heading comes back as sections[0] with heading ''. */
export function splitAt(text, level) {
  const re = new RegExp(`^#{${level}} `);
  const sections = [{ heading: '', lines: [] }];
  for (const line of text.split('\n')) {
    if (re.test(line)) sections.push({ heading: line, lines: [line] });
    else sections.at(-1).lines.push(line);
  }
  return sections.map(s => ({ heading: s.heading, text: s.lines.join('\n') }));
}

/* The section at `level` whose heading text starts with `prefix`, or ''. */
export const sectionNamed = (text, level, prefix) =>
  splitAt(text, level).find(s => s.heading.replace(/^#+ /, '').startsWith(prefix))?.text ?? '';

/* The first `n` sections at `level` (a changelog's newest releases). */
export const firstSections = (text, level, n) =>
  splitAt(text, level).filter(s => s.heading).slice(0, n).map(s => s.text).join('\n');

/* The last section at `level` that has children at `childLevel` (a log's
 * newest phase with sessions in it; a trailing "not started" stub has none and
 * is skipped). */
export function newestWithChildren(text, level = 2, childLevel = 3) {
  const childRe = new RegExp(`^#{${childLevel}} `, 'm');
  const sections = splitAt(text, level).filter(s => s.heading);
  return sections.filter(s => childRe.test(s.text)).at(-1)?.text ?? '';
}

/* Split a document into two halves by a predicate on each heading of level 2
 * or deeper. A section joins `archived` when `isArchived(heading)` is true;
 * everything else — including the preamble before the first heading — is
 * `active`. A level-1 heading is a divider between halves, not an entry, so it
 * belongs to whichever section it falls in.
 *
 * This is exactly the algorithm the Manifest runbook partition used, kept
 * byte-for-byte so its recorded fingerprints still reproduce. */
const PARTITION_HEADING = /^#{2,6}\s/;

export function partition(text, isArchived) {
  const sections = [];
  let current = { heading: '', lines: [] };
  for (const line of text.split('\n')) {
    if (PARTITION_HEADING.test(line)) {
      sections.push(current);
      current = { heading: line, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);

  const active = [];
  const archived = [];
  for (const section of sections) {
    if (!section.lines.length) continue;
    (section.heading && isArchived(section.heading) ? archived : active).push(section.lines.join('\n'));
  }
  return { active: active.join('\n'), archived: archived.join('\n') };
}

/* The leaf-most sections that contain `marker` (a runbook's entries carrying a
 * verbatim prompt), in file order. An h2 counts only if the marker sits in its
 * own body above its first h3 child; otherwise the h3 that carries it is the
 * entry. File order is the priority order. */
export function entriesWith(text, marker) {
  const entries = [];
  for (const s of splitAt(text, 2)) {
    if (!s.heading) continue;
    const ownBody = s.text.split(/^### /m)[0];
    if (ownBody.includes(marker)) {
      entries.push({ heading: s.heading, text: ownBody, at: text.indexOf(s.heading) });
    }
  }
  for (const s of splitAt(text, 3)) {
    if (s.heading && s.text.includes(marker)) {
      entries.push({ ...s, at: text.indexOf(s.heading) });
    }
  }
  return entries.sort((a, b) => a.at - b.at);
}

export const headingText = heading => heading.replace(/^#+ /, '');
