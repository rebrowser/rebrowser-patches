#!/usr/bin/env node
/**
 * Mirror each published release to its drop-in GitHub repo (github.com/rebrowser/<repo>) as a per-version branch,
 * so the source stays browsable and shows exactly what was changed:
 *   commit 1  "<upstream> <version> original"                         the unmodified upstream package / source
 *   commit 2  "<repo> <version> patched with rebrowser-patches"       what was published
 * GitHub's diff of commit 2 is our change.
 *
 *   node release/mirror.mjs [--run <id> | --python-source <dir>] [--no-python] [--no-default-branch] [--yes | --check]
 *   node release/mirror.mjs --default-branch-only [--yes]
 *
 * The packages are the current release in release/versions.json (targets with publish: true, and the python entry),
 * and the content is what was published:
 *  - npm (rebrowser-puppeteer[-core], rebrowser-playwright[-core]): patched = rebrowser-<name>@<version> from the
 *    registry, original = the upstream package; both checked against the registry's dist.integrity.
 *  - Python (rebrowser-playwright-python): the source tree the published wheels were built from, taken from the
 *    "python-source" artifact of the release.yml run (python-src.tar, python-orig.tar, python-manifest.json). That
 *    run's publish-pypi job must have succeeded and PyPI must list every wheel of the manifest. The patched commit
 *    leaves out upstream's repository tooling (pysource.mjs UPSTREAM_TOOLING); the original commit keeps it.
 *    --run defaults to the newest successful run for tag v<cliVersion>; --python-source <dir> reads the three files
 *    from a local build-python.mjs output dir instead.
 *
 * An existing branch is never rewritten: the trees of its two commits are compared with ours (for Python, without
 * the upstream tooling on both sides) and a mismatch is an error. Afterwards each repo's default branch is moved to
 * its highest version branch (never backwards), which needs admin on the repo.
 *
 * Without --yes nothing is pushed or changed. --check changes nothing either and exits 1 unless every branch is
 * already mirrored and every default branch is the newest version.
 * Auth: GH_TOKEN (or GITHUB_TOKEN), used only in request headers and the push URL, never written to git config.
 */
import fs from 'node:fs';
import path from 'node:path';
import { main, parse } from './lib/cli.mjs';
import { run, capture, log, step } from './lib/exec.mjs';
import { fetchJson, fetchUpstream, getVersionMeta } from './lib/npm.mjs';
import { workPath, freshDir, exists } from './lib/paths.mjs';
import { loadVersions } from './lib/versions.mjs';
import { compareVersions } from './lib/semver.mjs';
import { treeOf } from './lib/gittree.mjs';
import { ORIG_TAR, SRC_TAR, UPSTREAM_TOOLING } from './lib/pysource.mjs';

const ORG = 'rebrowser';
const SOURCE_REPO = 'rebrowser-patches';
const PYTHON_REPO = 'rebrowser-playwright-python';
const MIRROR_REPOS = ['rebrowser-puppeteer-core', 'rebrowser-puppeteer', 'rebrowser-playwright-core', 'rebrowser-playwright', PYTHON_REPO];
const GIT_ID = ['-c', 'user.name=rebrowsernet', '-c', 'user.email=177570262+rebrowsernet@users.noreply.github.com'];
const REGISTRY_WAIT_MS = 15 * 60_000; // a just-published version can take 5-10 minutes to appear

