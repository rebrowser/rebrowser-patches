#!/usr/bin/env node
/**
 * Decide which wheels to upload to PyPI, so publishing can be repeated safely. PyPI never accepts a changed file
 * under an existing name, and our wheels aren't byte-reproducible, so a rebuilt wheel of a version that is already
 * on PyPI can't simply be uploaded again. Per wheel of python-manifest.json:
 *   - not on PyPI                                   -> upload
 *   - on PyPI with the same bytes or the same RECORD -> skip (same contents)
 *   - on PyPI with a different RECORD                -> error: the contents changed, set a new publishVersion
 *
 *   node release/pypi-plan.mjs <wheel-dir> [--manifest <python-manifest.json>] [--out <dir>]
 *
 * --manifest defaults to <wheel-dir>/python-manifest.json. With --out, the wheels to upload are copied there (the
 * dir is recreated, so it is empty when nothing needs uploading). In GitHub Actions, `upload=true|false` is written
 * to $GITHUB_OUTPUT. Exits 1 on any conflict.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ExitError, main, parse } from './lib/cli.mjs';
import { log } from './lib/exec.mjs';
import { sha256OfFile } from './lib/integrity.mjs';
import { fetchJson } from './lib/npm.mjs';
import { freshDir, workPath } from './lib/paths.mjs';
import { planUploads, readRecord } from './lib/wheel.mjs';

main(async () => {
  const { values, positionals } = parse({
    usage: 'pypi-plan.mjs <wheel-dir> [--manifest <python-manifest.json>] [--out <dir>]',
    options: { manifest: { type: 'string' }, out: { type: 'string' } },
  });
  const [wheelDir] = positionals;
  if (!wheelDir || positionals.length !== 1) throw new Error('usage: pypi-plan.mjs <wheel-dir> [--manifest <file>] [--out <dir>]');
  const manifest = JSON.parse(fs.readFileSync(values.manifest || path.join(wheelDir, 'python-manifest.json'), 'utf8'));
  const { distribution, version } = manifest;

  const local = manifest.wheels.map(({ file }) => {
    const p = path.join(wheelDir, file);
    if (!fs.existsSync(p)) throw new Error(`${file} (listed in the manifest) is not in ${wheelDir}`);
    return { file, path: p, sha256: sha256OfFile(p) };
  });

  const meta = await fetchJson(`https://pypi.org/pypi/${distribution}/${version}/json`);
  const published = new Map((meta?.urls || []).map((u) => [u.filename, { sha256: u.digests.sha256, url: u.url }]));
  log(`${distribution} ${version}: ${published.size ? `${published.size} file(s) on PyPI` : 'not on PyPI'}`);

  // Only wheels that are on PyPI with different bytes need their RECORDs compared.
  const tmp = freshDir(workPath('pypi-plan'));
  for (const w of local) {
    const p = published.get(w.file);
    if (!p || p.sha256 === w.sha256) continue;
    const res = await fetch(p.url);
    if (!res.ok) throw new Error(`download ${p.url}: HTTP ${res.status}`);
    const file = path.join(tmp, w.file);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    p.record = await readRecord(file);
    w.record = await readRecord(w.path);
    fs.rmSync(file);
  }

  const plan = planUploads(local, published);
  for (const f of plan.upload) log(`  upload    ${f}`);
  for (const f of plan.skip) log(`  on PyPI   ${f} (same contents)`);
  for (const f of plan.conflicts) log(`  CONFLICT  ${f}: PyPI has different contents under this name`);

  if (values.out) {
    const out = freshDir(path.resolve(values.out));
    for (const f of plan.upload) fs.copyFileSync(path.join(wheelDir, f), path.join(out, f));
  }
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `upload=${plan.upload.length > 0 && plan.conflicts.length === 0}\n`);
  if (plan.conflicts.length) {
    throw new ExitError(`ERROR: ${distribution} ${version} is already on PyPI with different contents; set a new publishVersion for the python entry in release/versions.json`);
  }
  log(`pypi-plan: ${plan.upload.length} to upload, ${plan.skip.length} already on PyPI`);
});
