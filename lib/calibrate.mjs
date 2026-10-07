/**
 * Calibrate a row provider's read before trusting it (Manifest's history
 * reads). A read that reached the wrong place, or none, can come back empty
 * and look like "no rows". So a known canary row must be present — proof the
 * read reached real data — and every expected group must be non-empty. A read
 * that cannot prove itself throws; nothing from it is written.
 *
 *   calibrate: { canary: row => bool, expect: { name: row => bool, … } }
 */
export function calibrate(rows, { canary, expect = {} }, label = 'rows') {
  if (!rows.some(canary)) {
    throw new Error(`${label}: calibration failed — the canary row is missing from ${rows.length} row(s); nothing was trusted`);
  }
  for (const [name, test] of Object.entries(expect)) {
    if (!rows.some(test)) {
      throw new Error(`${label}: calibration failed — expected rows for "${name}", found none; nothing was trusted`);
    }
  }
  return rows;
}
