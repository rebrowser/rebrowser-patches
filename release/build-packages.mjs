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
  rebrowser-<wrapper>@V  npm tarball of <wrapper>@V (puppeteer / playwright), depending on rebrowser-<core>@V (exact) under
                         its real name; every module specifier of the core in the wrapper's code is renamed to match
and the CLI (rebrowser-patches@<cliVersion>, 'npm pack' of the repo root).
Targets with role python-driver (playwright-core beta) get the core package only: it is embedded in the
Python wheels, never published to npm.
A target's "publishVersion" (re-release of the same upstream version, X.Y.100+n) becomes the version of the built
packages and their tarball names, and the version the wrapper pins its core to; patches and upstream tarballs stay
keyed by "version".

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
 *  - template.replaceDependencies (wrappers): { "<upstream dep>": { "name": "<new dep>", "version": "<spec>" } }.
 *    The upstream dependency must be pinned at exactly the package version; it is replaced, in place, by <new dep>
 *    at <spec> ("{version}" -> the exact package version). The core is deliberately NOT an npm alias
 *    ("puppeteer-core": "npm:rebrowser-puppeteer-core@V"): next to a real puppeteer@V in the same project npm
 *    dedupes the alias to the unpatched upstream core (npm/cli#4197, issue #74). Because the wrapper no longer
 *    has a "<upstream dep>" dependency, rewriteSpecifiers() renames its module specifiers in the shipped code.
 */
function transformPackageJson(upstreamJson, template, version, publishVersion = version) {
  const afterKeys = Object.keys(template.afterDescription || {});
  const out = {};
  for (const [key, value] of Object.entries(upstreamJson)) {
    if (afterKeys.includes(key)) continue;
    out[key] = key in template.set ? template.set[key] : key === 'version' ? publishVersion : value;
    if (key === 'description') {
      for (const k of afterKeys) out[k] = template.afterDescription[k];
    }
  }
  for (const key of Object.keys(template.set)) {
    if (!(key in upstreamJson)) throw new Error(`package.json has no "${key}" to replace`);
  }
  if (!('description' in upstreamJson) && afterKeys.length) throw new Error('upstream package.json has no "description" to insert after');
  if (template.replaceDependencies) {
    const upstreamDeps = out.dependencies || {};
    for (const dep of Object.keys(template.replaceDependencies)) {
      if (upstreamDeps[dep] !== version) {
        throw new Error(`expected upstream dependency ${dep}@${version}, found ${upstreamDeps[dep]}`);
      }
    }
    out.dependencies = {};
    for (const [dep, spec] of Object.entries(upstreamDeps)) {
      const replacement = template.replaceDependencies[dep];
      if (replacement) out.dependencies[replacement.name] = replacement.version.replaceAll('{version}', publishVersion);
      else out.dependencies[dep] = spec;
    }
  }
  return out;
}

const CODE_FILE = /\.[cm]?[jt]s$/; // .js .cjs .mjs .ts .mts .cts, so also .d.ts; never .map, README or LICENSE

function listCodeFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listCodeFiles(abs));
    else if (entry.isFile() && CODE_FILE.test(entry.name)) files.push(abs);
  }
  return files;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The module specifiers of `name` that rewriteSpecifiers() renames, in two forms:
 *  - a quoted one that is exactly `name` or starts with `name/`: 'name', "name/lib/x", import("name"). Groups 1 (quote)
 *    and 2 (subpath: "/lib/x" or undefined). Not when it is one operand of a `+` concatenation ('name/' + x): such a
 *    specifier is not complete, it is left alone for findUnrewrittenSpecifiers() to fail the build on.
 *  - a static template literal (no `${`) that is the first argument of require( / require.resolve( / import(:
 *    require(`name/lib/x`). Groups 3 (the call up to the backtick) and 4 (subpath).
 * Prose that only contains the word (log messages, comments with backticks) does not match.
 */
const specifierRegex = (name) => {
  const n = escapeRegex(name);
  const quoted = `(?<!\\+\\s*)(['"])${n}(/[^'"]*)?\\1(?!\\s*\\+)`;
  const template = `((?<![\\w$.])(?:require(?:\\.resolve)?|import)\\s*\\(\\s*)\`${n}(/(?:(?!\\$\\{)[^\`])*)?\`(?=\\s*[,)])`;
  return new RegExp(`${quoted}|${template}`, 'g');
};

/** Renames the module specifiers of `from` to `to` in all code files of pkgDir. Returns { files, count, subpaths }. */
function rewriteSpecifiers(pkgDir, from, to) {
  const re = specifierRegex(from);
  const subpaths = new Set();
  let files = 0;
  let count = 0;
  for (const file of listCodeFiles(pkgDir)) {
    const before = fs.readFileSync(file, 'utf8');
    let n = 0;
    const after = before.replace(re, (_match, quote, sub, callPrefix, templateSub) => {
      n++;
      const subpath = (callPrefix === undefined ? sub : templateSub) ?? '';
      subpaths.add(subpath ? `.${subpath}` : '.');
      return callPrefix === undefined ? `${quote}${to}${subpath}${quote}` : `${callPrefix}\`${to}${subpath}\``;
    });
    if (n === 0) continue;
    fs.writeFileSync(file, after); // in place: keeps the file mode
    files++;
    count += n;
  }
  return { files, count, subpaths: [...subpaths].sort() };
}

/**
 * Independent of specifierRegex(): the "file: text" of every require(...) / require.resolve(...) / import(...) call whose
 * argument (the text up to the first closing paren, across lines) or `from '...'` clause still mentions the module `name` in
 * any form: a template literal with `${`, a concatenation ('name/' + x), a literal rewriteSpecifiers() did not rename.
 * Run after the rewrite: anything it returns is a specifier that would load the unpatched upstream core (or throw).
 */
function findUnrewrittenSpecifiers(text, name) {
  const mention = new RegExp(`(?<![\\w-])${escapeRegex(name)}(?![\\w-])`);
  const calls = /(?<![\w$.])(?:require(?:\.resolve)?|import)\s*\(([^)]{0,500})/g; // the argument may span lines
  const fromClauses = /^[ \t]*(?:(?:import|export)\b[^\n]*?|\})[ \t]*\bfrom\s+(['"`])((?:(?!\1)[^\n])*)/gm; // import/export statements, not prose
  const found = [];
  for (const match of text.matchAll(calls)) if (mention.test(match[1])) found.push(match[0].trim());
  for (const match of text.matchAll(fromClauses)) if (mention.test(match[2])) found.push(match[0].trim());
  return found;
}

/** "file: call" for every module specifier of `name` the rewrite left (or could not handle) in the code files of pkgDir. */
function findSpecifiers(pkgDir, name) {
  const found = [];
  for (const file of listCodeFiles(pkgDir)) {
    for (const hit of findUnrewrittenSpecifiers(fs.readFileSync(file, 'utf8'), name)) found.push(`${path.relative(pkgDir, file)}: ${hit}`);
  }
  return found;
}

/** Whether a package.json "exports" field exports `subpath` ("." or "./x"): subpath map, "*" patterns, null targets. */
function isExported(exportsField, subpath) {
  const keys = exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField) ? Object.keys(exportsField) : [];
  if (!keys.some((k) => k.startsWith('.'))) return subpath === '.' && Boolean(exportsField); // string / array / conditions: main entry only
  if (Object.hasOwn(exportsField, subpath)) return exportsField[subpath] != null;
  let best = null;
  for (const key of keys) {
    const star = key.indexOf('*');
    if (star === -1 || key.indexOf('*', star + 1) !== -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.length < key.length || !subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    if (!best || prefix.length > best.prefix.length || (prefix.length === best.prefix.length && key.length > best.key.length)) best = { key, prefix };
  }
  return best !== null && exportsField[best.key] != null;
}

async function buildOne({ templateName, upstream, version, publishVersion = version, patchesFrom, outDir, coreJson }) {
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
  const outJson = transformPackageJson(upstreamJson, template, version, publishVersion);
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

  // The wrapper depends on the renamed core under its real name (template.replaceDependencies), so every
  // module specifier of the upstream core in the shipped code has to point at it too.
  for (const [from, { name: to }] of Object.entries(template.replaceDependencies || {})) {
    if (!coreJson || coreJson.name !== to || coreJson.version !== publishVersion) {
      throw new Error(`${templateName}: replaces ${from} with ${to}@${publishVersion}, but the built core is ${coreJson ? `${coreJson.name}@${coreJson.version}` : 'missing'}`);
    }
    const { files, count, subpaths } = rewriteSpecifiers(pkgDir, from, to);
    if (files === 0) throw new Error(`no module specifier of ${from} found in the ${templateName} code files (did the upstream package layout change?)`);
    const left = findSpecifiers(pkgDir, from);
    if (left.length) throw new Error(`module specifiers of ${from} left in ${templateName} after the rewrite (dynamic, concatenated or otherwise not renamed: they would load the unpatched core):\n  ${left.slice(0, 20).join('\n  ')}`);
    if (coreJson.exports == null) throw new Error(`${to}@${version} package.json has no "exports" map: cannot verify the subpaths ${templateName} loads (${subpaths.join(' ')})`);
    const notExported = subpaths.filter((sp) => !isExported(coreJson.exports, sp));
    if (notExported.length) {
      throw new Error(`${to}@${version} package.json "exports" does not export ${notExported.map((sp) => `${to}${sp.slice(1)}`).join(', ')}, which the ${templateName} code loads`);
    }
    log(`  ${templateName}: ${from} -> ${to} in ${count} specifier(s) / ${files} file(s); subpaths ${subpaths.join(' ')}`);
  }

  await run('npm', ['pack', '--ignore-scripts', '--pack-destination', outDir, '--silent'], { cwd: pkgDir, logFile, echo: false });
  const file = `${templateName}-${publishVersion}.tgz`;
  const abs = path.join(outDir, file);
  if (!exists(abs)) throw new Error(`npm pack did not produce ${abs}`);
  return {
    name: templateName,
    version: publishVersion,
    file,
    integrity: integrityOfFile(abs),
    shasum: shasumOfFile(abs),
    from: { pkg: upstream.pkg, version: upstream.version, integrity: upstream.integrity },
    patches,
    patchSha256: Object.fromEntries(patches.map((p) => [p, sha256OfFile(repoPath(p))])),
  };
}

/**
 * The version a target is published as: its "publishVersion" for a same-version re-release, else "version".
 * A re-release keeps major.minor and uses patch 100+n, so it sorts above every
 * upstream X.Y.z patch release and never collides with one.
 */
function checkPublishVersion(target) {
  const pv = target.publishVersion;
  if (!pv || pv === target.version) return target.version;
  const [maj, min] = target.version.split('.');
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(pv);
  if (!m || m[1] !== maj || m[2] !== min || Number(m[3]) < 100) {
    throw new Error(`${target.package}@${target.version}: publishVersion ${pv} must be ${maj}.${min}.<100 or more>`);
  }
  return pv;
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
    const publishVersion = checkPublishVersion(target);
    const label = publishVersion === target.version ? target.version : `${target.version} as ${publishVersion}`;
    const core = await step(`${target.package}@${label}: core`, async () => {
      const upstream = await fetchUpstream(target.package, target.version, { logFile });
      return buildOne({ templateName: `rebrowser-${target.package}`, upstream, version: target.version, publishVersion, patchesFrom, outDir });
    });
    artifacts.push({ ...core, kind: 'core', ...meta });

    if (target.wrapper) {
      const wrapper = await step(`${target.wrapper}@${label}: wrapper`, async () => {
        const upstream = await fetchUpstream(target.wrapper, target.version, { logFile });
        const coreJson = JSON.parse(await capture('tar', ['-xzOf', path.join(outDir, core.file), 'package/package.json']));
        return buildOne({ templateName: `rebrowser-${target.wrapper}`, upstream, version: target.version, publishVersion, patchesFrom, outDir, coreJson });
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
