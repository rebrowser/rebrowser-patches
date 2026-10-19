# Releasing rebrowser-patches

How a release is made. Everything builds and tests from three inputs: an upstream version, the patches in
`patches/`, and the scripts in `release/`. Publishing happens only in GitHub Actions through npm/PyPI trusted
publishing (no publish tokens anywhere else).

Work happens in a scratch dir, never in the repo: set `REBROWSER_WORK_DIR` (default `~/.cache/rebrowser-patches`).

## 1. Preflight
```
node release/doctor.mjs            # toolchain, work dir, Chrome; add --release before a publish
node release/check-upstream.mjs    # current targets vs latest upstream, with the git ref to port onto
```
If `check-upstream` shows nothing new, stop — there is nothing to release.

## 2. Port each package with a new version
```
node release/port.mjs puppeteer-core  <newVersion> --from <oldVersion>
node release/port.mjs playwright-core <newVersion> --from <oldVersion>
```
`port.mjs` rebases our `src.patch`, builds the original and patched trees, checks the original build
matches the npm tarball, regenerates `src.patch`/`lib.patch` to `--out`, and verifies the npm tarball +
patches reproduce the patched build. On a conflict it stops and prints the worktree path; resolve the
conflict there, re-run with `--continue`. Review every hunk, then copy the regenerated patches into
`patches/<pkg>/<newVersion>/` and bump `release/versions.json` (and the README supported-versions line).
Also add `/patches/<pkg>/<newVersion>` to the `files` list in `package.json`: the npm package ships
only listed patch folders, and `build-packages.mjs` fails if that list doesn't match `versions.json`
(nothing build-only, like the Python driver patches, may ship).

Python follows the playwright-core version that `playwright-python`'s `DRIVER_VERSION` names (often a
beta). `check-upstream` prints it; add it as a `python-driver` target and `port.mjs` it the same way.

## 3. Build and test locally
```
node release/build-packages.mjs
node release/build-python.mjs <pyVersion> --driver-tgz <work>/dist/rebrowser-playwright-core-<driver>.tgz
node tests/run.mjs --pptr-core <tgz> --pptr <tgz> --pw-core <tgz> --pw <tgz> --py-wheel <whl> --out <work>/test-out
```
`tests/run.mjs` must exit 0. It fails if a positive control (unpatched upstream, or patch mode `0`) is
not detected, if a negative control is, if unpatched upstream fails any scenario, or if a patched build
regresses beyond `tests/baselines/`. Known, issue-linked failures (today only `alwaysIsolated` mode limits)
live in the baselines. The `nonchromium` suite (Playwright on Firefox + WebKit) is opt-in locally; CI installs
those browsers and runs it.

Then check that no version already on npm or PyPI would get different contents (a forgotten `publishVersion`
bump); versions that aren't published yet just show as pending:
```
node release/publish.mjs --manifest <work>/dist     # dry run: fails if npm has that version with another integrity
node release/pypi-plan.mjs <work>/dist               # fails if PyPI has that version with other contents
```

## 4. Review, then the PR
Review the `src.patch` delta against the previous release hunk by hunk (this is the code ~600k installs/month
run). Then push the branch and open the PR; CI (`.github/workflows/ci.yml`) runs the same build + tests on an
x64 runner.

## 5. Publish (CI)
Merge the PR, then push the tag:
```
git tag v<cliVersion> && git push origin v<cliVersion>
```
`.github/workflows/release.yml` builds, tests, then publishes in the `release` environment via OIDC:
npm (5 packages, cores before wrappers, idempotent — a re-run resumes), PyPI (the wheels), and a GitHub
Release. The python-driver core is embedded in the wheels and is not published to npm. PyPI gets only the wheels
it doesn't have yet (`release/pypi-plan.mjs`). Wait until every job of the run is green; a failed job can be
re-run, publishing resumes where it stopped.

## 6. Mirror the drop-in repos (after the release workflow is green)
```
GH_TOKEN=<token> node release/mirror.mjs --yes
```
Adds a per-version branch to each `rebrowser-<name>` repo: an "original" commit with the upstream package or
source, then a "patched" commit with what was published. npm content comes from the registry, Python content
from the release run's `python-source` artifact (the newest successful run for tag `v<cliVersion>`, or
`--run <id>`). Existing branches are compared with what was published and never rewritten. Then each repo's
default branch moves to its highest version branch. The token needs Contents, Workflows and Administration write
on the five repos. Running it again is safe: it only does what is still missing.

## 7. Verify and close out
Install from npm and PyPI into clean dirs and re-run `tests/run.mjs` against the published packages, and check
the mirrors:
```
GH_TOKEN=<token> node release/mirror.mjs --check   # fails unless every branch is mirrored and every default branch is the newest
```
Update the README supported-versions table (in the PR), list the issues this release fixes, and flag the
rebrowser.net docs page if its versions changed (that's a separate deploy).

## Re-release (same upstream version, urgent fixes only)
npm and PyPI never accept the same version twice, so a fix to an already published upstream version ships as
`X.Y.100+n` (25.14.100, then 25.14.101, ...). Set `"publishVersion"` on the target (and on the python entry) in
`release/versions.json`, bump `cliVersion` and the root `package.json`. Then follow steps 3–7 as usual.
- `build-packages.mjs` / `build-python.mjs` take the patches, the upstream tarballs and the git refs from `version`.
  They give the built packages, tarball and wheel names `publishVersion`, and the wrapper pins the core to it.
- `ci-env.mjs` exports `*_VERSION` (published) and `*_UPSTREAM` (upstream). The test runs need
  `--pptr-upstream/--pw-upstream/--py-upstream` set to the upstream versions, because the unpatched controls
  come from npm/PyPI.
- After that, the `X.Y` line is closed. `check-upstream.mjs` reports later upstream `X.Y.z` releases as "skip"
  (publishing one would move `latest` backwards); port the next minor instead.

## Rollback (rare)
- npm: run `release.yml` manually with action=rollback, a package and the previous version — it moves
  `latest` back via OIDC. It never unpublishes; `npm deprecate` of a bad version is done by hand (2FA).
- PyPI: yank the release in the pypi.org web UI.

## Modes and env vars (for reference)
`REBROWSER_PATCHES_RUNTIME_FIX_MODE` = `addBinding` (default) | `alwaysIsolated` | `enableDisable`
(not recommended, still calls Runtime.enable) | `0` (off). `REBROWSER_PATCHES_WEBDRIVER_FIX=0` disables
the navigator.webdriver fix and keeps the upstream launch switches (popup blocking, IPC flooding protection,
Playwright's storage partitioning). `REBROWSER_PATCHES_SOURCE_URL`, `REBROWSER_PATCHES_UTILITY_WORLD_NAME`,
`REBROWSER_PATCHES_DEBUG` as documented in the README.
