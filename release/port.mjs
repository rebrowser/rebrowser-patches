#!/usr/bin/env node
// Port our patches to a new upstream version (or regenerate them for a known one), build, verify.
import fs from 'node:fs';
import path from 'node:path';
import { main, parse, ExitError } from './lib/cli.mjs';
import { applyPatch, diffDirs, sameFile } from './lib/diff.mjs';
import { log, run, step } from './lib/exec.mjs';
import { copyTree, fetchUpstream, getVersionMeta } from './lib/npm.mjs';
import { sha256Of } from './lib/integrity.mjs';
import { ensureDir, exists, freshDir, repoPath, rmrf, safeName, workPath } from './lib/paths.mjs';
import { findEntry } from './lib/versions.mjs';

const usage = `Usage:
  node release/port.mjs <pkg> <toVersion> [--from <version>] [--ref <gitref>] [--from-ref <gitref>] [--out <dir>]
  node release/port.mjs <pkg> <toVersion> --continue [--out <dir>]
  node release/port.mjs <pkg> <version> --regen [--write] [--out <dir>]

<pkg> is puppeteer-core or playwright-core.

Port mode: shallow-fetches the --from ref (default: portFrom/previous of <toVersion> in release/versions.json)
and the target ref (default: versions.json, else the npm gitHead of <toVersion>) into
<work>/src/<repo>, applies patches/<pkg>/<from>/src.patch on the from-ref, commits it and
cherry-picks it onto the target ref. On conflict it prints the conflicted files and the
worktree path and exits 2; resolve + 'git add' them there, then re-run with --continue.
After a clean cherry-pick it installs deps, type-checks, clean-builds the original and the patched
tree, requires the original build to equal the npm tarball, writes src.patch and lib.patch to --out
and verifies that tarball + patches == the patched build.

--regen: skip the port; apply the repo's existing patches/<pkg>/<version>/src.patch on the
  version's ref and run the build + verify stage. Writes to --out and compares with the repo's
  patches (exit 1 if they differ); only --write overwrites patches/<pkg>/<version>/ in the repo.
--restart: discard an unfinished conflicted port in the work tree and start over.
--skip-typecheck: skip the playwright 'tsc --noEmit' step.
--out <dir>: where generated patches go (<out>/<pkg>/<version>/{src,lib}.patch),
  default <work>/out/patches.

Environment: REBROWSER_WORK_DIR (default ~/.cache/rebrowser-patches). One port/regen at a time per upstream repo.
Exit codes: 0 ok, 1 failure, 2 cherry-pick conflict (see output).`;

const { values: opt, positionals } = parse({
  usage,
  options: {
    from: { type: 'string' },
    ref: { type: 'string' },
    'from-ref': { type: 'string' },
    out: { type: 'string' },
    regen: { type: 'boolean' },
    write: { type: 'boolean' },
    continue: { type: 'boolean' },
    restart: { type: 'boolean' },
    'skip-typecheck': { type: 'boolean' },
  },
});

const PACKAGES = {
  'puppeteer-core': {
    repo: 'puppeteer/puppeteer',
    dirName: 'puppeteer',
    pkgDir: 'packages/puppeteer-core',
  },
  'playwright-core': {
    repo: 'microsoft/playwright',
    dirName: 'playwright',
    pkgDir: 'packages/playwright-core',
  },
};

const BUILD_ENV = {
  NODE_ENV: 'development', // NODE_ENV=production in the environment would make npm skip devDependencies
  PUPPETEER_SKIP_DOWNLOAD: '1',
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  CI: '1',
};
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'rebrowser-patches release tooling',
  GIT_AUTHOR_EMAIL: 'noreply@rebrowser.net',
  GIT_COMMITTER_NAME: 'rebrowser-patches release tooling',
  GIT_COMMITTER_EMAIL: 'noreply@rebrowser.net',
  GIT_EDITOR: 'true',
  GIT_TERMINAL_PROMPT: '0',
};
const GIT_FLAGS = ['-c', 'core.autocrlf=false', '-c', 'advice.detachedHead=false', '-c', 'commit.gpgsign=false', '-c', 'gc.auto=0'];

