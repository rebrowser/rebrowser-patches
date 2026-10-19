#!/usr/bin/env node
/**
 * Preflight for a release run: check the toolchain, resources and credentials before porting/building.
 * Read-only. Exit 0 if every required check passes, 1 otherwise. --json for machine output.
 *
 *   node release/doctor.mjs [--release] [--json]
 *
 * --release also checks what the publish/mirror steps need (npm >= 11.5.1 for OIDC publish, a GitHub
 * token). Without it, only what porting + building + testing need.
 */
import fs from 'node:fs';
import os from 'node:os';
import { main, parse } from './lib/cli.mjs';
import { capture } from './lib/exec.mjs';
import { workDir, ensureDir } from './lib/paths.mjs';

const cmp = (a, b) => a.split('.').map(Number).reduce((acc, n, i) => acc || (n - (b.split('.').map(Number)[i] || 0)), 0);

async function ver(cmd, args = ['--version']) {
  try { const out = await capture(cmd, args); return out.trim().replace(/^v/, '').split(/\s+/).pop(); }
  catch { return null; }
}

async function collect(release) {
  const checks = [];
  const add = (name, ok, detail, required = true) => checks.push({ name, ok: !!ok, detail, required });

  const node = process.versions.node;
  add('node >= 22.12', cmp(node, '22.12.0') >= 0, `node ${node}`);
  const npm = await ver('npm');
  add('npm present', !!npm, `npm ${npm || 'not found'}`);
  add('git present', !!(await ver('git')), 'git');
  add('patch present', !!(await ver('patch', ['-v']).catch(() => null)) || !!(await capture('patch', ['--version']).then(() => '1').catch(() => null)), 'patch (GNU)');
  const py = await ver('python3');
  add('python3 present', !!py, `python3 ${py || 'not found'}`, release);
  add('python venv', !!(await capture('python3', ['-c', 'import venv, ensurepip']).then(() => 1).catch(() => null)), 'venv + ensurepip', release);

  // work dir writable
  let workOk = false; let workMsg = '';
  try { const d = workDir(); ensureDir(d); const probe = `${d}/.doctor-${process.pid}`; fs.writeFileSync(probe, 'x'); fs.rmSync(probe); workOk = true; workMsg = d; } catch (e) { workMsg = e.message; }
  add('work dir writable', workOk, workMsg);

  // free RAM (soft check — builds are heavy)
  const freeGb = os.freemem() / 1e9;
  add('free memory >= 1.5 GB', freeGb >= 1.5, `${freeGb.toFixed(1)} GB free`, false);

  // Chrome for the test suite: arm64 .deb path or @puppeteer/browsers both work; just note what's here.
  const chrome = process.env.REBROWSER_TEST_CHROME || null;
  add('Chrome for tests', true, chrome ? `REBROWSER_TEST_CHROME=${chrome}` : 'will be fetched by tests/lib/browsers.mjs', false);

  if (release) {
    add('npm >= 11.5.1 (OIDC publish)', npm && cmp(npm, '11.5.1') >= 0, `npm ${npm}`);
    add('npm >= 11.21 (OIDC dist-tag)', npm && cmp(npm, '11.21.0') >= 0, `npm ${npm}`, false);
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    add('GitHub token present', !!token, token ? 'env token set (not printed)' : 'set GH_TOKEN for push/mirror', true);
    if (token) {
      let who = null;
      try { const r = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}` } }); who = r.ok ? (await r.json()).login : `HTTP ${r.status}`; } catch (e) { who = e.message; }
      add('GitHub token valid', who && !/HTTP|Error/.test(String(who)), `login ${who}`);
    }
  }
  return checks;
}

main(async () => {
  const { values } = parse({ usage: 'doctor.mjs [--release] [--json]', options: { release: { type: 'boolean' }, json: { type: 'boolean' } } });
  const checks = await collect(values.release);
  const failed = checks.filter((c) => c.required && !c.ok);
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, checks }, null, 2)}\n`);
  } else {
    for (const c of checks) process.stdout.write(`${c.ok ? '✅' : c.required ? '❌' : '⚠️ '} ${c.name}${c.detail ? ` — ${c.detail}` : ''}${!c.required && !c.ok ? ' (optional)' : ''}\n`);
    process.stdout.write(failed.length === 0 ? '\ndoctor: all required checks passed\n' : `\ndoctor: ${failed.length} required check(s) failed\n`);
  }
  if (failed.length) process.exit(1);
});