const token = () => process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const authUrl = (repo) => `https://x-access-token:${token()}@github.com/${ORG}/${repo}.git`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function githubApi(method, url, body) {
  const r = await fetch(`https://api.github.com/repos/${ORG}/${url}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: r.status, json, accepted: r.headers.get('x-accepted-github-permissions'), expires: r.headers.get('github-authentication-token-expiration') };
}

async function apiGet(url) {
  const { status, json } = await githubApi('GET', url);
  if (status !== 200) throw new Error(`GET ${url}: HTTP ${status} ${json?.message ?? ''}`);
  return json;
}

/** Retry `get` until it returns something, for up to `waitMs` (0 = one try). */
async function waitFor(label, get, waitMs) {
  const until = Date.now() + waitMs;
  for (;;) {
    const value = await get();
    if (value) return value;
    if (Date.now() >= until) return null;
    log(`  ${label} not available yet, retrying in 30s`);
    await sleep(30_000);
  }
}

// ---- building and comparing a version branch

/** Replace everything in the stage (except .git) with `fill(stage)`, then commit it. */
async function commitTree(stage, message, fill) {
  for (const entry of fs.readdirSync(stage)) if (entry !== '.git') fs.rmSync(path.join(stage, entry), { recursive: true, force: true });
  await fill(stage);
  await run('git', ['add', '-A'], { cwd: stage, echo: false });
  await run('git', [...GIT_ID, 'commit', '-q', '--allow-empty', '-m', message], { cwd: stage, echo: false });
}

const copyDir = (src) => async (dest) => run('cp', ['-a', `${src}/.`, dest], { echo: false });
const extractTar = (tar, { drop = [] } = {}) => async (dest) => {
  await run('tar', ['-xpf', tar, '-C', dest, '--no-same-owner'], { echo: false });
  for (const name of drop) fs.rmSync(path.join(dest, name), { recursive: true, force: true });
};

async function buildBranch({ repo, branch, original, patched }) {
  const stage = freshDir(workPath('mirror', `${repo}@${branch}`));
  await run('git', ['init', '-q', '-b', branch], { cwd: stage, echo: false });
  await commitTree(stage, original.message, original.fill);
  await commitTree(stage, patched.message, patched.fill);
  const stat = await capture('git', ['diff', '--shortstat', 'HEAD~1', 'HEAD'], { cwd: stage });
  return { stage, stat };
}

/** 'missing', 'match' or a description of the difference between the remote branch and the stage. */
async function compareWithRemote(stage, repo, branch, compareDrop) {
  const heads = await capture('git', ['ls-remote', '--heads', authUrl(repo), branch]);
  if (!heads.includes(`refs/heads/${branch}`)) return 'missing';
  await run('git', ['fetch', '-q', '--depth', '2', authUrl(repo), `refs/heads/${branch}`], { cwd: stage, echo: false });
  const diffs = [];
  if ((await treeOf(stage, 'FETCH_HEAD', { drop: compareDrop })) !== (await treeOf(stage, 'HEAD', { drop: compareDrop }))) diffs.push('patched tree');
  if ((await treeOf(stage, 'FETCH_HEAD~1')) !== (await treeOf(stage, 'HEAD~1'))) diffs.push('original tree');
  return diffs.length ? `differs (${diffs.join(', ')})` : 'match';
}

/** Build the branch, compare it with GitHub and push it if it's missing. Returns 'pushed' | 'would-push' | 'exists'. */
async function mirror(job, doPush) {
  const { original, patched } = await job.prepare();
  const { stage, stat } = await buildBranch({ repo: job.repo, branch: job.branch, original, patched });
  const state = await compareWithRemote(stage, job.repo, job.branch, job.compareDrop || []);
  if (state === 'match') {
    log(`  ${job.repo}#${job.branch}: already mirrored`);
    return 'exists';
  }
  if (state !== 'missing') throw new Error(`${job.repo}#${job.branch} exists on GitHub but ${state} from what was published; it is never rewritten, investigate`);
  log(`  ${job.repo}#${job.branch}: patched commit = ${stat || 'no changes'}${doPush ? '' : `  [not pushed, built in ${stage}]`}`);
  if (!doPush) return 'would-push';
  await run('git', ['push', '-q', authUrl(job.repo), `HEAD:refs/heads/${job.branch}`], { cwd: stage });
  return 'pushed';
}

// ---- default branch

const isRelease = (name) => /^\d+\.\d+\.\d+$/.test(name);