const [pkg, toVersion] = positionals;
if (!pkg || !toVersion || positionals.length !== 2) {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}
const cfg = PACKAGES[pkg];
if (!cfg) {
  process.stderr.write(`unsupported package "${pkg}" (expected one of ${Object.keys(PACKAGES).join(', ')})\n`);
  process.exit(2);
}
if (opt.regen && (opt.from || opt['from-ref'] || opt.continue)) {
  process.stderr.write('--regen cannot be combined with --from/--from-ref/--continue\n');
  process.exit(2);
}

const repoDir = workPath('src', cfg.dirName);
const logFile = workPath('logs', `port-${safeName(pkg)}-${safeName(toVersion)}.log`);
const stateFile = workPath('state', `port-${safeName(pkg)}-${safeName(toVersion)}.json`);
const buildRoot = workPath('build', `${safeName(pkg)}-${safeName(toVersion)}`);
const outRoot = path.resolve(opt.out || workPath('out', 'patches'));
const pkgAbs = path.join(repoDir, cfg.pkgDir);

const git = (args, o = {}) =>
  run('git', [...GIT_FLAGS, ...args], { cwd: repoDir, env: GIT_ENV, logFile, echo: false, ...o });
const gitOut = async (args, o = {}) => (await git(args, { capture: true, ...o })).stdout;
const gitTry = async (args) => {
  try {
    return (await gitOut(args)).trim();
  } catch {
    return '';
  }
};

// ---------------------------------------------------------------------------------------------
// Repo handling
// ---------------------------------------------------------------------------------------------

async function ensureRepo() {
  if (!exists(path.join(repoDir, '.git'))) {
    ensureDir(repoDir);
    await git(['init', '-q']);
    await git(['remote', 'add', 'origin', `https://github.com/${cfg.repo}.git`]);
  }
}

/** Resolve a tag/branch/sha to a commit sha, shallow-fetching it (depth 1) when not present yet. */
async function resolveRef(ref) {
  const key = `refs/rbp/${safeName(ref)}`;
  let sha = await gitTry(['rev-parse', '--verify', '-q', `${key}^{commit}`]);
  if (!sha) {
    await step(`fetch ${cfg.repo} ${ref}`, () => git(['fetch', '--depth', '1', '--no-tags', 'origin', ref]));
    sha = (await gitOut(['rev-parse', 'FETCH_HEAD^{commit}'])).trim();
    await git(['update-ref', key, sha]);
  }
  return sha;
}

async function resetTree() {
  await gitTry(['cherry-pick', '--abort']);
  await git(['reset', '--hard', '-q']);
  await git(['clean', '-fdq', '-e', 'node_modules']);
}

async function checkout(sha) {
  await resetTree();
  await git(['checkout', '-q', '--detach', sha]);
}

/** Apply a src.patch (paths a/src/...) under cfg.pkgDir and commit it. Returns the commit sha. */
async function applySrcPatchAndCommit(patchFile, message) {
  if (!exists(patchFile)) throw new Error(`missing ${patchFile}`);
  await git(['apply', '-p1', `--directory=${cfg.pkgDir}`, '--whitespace=nowarn', patchFile]);
  await git(['add', '-A', '--', `${cfg.pkgDir}/src`]);
  const dirty = (await gitOut(['status', '--porcelain', '--untracked-files=no'])).trim().split('\n').filter(Boolean);
  const outside = dirty.filter((l) => !l.slice(3).startsWith(`${cfg.pkgDir}/src/`));
  if (outside.length) throw new Error(`src.patch touched files outside ${cfg.pkgDir}/src:\n${outside.join('\n')}`);
  await git(['commit', '-q', '-m', message]);
  return (await gitOut(['rev-parse', 'HEAD'])).trim();
}

