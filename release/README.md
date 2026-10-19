# release/ - build, test and publish tooling

These scripts build the drop-in packages and the Python wheels from the upstream packages and the patches in `patches/`,
and publish them from GitHub Actions (`.github/workflows/release.yml`) with npm and PyPI trusted publishing. Node >= 22,
built-ins only. Work happens in `$REBROWSER_WORK_DIR` (default `~/.cache/rebrowser-patches`), never in the repo. Every
script has `--help`.

| Script | What it does |
|---|---|
| `check-upstream.mjs` | the versions in `versions.json` vs the latest upstream releases |
| `port.mjs` | rebases `src.patch` onto a new upstream version, builds the original and patched trees, regenerates `src.patch` / `lib.patch` and verifies them against the npm tarball |
| `build-packages.mjs` | npm tarball + patches + `templates/` -> the `rebrowser-*` tarballs, the CLI tarball and `manifest.json` |
| `build-python.mjs` | playwright-python + `patches/playwright-python/<ver>/build.patch` + the patched core -> the wheels, `python-manifest.json` and the source they were built from |
| `publish.mjs` | npm publish (idempotent; refuses a version npm already has with a different integrity) and `latest` rollback |
| `pypi-plan.mjs` | which wheels PyPI still needs: same contents are skipped, changed contents under a published version stop the release |
| `mirror.mjs` | per-version branches in the drop-in repos, built from what was published; `--check` verifies them |
| `doctor.mjs`, `ci-env.mjs` | preflight checks; the release targets as environment variables for CI |

`versions.json` lists the versions being built and the released history. Rebuilding a released version reproduces the
published npm tarballs. Unit tests: `node --test 'release/test/*.test.mjs'`.
