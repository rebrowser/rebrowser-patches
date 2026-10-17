#!/usr/bin/env node
// Build the drop-in npm tarballs (rebrowser-*) and the CLI tarball from npm tarballs + repo patches.
import fs from 'node:fs';
import path from 'node:path';
import { main, parse } from './lib/cli.mjs';
import { applyPatch } from './lib/diff.mjs';
import { capture, log, run, step } from './lib/exec.mjs';
import { checkCliPackFiles, checkRepository } from './lib/clipack.mjs';
import { integrityOfFile, sha256OfFile, shasumOfFile } from './lib/integrity.mjs';
import { copyTree, fetchUpstream } from './lib/npm.mjs';
import { defaultOutDir, ensureDir, exists, freshDir, repoPath, repoRoot, safeName, workPath } from './lib/paths.mjs';
import { loadVersions, selectTargets } from './lib/versions.mjs';

const usage = `Usage: node release/build-packages.mjs [--target <pkg>@<version>]... [--out <dir>] [--no-cli]

Builds, for every release target in release/versions.json (or only the --target ones, e.g.
--target puppeteer-core@25.14.0 --target playwright-core@1.52.0):
  rebrowser-<core>@V     npm tarball of <core>@V + patches/<core>/V/{lib,src}.patch + package.json/README transform
  rebrowser-<wrapper>@V  npm tarball of <wrapper>@V (puppeteer / playwright), dependency on the core pinned to V
and the CLI (rebrowser-patches@<cliVersion>, 'npm pack' of the repo root).
Targets with role python-driver (playwright-core beta) get the core package only: it is embedded in the
Python wheels, never published to npm.

Templates: release/templates/<rebrowser-name>.json (+ .README.md banner). Tarballs are packed with
'npm pack --ignore-scripts' into --out (default <work>/dist) together with manifest.json.
--no-cli: skip the CLI tarball.`;

const { values: opt } = parse({
  usage,
  options: { target: { type: 'string', multiple: true }, out: { type: 'string' }, 'no-cli': { type: 'boolean' } },
  allowPositionals: false,
});

const TEMPLATE_DIR = repoPath('release', 'templates');
const loadTemplate = (name) => JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, `${name}.json`), 'utf8'));
const logFile = workPath('logs', 'build-packages.log');

/**
 * package.json transform (code-free data in the template):
 *  - template.set: replaced in place (name, description)
 *  - template.afterDescription: removed from the upstream file and inserted, in the template's order,
 *    right after "description" (keywords, contributors, repository, bugs)
 *  - template.dependencies (wrappers): replaces the core dependency; "{version}" -> the exact core version
 */
function transformPackageJson(upstreamJson, template, version) {
  const afterKeys = Object.keys(template.afterDescription || {});
  const out = {};
  for (const [key, value] of Object.entries(upstreamJson)) {
    if (afterKeys.includes(key)) continue;
    out[key] = key in template.set ? template.set[key] : value;
    if (key === 'description') {
      for (const k of afterKeys) out[k] = template.afterDescription[k];
    }
  }
  for (const key of Object.keys(template.set)) {
    if (!(key in upstreamJson)) throw new Error(`package.json has no "${key}" to replace`);
  }
  if (!('description' in upstreamJson) && afterKeys.length) throw new Error('upstream package.json has no "description" to insert after');
  if (template.dependencies) {
    out.dependencies = { ...out.dependencies };
    for (const [dep, spec] of Object.entries(template.dependencies)) {
      if (out.dependencies[dep] !== version) {
        throw new Error(`expected upstream dependency ${dep}@${version}, found ${out.dependencies[dep]}`);
      }
      out.dependencies[dep] = spec.replaceAll('{version}', version);
    }
  }
  return out;
}

