// Unified-diff generation (lib.patch style) and patch application, via diff(1) / patch(1) / git.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.mjs';

/**
 * Directory diff in the repo's lib.patch format:
 *   diff -ruN -x '*.map' -x '*.tsbuildinfo' -x '*.test.*' <orig> <patched>
 * with the `diff -ruN` command lines dropped and the `---`/`+++` headers rewritten to
 * `--- a/<prefix>/<file>` / `+++ b/<prefix>/<file>` with no timestamp.
 * Returns '' when the trees are identical. Throws if diff reports binary differences.
 */
export async function diffDirs(origDir, patchedDir, { prefix = 'lib', excludes = ['*.map', '*.tsbuildinfo', '*.test.*'] } = {}) {
  const origRoot = path.resolve(origDir);
  const patchedRoot = path.resolve(patchedDir);
  const args = ['-ruN', ...excludes.flatMap((x) => ['-x', x]), origRoot, patchedRoot];
  const { stdout } = await run('diff', args, { okCodes: [0, 1], capture: true, echo: false });
  return normalizeDiff(stdout, { origRoot, patchedRoot, prefix });
}

export function normalizeDiff(text, { origRoot, patchedRoot, prefix }) {
  if (!text) return '';
  const lines = text.split('\n');
  // split('\n') leaves a trailing '' when the text ends with a newline; re-added on join.
  const out = [];
  const rel = (field, root) => {
    const file = field.split('\t')[0];
    if (!file.startsWith(root + path.sep)) throw new Error(`unexpected path in diff header: ${file} (root ${root})`);
    return file.slice(root.length + 1);
  };
  let header = 0; // 0: in body; 1: next line is `---`; 2: next line is `+++`
  for (const line of lines) {
    if (header === 0 && line.startsWith('diff ')) {
      header = 1;
      continue; // drop the `diff -ruN ...` line
    }
    if (header === 0 && line.startsWith('Binary files ')) {
      throw new Error(`binary difference in tree diff: ${line}`);
    }
    if (header === 1) {
      if (!line.startsWith('--- ')) throw new Error(`expected '--- ' header, got: ${line}`);
      out.push(`--- a/${prefix}/${rel(line.slice(4), origRoot)}`);
      header = 2;
      continue;
    }
    if (header === 2) {
      if (!line.startsWith('+++ ')) throw new Error(`expected '+++ ' header, got: ${line}`);
      out.push(`+++ b/${prefix}/${rel(line.slice(4), patchedRoot)}`);
      header = 0;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Apply a -p1 patch inside `dir` with patch(1) (no fuzz); throws on any rejected hunk. */
export async function applyPatch(dir, patchFile, { dryRun = false, logFile } = {}) {
  const args = ['-p1', '--batch', '--forward', '--fuzz=0', '--no-backup-if-mismatch', '-d', dir, '-i', patchFile];
  if (dryRun) args.push('--dry-run');
  await run('patch', args, { logFile, echo: false });
}

/** Byte-compare two files. Returns true when identical (missing files are not identical). */
export function sameFile(a, b) {
  if (!fs.existsSync(a) || !fs.existsSync(b)) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}
