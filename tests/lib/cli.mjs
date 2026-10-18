import { parseArgs } from 'node:util'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

export const ALL_SUITES = ['detection', 'scenarios', 'webdriver', 'leaks', 'smoke', 'python', 'nonchromium']

export const HELP = `rebrowser-patches test harness

usage:
  node tests/run.mjs --pptr-core <tgz> [--pptr <tgz>] --pw-core <tgz> [--pw <tgz>] [--py-wheel <whl>]
                     [--chrome <path>] [--suites detection,scenarios,webdriver,smoke,python] --out <dir>

inputs (built artifacts; at least one of --pptr-core / --pw-core unless only the python suite runs):
  --pptr-core <tgz>   rebrowser-puppeteer-core tarball
  --pptr <tgz>        rebrowser-puppeteer wrapper tarball (needs --pptr-core)
  --pw-core <tgz>     rebrowser-playwright-core tarball
  --pw <tgz>          rebrowser-playwright wrapper tarball (needs --pw-core)
  --py-wheel <whl>    rebrowser_playwright wheel for this platform (enables the python suite)
  --pptr-upstream <v> upstream puppeteer-core version for the unpatched controls (default: the tarball's version)
  --pw-upstream <v>   upstream playwright-core version for the unpatched controls (default: the tarball's version)
  --py-upstream <v>   upstream PyPI playwright version for the python suite's controls (default: the wheel's version)
                      (the three --*-upstream options are needed for a re-release, whose version has no upstream twin)

options:
  --out <dir>         where results.json and summary.txt are written (required)
  --chrome <path>     Chrome binary to use. Default: linux-x64 Chrome for Testing stable (npx @puppeteer/browsers),
                      linux-arm64 the official Google arm64 .deb extracted with dpkg-deb -x. Cached under <work>/browsers.
  --suites <list>     comma separated subset of: ${ALL_SUITES.join(', ')}
                      (default: detection,scenarios,webdriver,leaks,smoke, plus python when --py-wheel is given;
                      nonchromium is opt-in and needs Playwright's firefox + webkit installed)
  --reps <n>          repetitions of every detection run (default 1)
  --keep              keep the throwaway project and temp dirs (debugging)
  -h, --help          show this help

environment:
  REBROWSER_WORK_DIR  work dir for the throwaway project and the browser cache (default ~/.cache/rebrowser-patches)
  PYTHON              python3 used for the python suite (default python3)

Browsers run headful; when DISPLAY is unset every browser command is wrapped in 'xvfb-run -a'. Profiles and TMPDIR
live in a short /tmp/rbm.XXXX dir (Chrome rejects long socket paths) that is removed at the end.

exit code: 0 only when every hard gate passed; 1 when a gate failed or a control proved the test itself broken;
2 on a setup/infrastructure error; 64 on a usage error.
`

export function parseCli(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        'pptr-core': { type: 'string' },
        pptr: { type: 'string' },
        'pw-core': { type: 'string' },
        pw: { type: 'string' },
        'py-wheel': { type: 'string' },
        'pptr-upstream': { type: 'string' },
        'pw-upstream': { type: 'string' },
        'py-upstream': { type: 'string' },
        chrome: { type: 'string' },
        suites: { type: 'string' },
        reps: { type: 'string' },
        out: { type: 'string' },
        keep: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    })
  } catch (e) {
    return { error: e.message }
  }
  const v = parsed.values
  if (v.help) return { help: true }
  const abs = p => (p ? path.resolve(p) : undefined)
  const args = {
    pptrCore: abs(v['pptr-core']),
    pptr: abs(v.pptr),
    pwCore: abs(v['pw-core']),
    pw: abs(v.pw),
    pyWheel: abs(v['py-wheel']),
    pptrUpstream: v['pptr-upstream'],
    pwUpstream: v['pw-upstream'],
    pyUpstream: v['py-upstream'],
    chrome: v.chrome,
    out: abs(v.out),
    reps: v.reps === undefined ? 1 : Number(v.reps),
    keep: !!v.keep,
  }
  if (!args.out) return { error: '--out <dir> is required' }
  if (args.pptr && !args.pptrCore) return { error: '--pptr needs --pptr-core (the wrapper is tested with that core injected)' }
  if (args.pw && !args.pwCore) return { error: '--pw needs --pw-core (the wrapper is tested with that core injected)' }
  if (!Number.isInteger(args.reps) || args.reps < 1) return { error: '--reps must be a positive integer' }
  for (const k of ['pptrCore', 'pptr', 'pwCore', 'pw', 'pyWheel']) {
    if (args[k] && !fs.existsSync(args[k])) return { error: `${args[k]} does not exist` }
  }
  const suites = v.suites ? v.suites.split(',').map(s => s.trim()).filter(Boolean) : [...ALL_SUITES.filter(s => s !== 'python' && s !== 'nonchromium'), ...(args.pyWheel ? ['python'] : [])]
  for (const s of suites) if (!ALL_SUITES.includes(s)) return { error: `unknown suite '${s}' (known: ${ALL_SUITES.join(', ')})` }
  if (suites.includes('python') && !args.pyWheel) return { error: 'the python suite needs --py-wheel <whl>' }
  if (!args.pptrCore && !args.pwCore && suites.some(s => s !== 'python')) return { error: 'give at least one of --pptr-core / --pw-core (only the python suite runs without them)' }
  args.suites = ALL_SUITES.filter(s => suites.includes(s)) // canonical order
  args.work = process.env.REBROWSER_WORK_DIR ? path.resolve(process.env.REBROWSER_WORK_DIR) : path.join(os.homedir(), '.cache', 'rebrowser-patches')
  return { args }
}
