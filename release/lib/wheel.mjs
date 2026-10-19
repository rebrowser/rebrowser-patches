// Wheel contents for the PyPI upload plan: a wheel's *.dist-info/RECORD lists every file with its sha256, so two
// wheels with the same RECORD have the same contents even when the zip bytes differ (timestamps, order).
import { capture } from './exec.mjs';

const READ_RECORD = [
  'import sys, zipfile',
  'z = zipfile.ZipFile(sys.argv[1])',
  "names = [n for n in z.namelist() if n.endswith('.dist-info/RECORD')]",
  "assert len(names) == 1, 'expected one RECORD, found %d' % len(names)",
  "sys.stdout.write(z.read(names[0]).decode('utf-8'))",
].join('\n');

/** The RECORD of a wheel as a sorted list of lines. */
export async function readRecord(wheelPath) {
  const text = await capture('python3', ['-c', READ_RECORD, wheelPath]);
  return text.split('\n').map((l) => l.trim()).filter(Boolean).sort();
}

export const sameRecord = (a, b) => a.length === b.length && a.every((line, i) => line === b[i]);

/**
 * Decide what to upload. `local`: [{ file, sha256, record }]. `published`: Map filename -> { sha256, record }, where
 * `record` may be omitted when the sha256 already matches. Returns { upload, skip, conflicts } (file names).
 *  - not on PyPI                          -> upload
 *  - on PyPI, same bytes or same RECORD   -> skip
 *  - on PyPI with a different RECORD      -> conflict (the version needs a new publishVersion)
 */
export function planUploads(local, published) {
  const plan = { upload: [], skip: [], conflicts: [] };
  for (const w of local) {
    const p = published.get(w.file);
    if (!p) plan.upload.push(w.file);
    else if (p.sha256 === w.sha256 || (p.record && w.record && sameRecord(p.record, w.record))) plan.skip.push(w.file);
    else plan.conflicts.push(w.file);
  }
  return plan;
}
