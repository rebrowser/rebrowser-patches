#!/usr/bin/env node
// Print the current release targets from release/versions.json as KEY=VALUE lines, for GitHub
// Actions: `node release/ci-env.mjs >> "$GITHUB_ENV"`. Keeps workflow files free of version numbers.
//   PPTR_VERSION   version rebrowser-puppeteer(-core) is published as (tarball names)
//   PPTR_UPSTREAM  upstream puppeteer-core version it is built from (unpatched test controls)
//   PW_VERSION     version rebrowser-playwright(-core) is published as
//   PW_UPSTREAM    upstream playwright-core version it is built from
//   PY_VERSION     playwright-python version built as rebrowser-playwright (build-python.mjs argument)
//   PY_UPSTREAM    same as PY_VERSION; the unpatched PyPI playwright used as a test control
//   PY_DRIVER      playwright-core version embedded in the Python wheels
// VERSION and UPSTREAM differ only for a re-release ("publishVersion" in versions.json).
import { loadVersions } from './lib/versions.mjs';

const v = loadVersions();
const published = (pkg) => {
  const hits = v.targets.filter((t) => t.package === pkg && t.publish !== false);
  if (hits.length !== 1) throw new Error(`expected exactly one publishable ${pkg} target in versions.json, found ${hits.length}`);
  return hits[0];
};
const py = v.python?.[0];
if (!py) throw new Error('versions.json has no python target');

const pptr = published('puppeteer-core');
const pw = published('playwright-core');
const env = {
  PPTR_VERSION: pptr.publishVersion || pptr.version,
  PPTR_UPSTREAM: pptr.version,
  PW_VERSION: pw.publishVersion || pw.version,
  PW_UPSTREAM: pw.version,
  PY_VERSION: py.version,
  PY_UPSTREAM: py.version,
  PY_DRIVER: py.driver.version,
};
for (const [k, val] of Object.entries(env)) process.stdout.write(`${k}=${val}\n`);