/** Point the repo's default branch at its highest version branch. Returns { ok, msg }. */
async function setDefaultBranch(repo, doIt) {
  const branches = [];
  for (let page = 1; page < 20; page++) {
    const json = await apiGet(`${repo}/branches?per_page=100&page=${page}`);
    branches.push(...json.map((b) => b.name));
    if (json.length < 100) break;
  }
  const latest = branches.filter(isRelease).sort(compareVersions).at(-1);
  if (!latest) return { ok: false, msg: 'no version branch' };
  const info = await apiGet(repo);
  if (info.default_branch === latest) return { ok: true, msg: `default branch already ${latest}` };
  if (!doIt) return { ok: null, msg: `would set default branch ${info.default_branch} -> ${latest}` };
  const { status, json, accepted } = await githubApi('PATCH', repo, { default_branch: latest });
  if (status === 200 && json?.default_branch === latest) return { ok: true, msg: `default branch ${info.default_branch} -> ${latest}` };
  return { ok: false, msg: `cannot set the default branch to ${latest} (HTTP ${status}${accepted ? `, needs ${accepted}` : ''}; the token needs "Administration: write" and its account admin on the repo)` };
}

// ---- what to mirror

function npmJobs({ wait }) {
  const jobs = [];
  for (const t of loadVersions().targets.filter((x) => x.publish === true)) {
    const version = t.publishVersion || t.version;
    for (const upstream of [t.package, t.wrapper].filter(Boolean)) {
      const name = `rebrowser-${upstream}`;
      jobs.push({
        repo: name,
        branch: version,
        prepare: async () => {
          const published = await waitFor(`${name}@${version} on npm`, () => getVersionMeta(name, version), wait ? REGISTRY_WAIT_MS : 0);
          if (!published) throw new Error(`${name}@${version} is not on npm (not published yet?)`);
          const pub = await fetchUpstream(name, version);
          const up = await fetchUpstream(upstream, t.version);
          return {
            original: { message: `${upstream} ${t.version} original`, fill: copyDir(up.dir) },
            patched: { message: `${name} ${version} patched with rebrowser-patches`, fill: copyDir(pub.dir) },
          };
        },
      });
    }
  }
  return jobs;
}

/** The newest successful release.yml run for tag v<cliVersion>. */
async function findReleaseRun() {
  const tag = `v${loadVersions().cliVersion}`;
  const json = await apiGet(`${SOURCE_REPO}/actions/workflows/release.yml/runs?event=push&status=success&per_page=50`);
  const hit = json.workflow_runs.find((r) => r.head_branch === tag);
  if (!hit) throw new Error(`no successful release.yml run for tag ${tag}; pass --run <id>`);
  return hit.id;
}

/** Download the run's python-source artifact (after checking that its PyPI publish succeeded). Returns the dir. */
async function downloadPythonSource(runId) {
  const runInfo = await apiGet(`${SOURCE_REPO}/actions/runs/${runId}`);
  if (!/(^|\/)release\.yml$/.test(runInfo.path || '')) throw new Error(`run ${runId} is ${runInfo.path}, not release.yml`);
  const jobs = await apiGet(`${SOURCE_REPO}/actions/runs/${runId}/jobs?per_page=100`);
  const pypi = jobs.jobs.find((j) => j.name === 'publish-pypi');
  if (pypi?.conclusion !== 'success') throw new Error(`run ${runId}: publish-pypi is ${pypi ? pypi.conclusion || pypi.status : 'missing'}, so its Python source is not known to be published`);
  const arts = await apiGet(`${SOURCE_REPO}/actions/runs/${runId}/artifacts?per_page=100`);
  const art = arts.artifacts.find((a) => a.name === 'python-source');
  if (!art) throw new Error(`run ${runId} has no python-source artifact`);
  if (art.expired) throw new Error(`run ${runId}: the python-source artifact has expired`);
  const dir = freshDir(workPath('mirror', `python-source-run-${runId}`));
  const res = await fetch(art.archive_download_url, { headers: { authorization: `Bearer ${token()}` } });
  if (!res.ok) throw new Error(`download python-source of run ${runId}: HTTP ${res.status}`);
  const zip = path.join(dir, 'python-source.zip');
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  await run('python3', ['-m', 'zipfile', '-e', zip, dir], { echo: false });
  fs.rmSync(zip);
  return dir;
}

