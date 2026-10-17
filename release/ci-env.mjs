#!/usr/bin/env node
// Print the current release targets from release/versions.json as KEY=VALUE lines, for GitHub
// Actions: `node release/ci-env.mjs >> "$GITHUB_ENV"`. Keeps workflow files free of version numbers.
//   PPTR_VERSION  puppeteer-core target published to npm
//   PW_VERSION    playwright-core target published to npm
//   PY_VERSION    playwright-python version built as rebrowser-playwright
//   PY_DRIVER     playwright-core version embedded in the Python wheels
import { loadVersions } from './lib/versions.mjs';

const v = loadVersions();
const published = (pkg) => {
  const hits = v.targets.filter((t) => t.package === pkg && t.publish !== false);
  if (hits.length !== 1) throw new Error(`expected exactly one publishable ${pkg} target in versions.json, found ${hits.length}`);
  return hits[0].version;
};
const py = v.python?.[0];
if (!py) throw new Error('versions.json has no python target');

const env = {
  PPTR_VERSION: published('puppeteer-core'),
  PW_VERSION: published('playwright-core'),
  PY_VERSION: py.version,
  PY_DRIVER: py.driver.version,
};
for (const [k, val] of Object.entries(env)) process.stdout.write(`${k}=${val}\n`);
