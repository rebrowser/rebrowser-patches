// Access to release/versions.json (schema documented in release/README.md).
import fs from 'node:fs';
import { repoPath } from './paths.mjs';

let cached;
export function loadVersions() {
  if (!cached) cached = JSON.parse(fs.readFileSync(repoPath('release', 'versions.json'), 'utf8'));
  return cached;
}

/** Entry for `<package>@<version>` among targets, python targets and released history; null if unknown. */
export function findEntry(pkg, version) {
  const v = loadVersions();
  return (
    [...v.targets, ...v.python, ...v.released].find((e) => e.package === pkg && e.version === version) || null
  );
}

/** Core (npm) targets, optionally filtered by `pkg@version` selectors. */
export function selectTargets(selectors = []) {
  const { targets, released } = loadVersions();
  if (selectors.length === 0) return targets;
  return selectors.map((sel) => {
    const at = sel.lastIndexOf('@');
    if (at <= 0) throw new Error(`bad --target "${sel}", expected <package>@<version>`);
    const pkg = sel.slice(0, at);
    const version = sel.slice(at + 1);
    const hit = [...targets, ...released].find((e) => e.package === pkg && e.version === version);
    if (!hit) throw new Error(`${sel} is not listed in release/versions.json (targets or released)`);
    return hit;
  });
}
