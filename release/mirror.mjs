#!/usr/bin/env node
/**
 * Mirror each built drop-in package to its own GitHub repo as a per-version branch, so the source
 * repos (github.com/rebrowser/rebrowser-<name>) stay browsable and match what's on npm.
 *
 * For each publishable npm artifact it extracts the built tarball's package/ tree and pushes it as a
 * single commit on a branch named exactly the package version. Existing branches are never
 * force-pushed: if the remote already has that branch, it is left alone.
 *
 *   node release/mirror.mjs --manifest <dir|file> [--yes]
 *
 * Auth: WEB_GITHUB_TOKEN (or GH_TOKEN). The token is used only in the push URL and never written to
 * git config. Default is a dry run; --yes actually pushes. The CLI package (rebrowser-patches) is not
 * mirrored — it lives in this repo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { main, parse } from './lib/cli.mjs';
import { run, capture, log, step } from './lib/exec.mjs';
import { workPath, freshDir } from './lib/paths.mjs';

const ORG = 'rebrowser';
const NOT_MIRRORED = new Set(['rebrowser-patches']);

function loadManifest(p) {
  const file = fs.statSync(p).isDirectory() ? path.join(p, 'manifest.json') : p;
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  m.__dir = path.dirname(file);
  return m;
}

const token = () => process.env.WEB_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const authUrl = (repo) => `https://x-access-token:${token()}@github.com/${ORG}/${repo}.git`;

async function remoteBranchExists(repo, branch) {
  const out = await capture('git', ['ls-remote', '--heads', authUrl(repo), branch]).catch(() => '');
  return out.includes(`refs/heads/${branch}`);
}

async function mirrorOne(artifact, manifestDir, doPush) {
  const repo = artifact.name; // drop-in repo name == package name
  const branch = artifact.version;
  const tgz = path.join(manifestDir, artifact.file);
  if (!fs.existsSync(tgz)) throw new Error(`missing tarball ${artifact.file}`);

  if (await remoteBranchExists(repo, branch)) {
    log(`  ${repo}#${branch} already exists on the remote — leaving it untouched`);
    return { repo, branch, result: 'exists' };
  }
  if (!doPush) { log(`  would push ${repo}#${branch}`); return { repo, branch, result: 'would-push' }; }

  const stage = freshDir(workPath('mirror', `${repo}@${branch}`));
  await run('tar', ['xzf', tgz, '-C', stage, '--strip-components=1'], {});
  await run('git', ['init', '-q', '-b', branch], { cwd: stage });
  await run('git', ['add', '-A'], { cwd: stage });
  await run('git', ['-c', 'user.name=rebrowsernet', '-c', 'user.email=177570262+rebrowsernet@users.noreply.github.com',
    'commit', '-q', '-m', `${repo} ${branch} (patched with rebrowser-patches)`], { cwd: stage });
  await run('git', ['push', authUrl(repo), `HEAD:refs/heads/${branch}`], { cwd: stage });
  return { repo, branch, result: 'pushed' };
}

main(async () => {
  const { values } = parse({ usage: 'mirror.mjs --manifest <dir|file> [--yes]', options: { manifest: { type: 'string' }, yes: { type: 'boolean' } } });
  if (!values.manifest) throw new Error('--manifest is required');
  if (!token()) throw new Error('WEB_GITHUB_TOKEN (or GH_TOKEN) is required');
  const manifest = loadManifest(values.manifest);
  const toMirror = manifest.artifacts.filter((a) => a.publish !== false && !NOT_MIRRORED.has(a.name));
  const results = [];
  for (const a of toMirror) {
    await step(`${a.name}#${a.version}`, async () => { results.push(await mirrorOne(a, manifest.__dir, !!values.yes)); });
  }
  const by = (r) => results.filter((x) => x.result === r).length;
  log(`mirror: ${by('pushed')} pushed, ${by('exists')} already present, ${by('would-push')} pending (dry run)`);
});
