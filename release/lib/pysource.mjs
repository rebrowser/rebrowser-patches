// The playwright-python source tree that the wheels are built from, as mirrored to rebrowser-playwright-python.
//
// build-python.mjs saves it next to the wheels: python-src.tar (the prepared tree: tracked files plus untracked,
// non-ignored ones such as rebrowser_playwright/) and python-orig.tar (`git archive` of the upstream tag).
// mirror.mjs turns them into the "original" and "patched" commits of a version branch.
import fs from 'node:fs';
import path from 'node:path';
import { capture, run } from './exec.mjs';

export const SRC_TAR = 'python-src.tar';
export const ORIG_TAR = 'python-orig.tar';

// Upstream repository tooling: microsoft/playwright-python's CI, publishing, Dependabot and other development
// settings. None of it builds the wheels or applies to the mirror, so the "patched" commit leaves it out
// (the "original" commit keeps it). Top-level names only.
export const UPSTREAM_TOOLING = ['.github', '.azure-pipelines', '.claude', 'CLAUDE.md', 'AGENTS.md'];

/** The files of the prepared tree that are mirrored (relative paths, sorted). */
export async function sourceFiles(clone) {
  const out = await capture('git', ['ls-files', '-z', '-c', '-o', '--exclude-standard'], { cwd: clone });
  return [...new Set(out.split('\0').filter(Boolean))].filter((f) => !/\.egg-info\//.test(f)).sort();
}

/** Write python-src.tar and python-orig.tar for the prepared clone into outDir. */
export async function writeSourceTars(clone, outDir) {
  const list = path.join(outDir, '.python-src.list');
  fs.writeFileSync(list, (await sourceFiles(clone)).join('\0'));
  try {
    await run('tar', ['-cf', path.join(outDir, SRC_TAR), '-C', clone, '--null', '--no-recursion', '-T', list], { echo: false });
  } finally {
    fs.rmSync(list, { force: true });
  }
  await run('git', ['archive', '-o', path.join(outDir, ORIG_TAR), 'HEAD'], { cwd: clone, echo: false });
}
