// Shared path helpers for the release tooling.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the rebrowser-patches repo root (the parent of release/). */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Work dir for clones, builds, tarballs and browsers. Never inside the repo. */
export function workDir() {
  const dir = path.resolve(process.env.REBROWSER_WORK_DIR || path.join(os.homedir(), '.cache', 'rebrowser-patches'));
  const rel = path.relative(repoRoot, dir);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(`REBROWSER_WORK_DIR (${dir}) must be outside the repo (${repoRoot})`);
  }
  return dir;
}

export const workPath = (...parts) => path.join(workDir(), ...parts);
export const repoPath = (...parts) => path.join(repoRoot, ...parts);

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

/** Recreate `dir` empty. */
export function freshDir(dir) {
  rmrf(dir);
  return ensureDir(dir);
}

export const exists = (p) => fs.existsSync(p);

/** Default output dir for built artifacts. */
export const defaultOutDir = () => workPath('dist');

/** Directory name safe for use in the work dir: `playwright-core@1.2.3` -> `playwright-core@1.2.3`, `/` -> `__`. */
export const safeName = (s) => s.replace(/[\\/:]/g, '__');
