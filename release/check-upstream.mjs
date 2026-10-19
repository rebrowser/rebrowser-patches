#!/usr/bin/env node
// Compare the release targets in versions.json with the latest upstream versions.
import { main, parse } from './lib/cli.mjs';
import { fetchJson, fetchText, getTagMeta, getVersionMeta } from './lib/npm.mjs';
import { compareVersions } from './lib/semver.mjs';
import { loadVersions } from './lib/versions.mjs';

const usage = `Usage: node release/check-upstream.mjs [--json]

Prints, for puppeteer-core, playwright-core and playwright-python, the version this repo
targets (release/versions.json) next to the latest upstream version and the git ref to port
onto (npm gitHead; the release tag for playwright-python). For playwright-python it also
prints the DRIVER_VERSION it pins and whether a matching playwright-core python-driver
target exists. Exit code is 0 whatever the result, non-zero only if the network fails.

  --json   machine-readable output on stdout`;

const { values } = parse({ usage, options: { json: { type: 'boolean' } }, allowPositionals: false });

function currentOf(pkg) {
  const { targets, python } = loadVersions();
  if (pkg === 'playwright-python') return python[0] ?? null;
  return targets.find((t) => t.package === pkg && t.role === 'release') ?? null;
}

// After a re-release (publishVersion X.Y.100+n), later upstream X.Y.z patch versions are skipped: publishing one would
// put a lower version on `latest`. Port the next minor instead.
function statusOf(cmp, current, latestVersion) {
  if (cmp > 0 && current?.publishVersion && latestVersion.split('.').slice(0, 2).join('.') === current.version.split('.').slice(0, 2).join('.')) {
    return `skip (the ${current.version.split('.').slice(0, 2).join('.')} line is closed by the ${current.publishVersion} re-release)`;
  }
  return cmp > 0 ? 'NEW' : cmp === 0 ? 'up-to-date' : 'target-ahead-of-latest';
}

async function checkNpm(pkg) {
  const current = currentOf(pkg);
  const latest = await getTagMeta(pkg, 'latest');
  if (!latest) throw new Error(`npm has no ${pkg}@latest`);
  const cmp = current ? compareVersions(latest.version, current.version) : 1;
  return {
    package: pkg,
    current: current?.version ?? null,
    latest: latest.version,
    status: statusOf(cmp, current, latest.version),
    gitHead: latest.gitHead ?? null,
    ref: latest.gitHead ?? null,
    currentRef: current?.ref ?? null,
    integrity: latest.dist?.integrity ?? null,
  };
}

async function checkPython() {
  const current = currentOf('playwright-python');
  const pypi = await fetchJson('https://pypi.org/pypi/playwright/json');
  if (!pypi) throw new Error('PyPI has no playwright project');
  const latest = pypi.info.version;
  const driverText = await fetchText(`https://raw.githubusercontent.com/microsoft/playwright-python/v${latest}/DRIVER_VERSION`);
  if (driverText === null) throw new Error(`no DRIVER_VERSION at playwright-python v${latest}`);
  const driver = driverText.trim();
  const driverMeta = await getVersionMeta('playwright-core', driver);
  const { targets } = loadVersions();
  const driverTarget = targets.find((t) => t.package === 'playwright-core' && t.version === driver) ?? null;
  const cmp = current ? compareVersions(latest, current.version) : 1;
  return {
    package: 'playwright-python',
    current: current?.version ?? null,
    latest,
    status: statusOf(cmp, current, latest),
    ref: `v${latest}`,
    currentRef: current?.ref ?? null,
    driver: {
      version: driver,
      onNpm: Boolean(driverMeta),
      gitHead: driverMeta?.gitHead ?? null,
      ref: driverMeta?.gitHead ?? null,
      targetInVersionsJson: Boolean(driverTarget),
      currentDriver: current?.driver?.version ?? null,
    },
  };
}

main(async () => {
  const rows = [await checkNpm('puppeteer-core'), await checkNpm('playwright-core'), await checkPython()];
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ checkedAt: new Date().toISOString(), cliVersion: loadVersions().cliVersion, packages: rows }, null, 2)}\n`);
    return;
  }
  const lines = [];
  for (const r of rows) {
    lines.push(`${r.package.padEnd(18)} target ${String(r.current).padEnd(8)} latest ${r.latest.padEnd(8)} ${r.status}`);
    lines.push(`${' '.repeat(18)} port onto ref: ${r.ref ?? '(none)'}${r.package !== 'playwright-python' ? '  (npm gitHead)' : '  (release tag)'}`);
    if (r.driver) {
      const d = r.driver;
      lines.push(`${' '.repeat(18)} DRIVER_VERSION ${d.version}${d.onNpm ? '' : '  (NOT on npm!)'}  ref ${d.ref ?? '(no gitHead)'}`);
      lines.push(
        `${' '.repeat(18)} python-driver target in versions.json: ${d.targetInVersionsJson ? 'yes' : 'NO - add playwright-core@' + d.version + ' (role python-driver) before building python'}`,
      );
    }
  }
  const stale = rows.filter((r) => r.status === 'NEW');
  lines.push('');
  lines.push(stale.length ? `check-upstream: ${stale.length} package(s) with a newer upstream: ${stale.map((r) => r.package).join(', ')}` : 'check-upstream: nothing new upstream');
  process.stdout.write(`${lines.join('\n')}\n`);
});