function pythonJob({ runId, sourceDir, wait }) {
  const py = loadVersions().python?.[0];
  if (!py) return null;
  const version = py.publishVersion || py.version;
  return {
    repo: PYTHON_REPO,
    branch: version,
    compareDrop: UPSTREAM_TOOLING,
    prepare: async () => {
      const dir = sourceDir ? path.resolve(sourceDir) : await downloadPythonSource(runId ?? (await findReleaseRun()));
      for (const f of [SRC_TAR, ORIG_TAR, 'python-manifest.json']) if (!exists(path.join(dir, f))) throw new Error(`${dir} has no ${f}`);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'python-manifest.json'), 'utf8'));
      if (manifest.version !== version || manifest.source?.ref !== py.ref) {
        throw new Error(`python-source is ${manifest.distribution} ${manifest.version} from ${manifest.source?.ref}, expected ${version} from ${py.ref}`);
      }
      const want = manifest.wheels.map((w) => w.file);
      const listed = await waitFor(`${manifest.distribution} ${version} on PyPI`, async () => {
        const meta = await fetchJson(`https://pypi.org/pypi/${manifest.distribution}/${version}/json`);
        const files = new Set((meta?.urls || []).map((u) => u.filename));
        return want.every((f) => files.has(f)) ? files : null;
      }, wait ? REGISTRY_WAIT_MS : 0);
      if (!listed) throw new Error(`PyPI does not list all ${want.length} wheels of ${manifest.distribution} ${version} (not published yet?)`);
      const drop = UPSTREAM_TOOLING;
      return {
        original: { message: `playwright-python ${py.version} original`, fill: extractTar(path.join(dir, ORIG_TAR)) },
        patched: {
          message: `rebrowser-playwright ${version} patched with rebrowser-patches\n\nUpstream's repository tooling (CI, publishing, dependency updates and other development settings of\nmicrosoft/playwright-python) is left out: it isn't used to build these wheels.`,
          fill: extractTar(path.join(dir, SRC_TAR), { drop }),
        },
      };
    },
  };
}

// ---- main

main(async () => {
  const { values } = parse({
    usage: 'mirror.mjs [--run <id> | --python-source <dir>] [--no-python] [--no-default-branch] [--yes | --check]\n       mirror.mjs --default-branch-only [--yes]',
    options: {
      run: { type: 'string' },
      'python-source': { type: 'string' },
      'no-python': { type: 'boolean' },
      'no-default-branch': { type: 'boolean' },
      'default-branch-only': { type: 'boolean' },
      yes: { type: 'boolean' },
      check: { type: 'boolean' },
    },
  });
  if (!token()) throw new Error('GH_TOKEN (or GITHUB_TOKEN) is required');
  if (values.yes && values.check) throw new Error('--yes and --check exclude each other');
  const doIt = !!values.yes;
  const problems = [];

  const { expires } = await githubApi('GET', PYTHON_REPO);
  if (expires && new Date(expires).getTime() - Date.now() < 30 * 86_400_000) log(`WARNING: the GitHub token expires on ${expires}`);

  const repos = values['default-branch-only'] ? MIRROR_REPOS : [];
  if (!values['default-branch-only']) {
    const jobs = npmJobs({ wait: doIt });
    if (!values['no-python']) {
      const pj = pythonJob({ runId: values.run, sourceDir: values['python-source'], wait: doIt });
      if (pj) jobs.push(pj);
    }
    const results = [];
    for (const job of jobs) {
      try {
        results.push(await step(`${job.repo}#${job.branch}`, () => mirror(job, doIt)));
      } catch (err) {
        problems.push(`${job.repo}#${job.branch}: ${err.message}`);
      }
    }
    const n = (r) => results.filter((x) => x === r).length;
    log(`mirror: ${n('pushed')} pushed, ${n('exists')} already mirrored${doIt ? '' : `, ${n('would-push')} not pushed (dry run)`}`);
    if (values.check && n('would-push')) problems.push(`${n('would-push')} published version(s) not mirrored yet`);
    if (!values['no-default-branch']) repos.push(...new Set(jobs.map((j) => j.repo)));
  }

  for (const repo of repos) {
    const { ok, msg } = await setDefaultBranch(repo, doIt);
    log(`${repo}: ${msg}`);
    if (ok === false || (ok === null && values.check)) problems.push(`${repo}: ${msg}`);
  }

  if (problems.length) {
    log(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
  }
});
