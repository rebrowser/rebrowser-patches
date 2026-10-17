// What the published `rebrowser-patches` CLI package may contain, derived from release/versions.json.
//
// The CLI patches an installed puppeteer-core or playwright-core, so the package ships the patcher
// (scripts/), its metadata, and lib.patch + src.patch for every upstream version that has been or is
// being released to npm. Build-only patches (the Python driver beta, playwright-python) stay in git.
import path from 'node:path';

const CLI_PACKAGES = ['puppeteer-core', 'playwright-core'];
const METADATA = ['package.json', 'README.md', 'LICENSE'];

/** The patch directories the CLI package must ship, e.g. "patches/puppeteer-core/25.14.0". */
export function expectedPatchDirs(versions) {
  const dirs = new Set();
  for (const r of versions.released || []) {
    if (CLI_PACKAGES.includes(r.package)) dirs.add(`patches/${r.package}/${r.version}`);
  }
  for (const t of versions.targets || []) {
    if (CLI_PACKAGES.includes(t.package) && t.publish !== false) dirs.add(`patches/${t.package}/${t.version}`);
  }
  return [...dirs].sort();
}

/**
 * Check a packed file list (paths relative to the package root) against versions.json.
 * Returns a list of problems; empty means the package ships exactly what it should.
 */
export function checkCliPackFiles(files, versions) {
  const problems = [];
  const expected = expectedPatchDirs(versions);
  for (const f of files) {
    if (METADATA.includes(f) || f.startsWith('scripts/')) continue;
    const dir = path.posix.dirname(f);
    if (!f.startsWith('patches/') || !expected.includes(dir)) problems.push(`ships an unexpected file: ${f}`);
  }
  for (const dir of expected) {
    for (const name of ['lib.patch', 'src.patch']) {
      if (!files.includes(`${dir}/${name}`)) problems.push(`missing ${dir}/${name} (add "/${dir}" to package.json "files")`);
    }
  }
  for (const f of METADATA) if (!files.includes(f)) problems.push(`missing ${f}`);
  if (!files.some((f) => f.startsWith('scripts/'))) problems.push('missing scripts/ (the patcher)');
  return problems;
}

// npm trusted publishing adds provenance, and npm rejects a publish whose package.json repository.url
// doesn't match the repo the workflow ran in. Every npm package we build is published from this repo.
export const PUBLISH_REPO = 'github.com/rebrowser/rebrowser-patches';

/** Returns an error message if package.json's repository doesn't point at PUBLISH_REPO, else null. */
export function checkRepository(pkgJson) {
  const raw = typeof pkgJson.repository === 'string' ? pkgJson.repository : pkgJson.repository?.url;
  const normalized = String(raw || '').replace(/^git\+/, '').replace(/^https?:\/\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  return normalized === PUBLISH_REPO ? null
    : `${pkgJson.name}: package.json repository is "${raw || ''}", but provenance requires https://${PUBLISH_REPO}`;
}
