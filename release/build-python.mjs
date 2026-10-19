#!/usr/bin/env node
// Build the rebrowser_playwright wheels from playwright-python + patches/playwright-python/<ver>/build.patch
// and a locally built rebrowser-playwright-core tarball.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, parse } from './lib/cli.mjs';
import { capture, log, run, step } from './lib/exec.mjs';
import { integrityOfFile, sha256OfFile } from './lib/integrity.mjs';
import { defaultOutDir, ensureDir, exists, freshDir, repoPath, rmrf, workPath } from './lib/paths.mjs';
import { writeSourceTars } from './lib/pysource.mjs';
import { loadVersions } from './lib/versions.mjs';

const usage = `Usage: node release/build-python.mjs <pyVersion> --driver-tgz <rebrowser-playwright-core-X.tgz> [--out <dir>] [--smoke]

Builds every wheel in playwright-python's setup.py 'base_wheel_bundles' for release/versions.json's
python target <pyVersion> (e.g. 1.64.0):
  1. fresh clone of the tag into <work>/py/playwright-python-<pyVersion>
  2. git apply patches/playwright-python/<pyVersion>/build.patch (setup.py / pyproject / build_driver.py / README)
  3. copy playwright/ -> rebrowser_playwright/ rewriting imports (same rules as the old fork) and
     write rebrowser_playwright/_repo_version.py
  4. one 'python -m build --wheel' per wheel, with REBROWSER_DRIVER_TGZ=<--driver-tgz>
  5. assert the exact wheel set, and per wheel: driver/package/lib/coreBundle.js is byte-identical to
     the tarball's, driver package.json version == DRIVER_VERSION, renamed package, metadata
Wheels, python-manifest.json and the source the wheels were built from (python-src.tar: the prepared tree;
python-orig.tar: the upstream tag) go to --out (default <work>/dist). The build venv lives in <work>/py/venv-build.
If the python target has a "publishVersion" (re-release of the same upstream tag, X.Y.100+n), the wheels are
versioned with it; the tag, build.patch and work paths stay keyed by <pyVersion>.
--smoke: also pip-install the wheel for this machine into a fresh venv and import rebrowser_playwright.`;

const { values: opt, positionals } = parse({
  usage,
  options: { 'driver-tgz': { type: 'string' }, out: { type: 'string' }, smoke: { type: 'boolean' } },
});
const [pyVersion] = positionals;
if (!pyVersion || positionals.length !== 1 || !opt['driver-tgz']) {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}

const logFile = workPath('logs', `build-python-${pyVersion}.log`);

