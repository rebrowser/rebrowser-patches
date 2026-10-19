# release/ - release tooling

Node >= 22, built-ins only. Everything heavy happens in the work dir
`$REBROWSER_WORK_DIR` (default `~/.cache/rebrowser-patches`; clones, builds, tarballs, venvs - never in the
repo). Every script has `--help`, prints a one-line summary and exits non-zero on any failure.

| Script | What it does |
|---|---|
| `check-upstream.mjs [--json]` | per package: target in `versions.json` vs latest upstream (npm `latest` + `gitHead`; PyPI `playwright` + its `DRIVER_VERSION`) |
| `port.mjs <pkg> <ver> [--from V] [--ref R]` | shallow-fetch both refs, apply the old `src.patch`, cherry-pick onto the new ref (conflict: prints files + worktree, exit 2; resolve, `git add`, re-run with `--continue`), then install, type-check, clean-build original and patched, require original build == npm tarball, write `{src,lib}.patch` to `--out`, verify tarball + patches == patched build |
| `port.mjs <pkg> <ver> --regen [--write]` | same build + verify stage for a version whose `src.patch` already exists; compares with the repo's patches, `--write` overwrites them |
| `build-packages.mjs [--target pkg@ver]... [--out dir]` | npm tarball + patches + `templates/` transform -> `rebrowser-*` tarballs, the CLI tarball and `manifest.json` (no source build) |
| `build-python.mjs <pyVer> --driver-tgz <tgz> [--out dir] [--smoke]` | playwright-python tag + `patches/playwright-python/<pyVer>/build.patch` + the patched core tarball -> all wheels, with assertions, `python-manifest.json` |
| `publish.mjs`, `mirror.mjs`, `doctor.mjs` | CI publish, mirror sync, preflight (separate owner) |

Commands in order (one release):

```
node release/doctor.mjs
node release/check-upstream.mjs
node release/port.mjs puppeteer-core <new>                      # then re-run with --continue after conflicts
node release/port.mjs playwright-core <new>
node release/port.mjs playwright-core <python-driver-version> --from <new> --ref <gitHead>
cp -r <out>/<pkg>/<ver> patches/<pkg>/                          # port.mjs prints the exact command
node release/build-packages.mjs --out dist
node release/build-python.mjs <pyVer> --driver-tgz dist/rebrowser-playwright-core-<driver>.tgz --out dist
```

Current targets (puppeteer-core 25.14.0, playwright-core 1.64.1, python 1.64.0 with driver
playwright-core 1.64.0-beta-1791568591000, CLI 1.1.2; re-released as 25.14.101 / 1.64.101 / Python 1.64.101) and the
released history are in `versions.json`.

## versions.json schema

<!--
{
  "cliVersion": "1.1.0",                  // version of the rebrowser-patches CLI (root package.json must match)
  "targets": [                            // npm core packages the next release builds
    {
      "package": "puppeteer-core",        // upstream npm name; the drop-in is "rebrowser-" + package
      "version": "25.14.0",               // upstream version (patch dir, npm tarball, git ref)
      "publishVersion": "25.14.100",      // optional: published version of a re-release (X.Y.100+n), else = version
      "repo": "puppeteer/puppeteer",      // GitHub repo of the source
      "ref": "puppeteer-v25.14.0",        // tag or commit (npm gitHead) of that version
      "previous": "24.8.1",               // last released version (rollback target, default port baseline)
      "portFrom": "1.64.1",               // optional: port baseline when it is not `previous`
      "role": "release",                  // "release" | "python-driver" (embedded in wheels, never published)
      "wrapper": "puppeteer",             // optional: wrapper package built next to the core (same version)
      "publish": true,                    // false: build only
      "npmTag": "latest"
    }
  ],
  "python": [                             // playwright-python targets (build-python.mjs)
    {
      "package": "playwright-python", "version": "1.64.0", "repo": "microsoft/playwright-python",
      "ref": "v1.64.0", "previous": "1.52.0",
      "distribution": "rebrowser-playwright", "module": "rebrowser_playwright",
      "driver": { "package": "playwright-core", "version": "1.64.0-beta-..." }   // == the tag's DRIVER_VERSION
    }
  ],
  "released": [                           // history: same package/version/repo/ref keys, plus
    { "package": "...", "version": "...", "ref": "...",
      "npm" | "pypi": { "<published name>": "<published version>" }, "date": "YYYY-MM-DD" }
  ]
}
-->

`port.mjs` and `build-packages.mjs --target` look versions up in `targets` and `released`
(`--from` baselines and old rebuilds use `released`). `manifest.json` (build-packages):
`{ cliVersion, artifacts: [{ name, version, file, integrity (sha512, = npm dist.integrity), shasum,
from: { pkg, version, integrity }, patches: [repo paths], patchSha256: {path: sha256}, kind
(core|wrapper|cli), role, publish, npmTag }] }`.

## templates/

`<rebrowser-name>.json` is the code-free package.json transform: `set` (replaced in place: name,
description), `afterDescription` (removed from upstream, inserted right after `description` in this order:
keywords, contributors, repository, bugs), `patchFiles` (which `patches/<core>/<ver>/` files a core applies),
`rewrites` (`{ file, from, to }` string replacements, e.g. the wrapper's `install.mjs` self-import) and, for
wrappers, `replaceDependencies`: `{ "<upstream dep>": { "name": "<new dep>", "version": "{version}" } }`
(`{version}` = the exact package version). The core dependency is replaced in place by `rebrowser-<core>` at
that exact version under its real name, never as an npm alias (`"puppeteer-core": "npm:rebrowser-puppeteer-core@V"`):
next to a real `puppeteer@V` in the same project npm dedupes the alias to the unpatched upstream core (#74).
For every replaced dependency `build-packages.mjs` also renames each quoted module specifier of the core
(`'playwright-core'`, `"playwright-core/lib/x"`, `import()`, `require.resolve()`, `.d.ts` imports, and static
template literals in `` require(`...`) `` / `` require.resolve(`...`) `` / `` import(`...`) ``) to the new name
in the wrapper's `.js .cjs .mjs .ts` files (not `.map`, README, LICENSE or prose that only mentions the name). It
fails when no file changed, when the built core's `exports` does not export a subpath the wrapper loads, or
when, after the rewrite, a `require(` / `require.resolve(` / `import(` argument (same line) or an `import` / `export`
`from` clause still mentions the core name: `` `name/${x}` ``, `'name/' + x` and any other form it cannot rename. `<rebrowser-name>.README.md` is the banner prepended to the upstream README. Both come
from the 24.8.1 / 1.52.0 releases; rebuilding those versions reproduces the published tarballs file for file (only
difference: wrappers depend on the core under its real name pinned exactly, not on the published `~` alias, and their
code loads that name).

## Notes

- Container has `NODE_ENV=production`; the build steps override it. Puppeteer's monorepo is installed with
  `npx -y npm@11`. One port/regen at a time per upstream repo (lock file in `<work>/src/`); RAM is tight.
- `port.mjs` never writes into `patches/` unless `--regen --write`; it prints the `cp` command instead.
- `lib/` holds the shared helpers (exec with logs, registry/`npm pack`, unified-diff normalization, npm-style
  integrity); `lib/check_wheel.py` is the per-wheel assertion helper.

`build-packages.mjs` also checks the `rebrowser-patches` package contents (`release/lib/clipack.mjs`): it
must ship exactly `scripts/`, the metadata files, and `lib.patch` + `src.patch` for every puppeteer-core /
playwright-core version in `versions.json` `released` or a `publish: true` target. Build-only patches
(the Python driver beta, `patches/playwright-python/`) stay in git and never ship.