async function conflictedFiles() {
  return (await gitOut(['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
}

function writeState(state) {
  ensureDir(path.dirname(stateFile));
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function acquireLock() {
  const lock = workPath('src', `${cfg.dirName}.lock`);
  ensureDir(path.dirname(lock));
  if (exists(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive && pid !== process.pid) throw new Error(`another port.mjs (pid ${pid}) is using ${repoDir}`);
  }
  fs.writeFileSync(lock, String(process.pid));
  process.on('exit', () => rmrf(lock));
}

// ---------------------------------------------------------------------------------------------
// Dependencies, type-check, build
// ---------------------------------------------------------------------------------------------

async function installDeps() {
  const lockFile = path.join(repoDir, 'package-lock.json');
  const stamp = path.join(repoDir, 'node_modules', '.rbp-install-stamp');
  const want = sha256Of(`${fs.readFileSync(lockFile)}|${process.version}|${pkg}`);
  if (exists(stamp) && fs.readFileSync(stamp, 'utf8') === want) {
    log('deps: node_modules up to date (package-lock.json unchanged)');
    return;
  }
  await step('install dependencies', async () => {
    const o = { cwd: repoDir, env: BUILD_ENV, logFile, echo: false };
    if (pkg === 'puppeteer-core') {
      // the puppeteer monorepo needs npm 11
      await run('npx', ['-y', 'npm@11', 'ci', '--no-audit', '--no-fund', '--ignore-scripts', '--include=dev'], o);
      // the types build needs this eslint plugin
      await run('npm', ['run', 'prepare'], { ...o, cwd: path.join(repoDir, 'tools', 'eslint') });
    } else {
      await run('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], o);
    }
    fs.writeFileSync(stamp, want);
  });
}

async function typecheck() {
  if (pkg === 'puppeteer-core') {
    log('type-check: part of the puppeteer-core build (tsc -b), see build step');
    return;
  }
  if (opt['skip-typecheck']) {
    log('type-check: skipped (--skip-typecheck)');
    return;
  }
  await step('type-check (tsc --noEmit)', () =>
    run('npx', ['tsc', '-p', '.', '--noEmit'], {
      cwd: repoDir,
      env: { ...BUILD_ENV, NODE_OPTIONS: '--max-old-space-size=3072' },
      logFile,
      echo: false,
    }),
  );
}

/** Clean build of the current checkout; copy the outputs to <buildRoot>/<which>/lib. */
async function buildAndCopy(which) {
  const dest = path.join(buildRoot, which, 'lib');
  rmrf(path.join(buildRoot, which));
  ensureDir(path.join(buildRoot, which));
  await step(`clean build (${which})`, async () => {
    const o = { env: BUILD_ENV, logFile, echo: false };
    if (pkg === 'puppeteer-core') {
      rmrf(path.join(pkgAbs, 'lib'));
      rmrf(path.join(pkgAbs, '.wireit'));
      rmrf(path.join(repoDir, 'packages', 'browsers', 'tsconfig.tsbuildinfo')); // else `tsc -b` emits nothing
      await run('npm', ['run', 'build'], { ...o, cwd: pkgAbs });
    } else {
      rmrf(path.join(pkgAbs, 'lib', 'coreBundle.js'));
      rmrf(path.join(pkgAbs, 'lib', 'coreBundle.js.txt'));
      await run('node', ['utils/build/build.js'], { ...o, cwd: repoDir });
    }
  });
  if (!exists(path.join(pkgAbs, 'lib'))) throw new Error(`build produced no ${cfg.pkgDir}/lib`);
  await copyTree(path.join(pkgAbs, 'lib'), dest);
  return dest;
}

// ---------------------------------------------------------------------------------------------
// Compare / patch generation / verification
// ---------------------------------------------------------------------------------------------

const LIB_EXCLUDES = ['*.map', '*.tsbuildinfo', '*.test.*'];
const excludeArgs = LIB_EXCLUDES.flatMap((x) => ['-x', x]);

/** `diff -rq`; returns the list of differing lines (empty if identical). */
async function diffTreeLines(a, b, extra = []) {
  const { stdout } = await run('diff', ['-rq', ...extra, a, b], { okCodes: [0, 1], capture: true, echo: false });
  return stdout.split('\n').filter(Boolean);
}

async function checkOrigEqualsNpm(upstream, origLib) {
  if (pkg === 'puppeteer-core') {
    const lines = await diffTreeLines(path.join(upstream.dir, 'lib'), origLib, excludeArgs);
    if (lines.length) {
      throw new Error(
        `original build differs from the npm tarball ${pkg}@${toVersion} (${lines.length} difference(s)):\n${lines.slice(0, 15).join('\n')}`,
      );
    }
    log(`check: original build lib/ == npm tarball ${pkg}@${toVersion} lib/ (excluding map/tsbuildinfo/test files)`);
  } else {
    const a = path.join(upstream.dir, 'lib', 'coreBundle.js');
    const b = path.join(origLib, 'coreBundle.js');
    if (!sameFile(a, b)) throw new Error(`original lib/coreBundle.js differs from the npm tarball ${pkg}@${toVersion}`);
    log(`check: original build lib/coreBundle.js == npm tarball ${pkg}@${toVersion}`);
  }
}

async function makeLibPatch(origLib, patchedLib) {
  if (pkg === 'puppeteer-core') return diffDirs(origLib, patchedLib, { prefix: 'lib', excludes: LIB_EXCLUDES });
  // playwright-core: all of our changes land in lib/coreBundle.js. Anything else that differs
  // between the original and the patched build (apart from the vite assets and the non-shipped
  // *.txt size reports) would be silently missing from lib.patch, so fail on it.
  const lines = await diffTreeLines(origLib, patchedLib, ['-x', 'vite', '-x', '*.txt', '-x', 'coreBundle.js']);
  if (lines.length) throw new Error(`patched build differs from the original outside lib/coreBundle.js:\n${lines.join('\n')}`);
  const stage = (which, src) => {
    const dir = path.join(buildRoot, 'diff', which);
    freshDir(path.join(dir));
    fs.copyFileSync(path.join(src, 'coreBundle.js'), path.join(dir, 'coreBundle.js'));
    return dir;
  };
  return diffDirs(stage('orig', origLib), stage('patched', patchedLib), { prefix: 'lib', excludes: [] });
}

async function verify(upstream, srcPatchText, libPatchText, patchedLib) {
  const root = workPath('verify', `${safeName(pkg)}-${safeName(toVersion)}`);
  freshDir(root);
  const pkgCopy = path.join(root, 'package');
  await copyTree(upstream.dir, pkgCopy);
  const libPatchFile = path.join(root, 'lib.patch');
  const srcPatchFile = path.join(root, 'src.patch');
  fs.writeFileSync(libPatchFile, libPatchText);
  fs.writeFileSync(srcPatchFile, srcPatchText);
  await applyPatch(pkgCopy, libPatchFile, { logFile });
  if (pkg === 'puppeteer-core') {
    await applyPatch(pkgCopy, srcPatchFile, { logFile });
    const libLines = await diffTreeLines(path.join(pkgCopy, 'lib'), patchedLib, excludeArgs);
    if (libLines.length) throw new Error(`npm tarball + lib.patch != patched build:\n${libLines.slice(0, 15).join('\n')}`);
    // the tarball ships src/: it must equal the patched worktree for every file it contains
    const srcLines = (await diffTreeLines(path.join(pkgCopy, 'src'), path.join(pkgAbs, 'src'))).filter(
      (l) => !l.startsWith(`Only in ${path.join(pkgAbs, 'src')}`),
    );
    if (srcLines.length) throw new Error(`npm tarball + src.patch != patched src/:\n${srcLines.slice(0, 15).join('\n')}`);
    log('verify: npm tarball + lib.patch + src.patch == patched build (lib/ and src/)');
  } else {
    if (!sameFile(path.join(pkgCopy, 'lib', 'coreBundle.js'), path.join(patchedLib, 'coreBundle.js'))) {
      throw new Error('npm tarball + lib.patch != patched lib/coreBundle.js');
    }
    log('verify: npm tarball + lib.patch == patched lib/coreBundle.js');
  }
  rmrf(root);
}

// ---------------------------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------------------------

/** Everything after the patched commit exists in the work tree. */
async function finish({ toSha, patchedSha }) {
  const parent = (await gitOut(['rev-parse', `${patchedSha}^`])).trim();
  if (parent !== toSha) throw new Error(`patched commit ${patchedSha} is not a child of the target ref ${toSha}`);

  const srcPatchText = (
    await gitOut([
      'diff', '--no-color', '--no-ext-diff', '--no-renames', '--abbrev=7', '--src-prefix=a/', '--dst-prefix=b/',
      `--relative=${cfg.pkgDir}`, toSha, patchedSha, '--', `${cfg.pkgDir}/src`,
    ])
  );
  if (!srcPatchText) throw new Error('src.patch is empty: the patched commit has no changes under src/');

  const upstream = await step(`download npm ${pkg}@${toVersion}`, () => fetchUpstream(pkg, toVersion, { logFile }));

  await installDeps();
  await checkout(patchedSha);
  const patchedLib = await buildAndCopy('patched');
  await typecheck(); // after the build: playwright's tsc needs the src/generated/* files the build creates
  await checkout(toSha);
  const origLib = await buildAndCopy('orig');
  await checkout(patchedSha); // leave the work tree on the patched commit

  await checkOrigEqualsNpm(upstream, origLib);
  const libPatchText = await makeLibPatch(origLib, patchedLib);
  if (!libPatchText) throw new Error('lib.patch is empty: patched and original builds are identical');
  await verify(upstream, srcPatchText, libPatchText, patchedLib);

  const outDir = path.join(outRoot, pkg, toVersion);
  ensureDir(outDir);
  fs.writeFileSync(path.join(outDir, 'src.patch'), srcPatchText);
  fs.writeFileSync(path.join(outDir, 'lib.patch'), libPatchText);

  // compare with what is in the repo
  const repoDirForVersion = repoPath('patches', pkg, toVersion);
  const status = {};
  for (const name of ['src.patch', 'lib.patch']) {
    const mine = path.join(outDir, name);
    const theirs = path.join(repoDirForVersion, name);
    status[name] = !exists(theirs) ? 'new (not in repo)' : sameFile(mine, theirs) ? 'identical to repo' : 'DIFFERS from repo';
    log(`${name}: ${mine}  [${status[name]}]`);
  }
  const differs = Object.values(status).some((s) => s === 'DIFFERS from repo');

  if (opt.write) {
    ensureDir(repoDirForVersion);
    for (const name of ['src.patch', 'lib.patch']) fs.copyFileSync(path.join(outDir, name), path.join(repoDirForVersion, name));
    log(`wrote patches/${pkg}/${toVersion}/{src,lib}.patch into the repo (--write)`);
  } else if (!opt.regen) {
    log(`to install the new patches into the repo:\n  mkdir -p ${repoDirForVersion} && cp ${outDir}/src.patch ${outDir}/lib.patch ${repoDirForVersion}/`);
  }
  const summary = `port: ${pkg}@${toVersion} OK (orig build == npm, patches verified), patches in ${outDir}`;
  if (opt.regen && differs && !opt.write) {
    throw new Error(`${summary}\nbut the regenerated patch(es) differ from the repo's patches/${pkg}/${toVersion}/ (use --write to overwrite)`);
  }
  log(summary);
  rmrf(path.join(buildRoot, 'diff'));
}

async function regen() {
  const entry = findEntry(pkg, toVersion);
  const ref = opt.ref || entry?.ref || (await getVersionMeta(pkg, toVersion))?.gitHead;
  if (!ref) throw new Error(`no git ref for ${pkg}@${toVersion}: pass --ref`);
  const patch = repoPath('patches', pkg, toVersion, 'src.patch');
  if (!exists(patch)) throw new Error(`${patch} does not exist (use port mode to create it)`);
  await ensureRepo();
  const toSha = await resolveRef(ref);
  log(`regen ${pkg}@${toVersion} from ${ref} (${toSha})`);
  await checkout(toSha);
  const patchedSha = await applySrcPatchAndCommit(patch, `rebrowser-patches src (${toVersion})`);
  await finish({ toSha, patchedSha });
}

async function port() {
  const entry = findEntry(pkg, toVersion);
  const fromVersion = opt.from || entry?.portFrom || entry?.previous;
  if (!fromVersion) throw new Error(`no --from given and release/versions.json has no portFrom/previous for ${pkg}@${toVersion}`);
  const fromEntry = findEntry(pkg, fromVersion);
  const toRef = opt.ref || entry?.ref || (await getVersionMeta(pkg, toVersion))?.gitHead;
  const fromRef = opt['from-ref'] || fromEntry?.ref || (await getVersionMeta(pkg, fromVersion))?.gitHead;
  if (!toRef) throw new Error(`no git ref for ${pkg}@${toVersion}: pass --ref`);
  if (!fromRef) throw new Error(`no git ref for ${pkg}@${fromVersion}: pass --from-ref`);
  const patch = repoPath('patches', pkg, fromVersion, 'src.patch');
  if (!exists(patch)) throw new Error(`${patch} does not exist: there is no patch for ${pkg}@${fromVersion} to port`);

  await ensureRepo();
  if (exists(path.join(repoDir, '.git', 'CHERRY_PICK_HEAD')) && !opt.restart) {
    throw new ExitError(
      `an unfinished cherry-pick is in progress in ${repoDir}.\nResolve + 'git add' the conflicts and re-run with --continue, or pass --restart to discard it.`,
      2,
    );
  }
  const fromSha = await resolveRef(fromRef);
  const toSha = await resolveRef(toRef);
  log(`port ${pkg} ${fromVersion} (${fromRef}) -> ${toVersion} (${toRef} = ${toSha})`);

  await checkout(fromSha);
  const p0 = await applySrcPatchAndCommit(patch, `rebrowser-patches src (${fromVersion})`);
  await checkout(toSha);
  writeState({ pkg, toVersion, fromVersion, toSha, p0 });
  try {
    await git(['cherry-pick', p0]);
  } catch (err) {
    const files = await conflictedFiles();
    if (!files.length) throw err;
    throw conflictExit(files);
  }
  const patchedSha = (await gitOut(['rev-parse', 'HEAD'])).trim();
  log('cherry-pick applied cleanly');
  await finish({ toSha, patchedSha });
}

function conflictExit(files) {
  return new ExitError(
    [
      `CONFLICT: cherry-picking the ${pkg} patch onto the new version stopped with ${files.length} conflicted file(s):`,
      ...files.map((f) => `  ${path.join(repoDir, f)}`),
      '',
      `Worktree: ${repoDir}`,
      `Resolve the conflict markers there, then: git -C ${repoDir} add <files>`,
      `and resume with: node release/port.mjs ${pkg} ${toVersion} --continue`,
    ].join('\n'),
    2,
  );
}

async function resume() {
  if (!exists(stateFile)) throw new Error(`no saved port state at ${stateFile}; start with a normal port run`);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (!exists(path.join(repoDir, '.git', 'CHERRY_PICK_HEAD'))) {
    throw new Error(`no cherry-pick in progress in ${repoDir}; start over without --continue`);
  }
  const files = await conflictedFiles();
  if (files.length) throw conflictExit(files);
  const markers = (await gitTry(['diff', '--cached', '--check'])) || '';
  if (/leftover conflict marker/.test(markers)) throw new Error(`leftover conflict markers staged:\n${markers}`);
  await git(['cherry-pick', '--continue']);
  const patchedSha = (await gitOut(['rev-parse', 'HEAD'])).trim();
  log(`cherry-pick completed: ${patchedSha}`);
  await finish({ toSha: state.toSha, patchedSha });
}

main(async () => {
  acquireLock();
  if (opt.regen) await regen();
  else if (opt.continue) await resume();
  else await port();
});
