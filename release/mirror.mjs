#!/usr/bin/env node
/**
 * Mirror each release to its drop-in GitHub repo (github.com/rebrowser/<repo>) as a per-version branch,
 * so the source repos stay browsable and show exactly what was changed:
 *   commit 1  "<upstream> <version> original"            the unmodified upstream package / source
 *   commit 2  "<repo> <version> patched with rebrowser-patches"   what was published
 * GitHub's diff of commit 2 is our change. Existing branches are never touched or force-pushed.
 *
 * npm drop-ins (rebrowser-puppeteer[-core], rebrowser-playwright[-core]): original = the upstream npm
 * tarball, patched = our built tarball from the manifest. Python (rebrowser-playwright-python):
 * original = the playwright-python tag, patched = the prepared source tree that build-python.mjs
 * built the wheels from (<work>/py/playwright-python-<version>, override with --python-src).
 *
 *   node release/mirror.mjs --manifest <dir|file> [--python-src <dir>] [--no-default-branch] [--yes]
 *   node release/mirror.mjs --default-branch-only [--yes]
 *
 * Without --yes it builds the branches locally (under <work>/mirror) and prints them, pushing nothing.
 * After pushing, each repo's default branch is moved to its highest version branch, so the repo page shows the
 * latest release (never moved backwards when an older release is mirrored). That needs the token to have
 * "Administration: write" on the repo (and the account to be a repo admin); without it a warning is printed and
 * the mirror still succeeds. --default-branch-only does just that step for all five repos.
 * Auth: WEB_GITHUB_TOKEN (or GH_TOKEN), used only in the push URL, never written to git config.
 */
import fs from 'node:fs';
import path from 'node:path';
import { main, parse } from './lib/cli.mjs';
import { run, capture, log, step } from './lib/exec.mjs';
import { fetchUpstream } from './lib/npm.mjs';
import { workPath, freshDir } from './lib/paths.mjs';
import { loadVersions } from './lib/versions.mjs';
import { compareVersions } from './lib/semver.mjs';

const ORG = 'rebrowser';
const MIRROR_REPOS = ['rebrowser-puppeteer-core', 'rebrowser-puppeteer', 'rebrowser-playwright-core', 'rebrowser-playwright', 'rebrowser-playwright-python'];
const NOT_MIRRORED = new Set(['rebrowser-patches']); // the CLI lives in this repo
const GIT_ID = ['-c', 'user.name=rebrowsernet', '-c', 'user.email=177570262+rebrowsernet@users.noreply.github.com'];

const token = () => process.env.WEB_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const authUrl = (repo) => `https://x-access-token:${token()}@github.com/${ORG}/${repo}.git`;

function loadManifest(p) {
  const file = fs.statSync(p).isDirectory() ? path.join(p, 'manifest.json') : p;
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  m.__dir = path.dirname(file);
  return m;
}

async function remoteBranchExists(repo, branch) {
  const out = await capture('git', ['ls-remote', '--heads', authUrl(repo), branch]).catch(() => '');
  return out.includes(`refs/heads/${branch}`);
}

/** Replace everything in the stage (except .git) with `fill(stage)`, then commit it. */
async function commitTree(stage, message, fill) {
  for (const entry of fs.readdirSync(stage)) if (entry !== '.git') fs.rmSync(path.join(stage, entry), { recursive: true, force: true });
  await fill(stage);
  await run('git', ['add', '-A'], { cwd: stage, echo: false });
  await run('git', [...GIT_ID, 'commit', '-q', '--allow-empty', '-m', message], { cwd: stage, echo: false });
}

const extractTgz = (tgz) => async (dest) => run('tar', ['xzf', tgz, '-C', dest, '--strip-components=1'], { echo: false });
const copyFiles = (srcDir, files) => async (dest) => {
  for (const f of files) {
    const to = path.join(dest, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(srcDir, f), to);
    fs.chmodSync(to, fs.statSync(path.join(srcDir, f)).mode);
  }
};

async function buildBranch({ repo, branch, original, patched }) {
  const stage = freshDir(workPath('mirror', `${repo}@${branch}`));
  await run('git', ['init', '-q', '-b', branch], { cwd: stage, echo: false });
  await commitTree(stage, original.message, original.fill);
  await commitTree(stage, patched.message, patched.fill);
  const stat = (await capture('git', ['diff', '--shortstat', 'HEAD~1', 'HEAD'], { cwd: stage })).trim();
  return { stage, stat };
}

async function mirror({ repo, branch, original, patched }, doPush) {
  if (await remoteBranchExists(repo, branch)) {
    log(`  ${repo}#${branch} already exists on the remote — left untouched`);
    return 'exists';
  }
  const { stage, stat } = await buildBranch({ repo, branch, original, patched });
  log(`  ${repo}#${branch}: patched commit = ${stat || 'no changes'}${doPush ? '' : `  [dry run, built in ${stage}]`}`);
  if (!doPush) return 'would-push';
  await run('git', ['push', '-q', authUrl(repo), `HEAD:refs/heads/${branch}`], { cwd: stage });
  return 'pushed';
}

