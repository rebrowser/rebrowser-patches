// npm registry access: version metadata (gitHead, dist.integrity) and `npm pack` download + extract.
import fs from 'node:fs';
import path from 'node:path';
import { run } from './exec.mjs';
import { integrityOfFile, shasumOfFile } from './integrity.mjs';
import { ensureDir, exists, freshDir, rmrf, safeName, workPath } from './paths.mjs';

export const registry = () => (process.env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '');

/** GET json with retries. Returns null on 404. */
export async function fetchJson(url, { retries = 3, headers } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(30_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
  throw new Error(`GET ${url} failed: ${lastError.message}`);
}

export async function fetchText(url, { retries = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      lastError = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }
  throw new Error(`GET ${url} failed: ${lastError.message}`);
}

/** Full version document: `{ name, version, gitHead, dist: { integrity, shasum, tarball }, ... }`. Null if missing. */
export async function getVersionMeta(pkg, version) {
  return fetchJson(`${registry()}/${pkg}/${encodeURIComponent(version)}`);
}

/** The version `latest` (or another dist-tag) points to, with the full version document. */
export async function getTagMeta(pkg, tag = 'latest') {
  return fetchJson(`${registry()}/${pkg}/${encodeURIComponent(tag)}`);
}

/**
 * Download `<pkg>@<version>` with `npm pack`, verify it against the registry's dist.integrity and
 * extract it. Cached under <work>/npm/<pkg>@<version>/ (re-verified on every call).
 *
 * Returns { pkg, version, tgz, dir (the extracted `package/` dir, treat as read-only),
 *           integrity, shasum, meta }.
 */
export async function fetchUpstream(pkg, version, { root = workPath('npm'), logFile } = {}) {
  const meta = await getVersionMeta(pkg, version);
  if (!meta) throw new Error(`${pkg}@${version} does not exist on the npm registry`);
  const base = path.join(root, safeName(`${pkg}@${version}`));
  const tgz = path.join(base, `${safeName(pkg)}-${version}.tgz`);
  const expected = meta.dist.integrity;
  if (!exists(tgz) || integrityOfFile(tgz) !== expected) {
    freshDir(base);
    await run('npm', ['pack', `${pkg}@${version}`, '--pack-destination', base, '--ignore-scripts', '--silent'], {
      cwd: base,
      logFile,
      echo: false,
    });
    const packed = fs.readdirSync(base).filter((f) => f.endsWith('.tgz'));
    if (packed.length !== 1) throw new Error(`npm pack ${pkg}@${version} produced ${JSON.stringify(packed)}`);
    if (packed[0] !== path.basename(tgz)) fs.renameSync(path.join(base, packed[0]), tgz);
  }
  const integrity = integrityOfFile(tgz);
  if (integrity !== expected) {
    throw new Error(`${pkg}@${version}: downloaded tarball integrity ${integrity} != registry ${expected}`);
  }
  const extractRoot = path.join(base, 'extracted');
  freshDir(extractRoot);
  await run('tar', ['-xzpf', tgz, '-C', extractRoot, '--no-same-owner'], { echo: false }); // -p: keep the archive's modes, ignore umask
  return { pkg, version, tgz, dir: path.join(extractRoot, 'package'), integrity, shasum: shasumOfFile(tgz), meta };
}

/** Copy a directory tree preserving modes (`cp -a`). */
export async function copyTree(src, dest) {
  rmrf(dest);
  ensureDir(path.dirname(dest));
  await run('cp', ['-a', src, dest], { echo: false });
}
