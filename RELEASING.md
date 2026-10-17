# Releasing rebrowser-patches

This is the monthly runbook. Everything builds and tests from three inputs: an upstream version, the
patches in `patches/`, and the scripts in `release/`. Publishing happens only in GitHub Actions through
npm/PyPI trusted publishing (no tokens in the repo or the dev container).

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
not detected, if a negative control is, if the unpatched scenarios aren't 22/22, or if a patched build
regresses beyond `tests/baselines/`. Known-inherent failures (#129 waitForFunction, #69 exposeFunction,
and isolated-mode limits) live in the baselines.

## 4. Second-model review, then the PR
Have a second model review the `src.patch` delta against the previous release (this is the code ~600k
installs/month run). Then, **only if this run's request says to release**, push the branch and open the
PR; CI (`.github/workflows/ci.yml`) runs the same build + tests on an x64 runner. Fix and re-push, up to
three rounds, then stop. If not releasing this run, stop here with the artifacts and hand the commands over.

## 5. Publish (CI)
Merge the PR, then push the tag:
```
git tag v<cliVersion> && git push origin v<cliVersion>
```
`.github/workflows/release.yml` builds, tests, then publishes in the `release` environment via OIDC:
npm (5 packages, cores before wrappers, idempotent — a re-run resumes), PyPI (the wheels), and a GitHub
Release. The python-driver core is embedded in the wheels and is not published to npm.

## 6. Mirror the drop-in repos (from the container, after publish)
```
node release/mirror.mjs --manifest <work>/dist --yes   # needs WEB_GITHUB_TOKEN
```
Pushes a per-version branch to each `rebrowser-<name>` repo. Existing branches are never force-pushed.

## 7. Verify and close out
Install from npm and PyPI into clean dirs and re-run `tests/run.mjs` against the published packages.
Update the README supported-versions table (in the PR), list the issues this release fixes, and flag the
rebrowser.net docs page if its versions changed (that's a separate deploy).

## Rollback (rare)
- npm: run `release.yml` manually with action=rollback, a package and the previous version — it moves
  `latest` back via OIDC. It never unpublishes; `npm deprecate` of a bad version is done by hand (2FA).
- PyPI: yank the release in the pypi.org web UI.

## Modes and env vars (for reference)
`REBROWSER_PATCHES_RUNTIME_FIX_MODE` = `addBinding` (default) | `alwaysIsolated` | `enableDisable`
(not recommended, still calls Runtime.enable) | `0` (off). `REBROWSER_PATCHES_WEBDRIVER_FIX=0` disables
the navigator.webdriver flag. `REBROWSER_PATCHES_SOURCE_URL`, `REBROWSER_PATCHES_UTILITY_WORLD_NAME`,
`REBROWSER_PATCHES_DEBUG` as documented in the README.