async function githubApi(method, url, body) {
  const r = await fetch(`https://api.github.com/repos/${ORG}/${url}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null, accepted: r.headers.get('x-accepted-github-permissions') };
}

const isRelease = (name) => /^\d+\.\d+\.\d+$/.test(name);

/** Point the repo's default branch at its highest version branch. Returns a short status string. */
async function setDefaultBranch(repo, doIt) {
  const branches = [];
  for (let page = 1; page < 20; page++) {
    const { status, json } = await githubApi('GET', `${repo}/branches?per_page=100&page=${page}`);
    if (status !== 200) throw new Error(`list branches of ${repo}: HTTP ${status} ${json?.message ?? ''}`);
    branches.push(...json.map((b) => b.name));
    if (json.length < 100) break;
  }
  const versions = branches.filter(isRelease).sort(compareVersions);
  const latest = versions.at(-1);
  if (!latest) return 'no version branch';
  const { json: info } = await githubApi('GET', repo);
  if (info.default_branch === latest) return `default branch already ${latest}`;
  if (!doIt) return `would set default branch ${info.default_branch} -> ${latest} (dry run)`;
  const { status, json, accepted } = await githubApi('PATCH', repo, { default_branch: latest });
  if (status === 200 && json.default_branch === latest) return `default branch ${info.default_branch} -> ${latest}`;
  if (status === 403 || status === 404) {
    log(`WARNING: cannot change the default branch of ${ORG}/${repo} (HTTP ${status}${accepted ? `, needs ${accepted}` : ''}). Give the token "Administration: write" on it and make its account a repo admin, then run: node release/mirror.mjs --default-branch-only --yes`);
    return `default branch NOT changed (${info.default_branch}; wanted ${latest})`;
  }
  throw new Error(`set default branch of ${repo}: HTTP ${status} ${json?.message ?? ''}`);
}

function npmJobs(manifest) {
  return manifest.artifacts
    .filter((a) => a.publish !== false && !NOT_MIRRORED.has(a.name))
    .map((a) => ({
      repo: a.name,
      branch: a.version,
      prepare: async () => {
        const up = await fetchUpstream(a.from.pkg, a.from.version);
        return {
          original: { message: `${a.from.pkg} ${a.from.version} original`, fill: async (dest) => fs.cpSync(up.dir, dest, { recursive: true }) },
          patched: { message: `${a.name} ${a.version} patched with rebrowser-patches`, fill: extractTgz(path.join(manifest.__dir, a.file)) },
        };
      },
    }));
}

function pythonJob(pySrc) {
  const py = loadVersions().python?.[0];
  if (!py) return null;
  const src = pySrc || workPath('py', `playwright-python-${py.version}`);
  const published = py.publishVersion || py.version; // a re-release gets its own branch
  return {
    repo: 'rebrowser-playwright-python',
    branch: published,
    prepare: async () => {
      if (!fs.existsSync(path.join(src, '.git'))) throw new Error(`no prepared playwright-python source at ${src}; run release/build-python.mjs first or pass --python-src`);
      const tag = (await capture('git', ['describe', '--tags', '--exact-match', 'HEAD'], { cwd: src }).catch(() => '')).trim();
      if (tag !== `v${py.version}`) throw new Error(`${src} HEAD is "${tag || 'untagged'}", expected v${py.version}`);
      const files = (await capture('git', ['ls-files', '-c', '-o', '--exclude-standard'], { cwd: src }))
        .split('\n').filter(Boolean).filter((f) => !/\.egg-info\//.test(f));
      const archive = path.join(workPath('mirror'), `playwright-python-${py.version}-orig.tar`);
      fs.mkdirSync(path.dirname(archive), { recursive: true });
      await run('git', ['archive', '-o', archive, 'HEAD'], { cwd: src, echo: false });
      return {
        original: { message: `playwright-python ${py.version} original`, fill: async (dest) => run('tar', ['xf', archive, '-C', dest], { echo: false }) },
        patched: { message: `rebrowser-playwright ${published} patched with rebrowser-patches`, fill: copyFiles(src, files) },
      };
    },
  };
}

main(async () => {
  const { values } = parse({
    usage: 'mirror.mjs --manifest <dir|file> [--python-src <dir>] [--no-python] [--no-default-branch] [--yes]\n       mirror.mjs --default-branch-only [--yes]',
    options: { manifest: { type: 'string' }, 'python-src': { type: 'string' }, 'no-python': { type: 'boolean' }, 'no-default-branch': { type: 'boolean' }, 'default-branch-only': { type: 'boolean' }, yes: { type: 'boolean' } },
  });
  if (!token()) throw new Error('WEB_GITHUB_TOKEN (or GH_TOKEN) is required');
  if (values['default-branch-only']) {
    for (const repo of MIRROR_REPOS) log(`${repo}: ${await setDefaultBranch(repo, !!values.yes)}`);
    return;
  }
  if (!values.manifest) throw new Error('--manifest is required');
  const jobs = npmJobs(loadManifest(values.manifest));
  if (!values['no-python']) { const pj = pythonJob(values['python-src']); if (pj) jobs.push(pj); }

  const results = [];
  for (const job of jobs) {
    await step(`${job.repo}#${job.branch}`, async () => {
      const { original, patched } = await job.prepare();
      results.push(await mirror({ repo: job.repo, branch: job.branch, original, patched }, !!values.yes));
    });
  }
  const n = (r) => results.filter((x) => x === r).length;
  log(`mirror: ${n('pushed')} pushed, ${n('exists')} already present${values.yes ? '' : `, ${n('would-push')} pending (dry run)`}`);
  if (!values['no-default-branch']) {
    for (const repo of [...new Set(jobs.map((j) => j.repo))]) log(`${repo}: ${await setDefaultBranch(repo, !!values.yes)}`);
  }
});
