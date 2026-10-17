#!/usr/bin/env node
/**
 * Publish the npm artifacts in a build manifest, idempotently and in dependency order.
 *
 * Designed to run from the `release.yml` GitHub Actions job with npm trusted publishing (OIDC): the
 * job has `id-token: write`, npm >= 11.5.1, and no token is needed or read here. Locally it refuses
 * to publish unless --yes is given AND an auth token is present, so a laptop run can't publish by
 * accident; the default is a dry run that only reports what it would do.
 *
 * Idempotent: for each artifact it checks the registry first. If that exact version is already
 * published with the same dist.integrity, it is skipped (so a re-run after a partial failure
 * resumes). If the version exists with a DIFFERENT integrity, it stops — never overwrites.
 *
 * Order: cores before their wrappers (a wrapper pins its core exactly), CLI last. Artifacts with
 * publish === false (e.g. the python-driver core) are never published here.
 *
 *   node release/publish.mjs --manifest <dir-or-manifest.json> [--yes] [--dry-run]
 *   node release/publish.mjs rollback --package <name> --to <version>   # move `latest` back (OIDC/local)
 */
import fs from 'node:fs';
import path from 'node:path';
import { main, parse } from './lib/cli.mjs';
import { run, log, step } from './lib/exec.mjs';
import { getVersionMeta, getTagMeta } from './lib/npm.mjs';
import { integrityOfFile } from './lib/integrity.mjs';

const PUBLISH_ORDER = ['rebrowser-puppeteer-core', 'rebrowser-puppeteer', 'rebrowser-playwright-core', 'rebrowser-playwright', 'rebrowser-patches'];

function loadManifest(p) {
  const file = fs.statSync(p).isDirectory() ? path.join(p, 'manifest.json') : p;
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.__dir = path.dirname(file);
  return manifest;
}

const inCI = () => !!process.env.GITHUB_ACTIONS;
// An explicit npm auth token in the environment (OIDC injects its own at publish time, so CI needs neither).
const hasToken = () => !!(process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN || process.env.npm_config__authToken);

async function alreadyPublished(name, version, integrity) {
  let meta;
  try {
    meta = await getVersionMeta(name, version);
  } catch (e) {
    if (/\b(404|Not Found|E404)\b/i.test(String(e.message))) return false;
    throw e;
  }
  // The npm registry returns HTTP 200 with a JSON `null` body (or a doc without a matching version)
  // for a version that doesn't exist yet — that is NOT "already published".
  if (!meta || meta.version !== version) return false;
  const existing = meta.dist?.integrity;
  if (existing && existing !== integrity) {
    throw new Error(`${name}@${version} is already on npm with a DIFFERENT integrity (${existing} != ${integrity}). Refusing to continue; bump the version.`);
  }
  return true;
}

async function publishManifest(args) {
  const manifest = loadManifest(args.manifest);
  const doPublish = args.yes && !args['dry-run'];
  if (doPublish && !inCI() && !hasToken()) {
    throw new Error('Refusing to publish locally without an npm auth token. In CI this uses OIDC; locally set a token or drop --yes for a dry run.');
  }
  const publishable = manifest.artifacts.filter((a) => a.publish !== false);
  const ordered = [...publishable].sort((a, b) => PUBLISH_ORDER.indexOf(a.name) - PUBLISH_ORDER.indexOf(b.name));
  const unknown = ordered.filter((a) => !PUBLISH_ORDER.includes(a.name));
  if (unknown.length) throw new Error(`manifest has artifacts with no defined publish order: ${unknown.map((a) => a.name).join(', ')}`);

  const done = [];
  for (const a of ordered) {
    const tgz = path.join(manifest.__dir, a.file);
    if (!fs.existsSync(tgz)) throw new Error(`missing tarball ${a.file}`);
    const integrity = integrityOfFile(tgz); // must match what we publish
    if (a.integrity && a.integrity !== integrity) throw new Error(`${a.file} changed since the manifest was written`);
    await step(`${a.name}@${a.version}`, async () => {
      if (await alreadyPublished(a.name, a.version, integrity)) {
        log(`  already on npm with matching integrity — skipped`);
        done.push({ ...a, result: 'skipped' });
        return;
      }
      const tag = a.npmTag || 'latest';
      if (!doPublish) {
        log(`  would publish (tag ${tag})${inCI() ? '' : ' [dry run]'}`);
        done.push({ ...a, result: 'would-publish' });
        return;
      }
      await run('npm', ['publish', tgz, '--access', 'public', '--tag', tag, '--provenance'], {});
      done.push({ ...a, result: 'published' });
    });
  }
  log(`publish: ${done.filter((d) => d.result === 'published').length} published, ${done.filter((d) => d.result === 'skipped').length} already present, ${done.filter((d) => d.result === 'would-publish').length} pending (dry run)`);
}

async function rollback(args) {
  const { package: name, to } = args;
  if (!name || !to) throw new Error('rollback needs --package and --to');
  const current = await getTagMeta(name, 'latest').then((m) => m.version).catch(() => '(unknown)');
  log(`${name}: latest is ${current}, moving it to ${to}`);
  const target = await getVersionMeta(name, to).catch(() => null);
  if (!target) throw new Error(`${name}@${to} is not published; cannot point latest at it`);
  if (!args.yes || args['dry-run']) { log('  dry run — pass --yes to apply'); return; }
  await run('npm', ['dist-tag', 'add', `${name}@${to}`, 'latest'], {});
  log(`  latest -> ${to}. Note: npm deprecate is not run here (no OIDC support); deprecate the bad version by hand if needed.`);
}

main(async () => {
  const sub = process.argv[2] === 'rollback' ? 'rollback' : 'publish';
  if (sub === 'rollback') {
    const { values } = parse({ usage: 'publish.mjs rollback --package <name> --to <version> [--yes]', options: { package: { type: 'string' }, to: { type: 'string' }, yes: { type: 'boolean' }, 'dry-run': { type: 'boolean' } }, args: process.argv.slice(3) });
    return rollback(values);
  }
  const { values } = parse({ usage: 'publish.mjs --manifest <dir|file> [--yes] [--dry-run]', options: { manifest: { type: 'string' }, yes: { type: 'boolean' }, 'dry-run': { type: 'boolean' } } });
  if (!values.manifest) throw new Error('--manifest is required');
  return publishManifest(values);
});