async function buildOne({ templateName, upstream, version, patchesFrom, outDir }) {
  const template = loadTemplate(templateName);
  const stage = workPath('stage', safeName(`${templateName}@${version}`));
  const pkgDir = path.join(stage, 'package');
  freshDir(stage);
  await copyTree(upstream.dir, pkgDir);

  const patches = [];
  for (const file of template.patchFiles || []) {
    const patchFile = repoPath('patches', patchesFrom.package, patchesFrom.version, file);
    if (!exists(patchFile)) throw new Error(`missing ${path.relative(repoRoot, patchFile)}`);
    await applyPatch(pkgDir, patchFile, { logFile });
    patches.push(path.relative(repoRoot, patchFile));
  }

  const pjPath = path.join(pkgDir, 'package.json');
  const upstreamJson = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
  if (upstreamJson.name !== template.from || upstreamJson.version !== version) {
    throw new Error(`${upstream.pkg}@${version} tarball has package.json ${upstreamJson.name}@${upstreamJson.version}`);
  }
  const outJson = transformPackageJson(upstreamJson, template, version);
  const repoProblem = checkRepository(outJson);
  if (repoProblem) throw new Error(repoProblem);
  fs.writeFileSync(pjPath, `${JSON.stringify(outJson, null, 2)}\n`);

  const banner = fs.readFileSync(path.join(TEMPLATE_DIR, `${templateName}.README.md`), 'utf8');
  const readmePath = path.join(pkgDir, 'README.md');
  fs.writeFileSync(readmePath, banner + fs.readFileSync(readmePath, 'utf8'));

  // Code-free string rewrites from the template. Used to fix self-referential imports that break
  // once the package is renamed (e.g. the wrapper's install.mjs importing "puppeteer/internal/...").
  for (const rw of template.rewrites || []) {
    const target = path.join(pkgDir, rw.file);
    if (!exists(target)) throw new Error(`rewrite target missing: ${rw.file}`);
    const before = fs.readFileSync(target, 'utf8');
    const after = before.replaceAll(rw.from, rw.to);
    if (after === before) throw new Error(`rewrite made no change in ${rw.file} ("${rw.from}" not found)`);
    fs.writeFileSync(target, after);
  }

  await run('npm', ['pack', '--ignore-scripts', '--pack-destination', outDir, '--silent'], { cwd: pkgDir, logFile, echo: false });
  const file = `${templateName}-${version}.tgz`;
  const abs = path.join(outDir, file);
  if (!exists(abs)) throw new Error(`npm pack did not produce ${abs}`);
  return {
    name: templateName,
    version,
    file,
    integrity: integrityOfFile(abs),
    shasum: shasumOfFile(abs),
    from: { pkg: upstream.pkg, version: upstream.version, integrity: upstream.integrity },
    patches,
    patchSha256: Object.fromEntries(patches.map((p) => [p, sha256OfFile(repoPath(p))])),
  };
}

async function buildCli(outDir, cliVersion) {
  const rootPkg = JSON.parse(fs.readFileSync(repoPath('package.json'), 'utf8'));
  const cliRepoProblem = checkRepository(rootPkg);
  if (cliRepoProblem) throw new Error(cliRepoProblem);
  if (rootPkg.version !== cliVersion) {
    log(`WARNING: root package.json version is ${rootPkg.version} but release/versions.json cliVersion is ${cliVersion}; packing ${rootPkg.version}`);
  }
  // The CLI package must ship exactly the patcher + the patches of released/publishable versions.
  const dryRun = JSON.parse(await capture('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: repoRoot }));
  const packed = dryRun[0].files.map((f) => f.path);
  const problems = checkCliPackFiles(packed, loadVersions());
  if (problems.length) throw new Error(`rebrowser-patches package contents don't match release/versions.json:\n  ${problems.join('\n  ')}`);

  await run('npm', ['pack', '--ignore-scripts', '--pack-destination', outDir, '--silent'], { cwd: repoRoot, logFile, echo: false });
  const file = `${rootPkg.name}-${rootPkg.version}.tgz`;
  const abs = path.join(outDir, file);
  if (!exists(abs)) throw new Error(`npm pack did not produce ${abs}`);
  return {
    name: rootPkg.name,
    version: rootPkg.version,
    file,
    integrity: integrityOfFile(abs),
    shasum: shasumOfFile(abs),
    from: null,
    patches: [],
    patchSha256: {},
    kind: 'cli',
    publish: true,
    npmTag: 'latest',
  };
}

main(async () => {
  process.umask(0o022); // npm pack records file modes: keep them independent of the caller's umask
  const outDir = path.resolve(opt.out || defaultOutDir());
  ensureDir(outDir);
  const { cliVersion } = loadVersions();
  const targets = selectTargets(opt.target || []);
  const artifacts = [];

  for (const target of targets) {
    const meta = { role: target.role ?? 'release', publish: target.publish ?? false, npmTag: target.npmTag ?? null };
    const patchesFrom = { package: target.package, version: target.version };
    const core = await step(`${target.package}@${target.version}: core`, async () => {
      const upstream = await fetchUpstream(target.package, target.version, { logFile });
      return buildOne({ templateName: `rebrowser-${target.package}`, upstream, version: target.version, patchesFrom, outDir });
    });
    artifacts.push({ ...core, kind: 'core', ...meta });

    if (target.wrapper) {
      const wrapper = await step(`${target.wrapper}@${target.version}: wrapper`, async () => {
        const upstream = await fetchUpstream(target.wrapper, target.version, { logFile });
        return buildOne({ templateName: `rebrowser-${target.wrapper}`, upstream, version: target.version, patchesFrom, outDir });
      });
      // wrappers carry no patches of their own
      artifacts.push({ ...wrapper, patches: [], patchSha256: {}, kind: 'wrapper', ...meta });
    }
  }

  if (!opt['no-cli']) {
    artifacts.push(await step('CLI: rebrowser-patches', () => buildCli(outDir, cliVersion)));
  }

  const manifest = { cliVersion, artifacts };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  log(`build-packages: ${artifacts.length} tarball(s) in ${outDir}; manifest ${path.join(outDir, 'manifest.json')}`);
  for (const a of artifacts) log(`  ${a.file}  ${a.integrity.slice(0, 22)}...${a.publish === false ? '  [publish=false]' : ''}`);
});