// The import rewrites of the old fork's setup.py:prepare_rebrowser_sources(), in the same order.
const IMPORT_RULES = [
  [/= playwright\._impl/g, '= rebrowser_playwright._impl'],
  [/from playwright./g, 'from rebrowser_playwright.'],
  [/import playwright./g, 'import rebrowser_playwright.'],
  [/import playwright/g, 'import rebrowser_playwright as playwright'],
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function prepareSources(clone) {
  const from = path.join(clone, 'playwright');
  const to = path.join(clone, 'rebrowser_playwright');
  rmrf(to);
  fs.cpSync(from, to, { recursive: true, filter: (src) => path.basename(src) !== '__pycache__' });
  let changed = 0;
  for (const file of walk(to)) {
    if (!file.endsWith('.py')) continue;
    const content = fs.readFileSync(file, 'utf8');
    let next = content;
    for (const [re, replacement] of IMPORT_RULES) next = next.replace(re, replacement);
    if (next !== content) {
      fs.writeFileSync(file, next);
      changed++;
    }
  }
  fs.writeFileSync(path.join(to, '_repo_version.py'), `version = "${wheelVersion}"\n`);
  log(`rewrote imports in ${changed} python files`);
}

const hostWheelPart = () => {
  const arch = os.arch();
  if (process.platform === 'linux' && arch === 'arm64') return 'manylinux_2_17_aarch64';
  if (process.platform === 'linux' && arch === 'x64') return 'manylinux1_x86_64';
  return null;
};

let wheelVersion = pyVersion;

main(async () => {
  const entry = loadVersions().python.find((p) => p.version === pyVersion);
  if (!entry) throw new Error(`python ${pyVersion} is not listed in release/versions.json`);
  if (entry.publishVersion && entry.publishVersion !== pyVersion) {
    const [maj, min] = pyVersion.split('.');
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(entry.publishVersion);
    if (!m || m[1] !== maj || m[2] !== min || Number(m[3]) < 100) throw new Error(`python ${pyVersion}: publishVersion ${entry.publishVersion} must be ${maj}.${min}.<100 or more>`);
    wheelVersion = entry.publishVersion;
  }
  const driverTgz = path.resolve(opt['driver-tgz']);
  if (!exists(driverTgz)) throw new Error(`--driver-tgz ${driverTgz} does not exist`);
  const buildPatch = repoPath('patches', 'playwright-python', pyVersion, 'build.patch');
  if (!exists(buildPatch)) throw new Error(`missing ${buildPatch}`);
  const outDir = ensureDir(path.resolve(opt.out || defaultOutDir()));

  const pyRoot = workPath('py');
  const clone = path.join(pyRoot, `playwright-python-${pyVersion}`);
  const venv = path.join(pyRoot, 'venv-build');
  const py = path.join(venv, 'bin', 'python');
  const env = { PIP_DISABLE_PIP_VERSION_CHECK: '1' };

  await step('clone playwright-python', async () => {
    ensureDir(pyRoot);
    rmrf(clone);
    await run('git', ['clone', '-q', '--depth', '1', '--branch', entry.ref, `https://github.com/${entry.repo}.git`, clone], { logFile, echo: false });
  });

  const driverVersion = fs.readFileSync(path.join(clone, 'DRIVER_VERSION'), 'utf8').trim();
  if (driverVersion !== entry.driver.version) {
    throw new Error(`${entry.repo}@${entry.ref} pins DRIVER_VERSION ${driverVersion}, release/versions.json expects ${entry.driver.version}`);
  }
  const tgzMeta = await capture('tar', ['-xzOf', driverTgz, 'package/package.json']);
  const tgzPkg = JSON.parse(tgzMeta);
  if (tgzPkg.name !== 'rebrowser-playwright-core' || tgzPkg.version !== driverVersion) {
    throw new Error(`--driver-tgz contains ${tgzPkg.name}@${tgzPkg.version}, expected rebrowser-playwright-core@${driverVersion}`);
  }

  await step('apply build.patch', () => run('git', ['apply', '--whitespace=nowarn', buildPatch], { cwd: clone, logFile, echo: false }));
  if (wheelVersion !== pyVersion) {
    // re-release: build.patch pins the upstream version in pyproject.toml; publish under wheelVersion instead
    const pyproject = path.join(clone, 'pyproject.toml');
    const text = fs.readFileSync(pyproject, 'utf8');
    const pin = `version = "${pyVersion}"`;
    if (text.split(pin).length !== 2) throw new Error(`pyproject.toml should contain exactly one ${pin} after build.patch`);
    fs.writeFileSync(pyproject, text.replace(pin, `version = "${wheelVersion}"`));
    log(`re-release: wheels are versioned ${wheelVersion} (upstream ${pyVersion})`);
  }
  await step('prepare rebrowser_playwright sources', async () => prepareSources(clone));

  await step('build venv', async () => {
    if (!exists(py)) await run('python3', ['-m', 'venv', venv], { logFile, echo: false });
    const pin = fs.readFileSync(path.join(clone, 'local-requirements.txt'), 'utf8').split('\n').find((l) => l.startsWith('build=='));
    if (!pin) throw new Error('no build== pin in local-requirements.txt');
    await run(py, ['-m', 'pip', 'install', '-q', pin.trim()], { env, logFile, echo: false });
  });

  const wheelList = (await capture(py, ['setup.py', '--list-wheels'], { cwd: clone })).split('\n').filter(Boolean);
  if (wheelList.length === 0) throw new Error('setup.py --list-wheels printed nothing');
  const expected = wheelList.map((w) => `rebrowser_playwright-${wheelVersion}-py3-none-${w}`).sort();
  log(`building ${wheelList.length} wheels: ${wheelList.join(', ')}`);

  const dist = path.join(clone, 'dist');
  rmrf(dist);
  for (const wheel of wheelList) {
    await step(`wheel ${wheel}`, async () => {
      // keep driver/ (downloaded bundles are reused across wheels); drop everything else a previous wheel left
      rmrf(path.join(clone, 'build'));
      rmrf(path.join(clone, 'rebrowser_playwright', 'driver'));
      for (const e of fs.readdirSync(clone).filter((f) => f.endsWith('.egg-info'))) rmrf(path.join(clone, e));
      await run(py, ['-m', 'build', '--wheel', '--outdir', dist], {
        cwd: clone,
        env: { ...env, PLAYWRIGHT_TARGET_WHEEL: wheel, REBROWSER_DRIVER_TGZ: driverTgz },
        logFile,
        echo: false,
      });
    });
  }

  // ---- assertions
  const built = fs.readdirSync(dist).filter((f) => f.endsWith('.whl')).sort();
  const missing = expected.filter((w) => !built.some((b) => b === `${w}`));
  const extra = built.filter((b) => !expected.includes(b));
  if (missing.length || extra.length || built.length !== expected.length) {
    throw new Error(`wheel set mismatch.\n  expected: ${expected.join('\n            ')}\n  built:    ${built.join('\n            ')}\n  missing: ${missing}\n  extra: ${extra}`);
  }
  log(`wheel set OK: ${built.length} wheels`);

  const tmpExtract = freshDir(workPath('py', `driver-tgz-${pyVersion}`));
  await run('tar', ['-xzpf', driverTgz, '-C', tmpExtract, 'package/lib/coreBundle.js'], { echo: false });
  const coreBundle = path.join(tmpExtract, 'package', 'lib', 'coreBundle.js');
  const reports = [];
  for (const file of built) {
    const { stdout } = await run('python3', [repoPath('release', 'lib', 'check_wheel.py'), path.join(dist, file), coreBundle, driverVersion, wheelVersion], {
      capture: true,
      echo: false,
    });
    reports.push(JSON.parse(stdout.trim().split('\n').pop()));
    log(`  ok  ${file}`);
  }
  rmrf(tmpExtract);

  // ---- publish to --out
  const wheels = [];
  for (const file of built) {
    fs.copyFileSync(path.join(dist, file), path.join(outDir, file));
    wheels.push({ file, sha256: sha256OfFile(path.join(outDir, file)), size: fs.statSync(path.join(outDir, file)).size });
  }
  await step('save the source tree for the mirror', () => writeSourceTars(clone, outDir));
  const manifest = {
    distribution: entry.distribution,
    version: wheelVersion,
    source: { repo: entry.repo, ref: entry.ref, commit: await capture('git', ['rev-parse', 'HEAD'], { cwd: clone }) },
    driver: { package: 'rebrowser-playwright-core', version: driverVersion, tgzIntegrity: integrityOfFile(driverTgz) },
    buildPatch: { path: path.relative(repoPath(), buildPatch), sha256: sha256OfFile(buildPatch) },
    wheels,
  };
  fs.writeFileSync(path.join(outDir, 'python-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  if (opt.smoke) {
    const part = hostWheelPart();
    const wheel = built.find((b) => part && b.includes(part));
    if (!wheel) throw new Error(`--smoke: no wheel for this machine (${process.platform}/${os.arch()})`);
    await step(`smoke: install ${wheel} in a fresh venv`, async () => {
      const sv = freshDir(workPath('py', `venv-smoke-${pyVersion}`));
      await run('python3', ['-m', 'venv', sv], { logFile, echo: false });
      const spy = path.join(sv, 'bin', 'python');
      await run(spy, ['-m', 'pip', 'install', '-q', path.join(outDir, wheel)], { env, logFile, echo: false });
      await run(spy, ['-c', 'import importlib.metadata as m, rebrowser_playwright, rebrowser_playwright.sync_api; print("import ok", m.version("rebrowser-playwright"))'], { cwd: os.tmpdir() });
    });
  }

  log(`build-python: ${built.length} wheels for rebrowser-playwright ${wheelVersion} (driver ${driverVersion}) in ${outDir}`);
});
