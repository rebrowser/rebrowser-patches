// Suite "python": the rebrowser_playwright wheel, installed into a fresh venv, driven through sync_api.
//   detection: same oracle as the detection suite (tests/fixtures/poc2.html), library actively working on the page
//       negative control (clean):  plain Chrome without CDP
//       positive controls (detected): the unpatched `playwright` of the same version from PyPI; the patched wheel with
//                                     REBROWSER_PATCHES_RUNTIME_FIX_MODE=0
//       gates (clean):  patched default and alwaysIsolated
//   scenarios: three functional checks (evaluate, setContent, click + read) through the Python API; the unpatched
//       control must pass all of them, and so must the patched wheel in default and alwaysIsolated mode.
import fs from 'node:fs'
import path from 'node:path'
import { newSuite, table } from '../lib/report.mjs'
import { run as runCmd, lastJsonLine, tail } from '../lib/util.mjs'
import { runPlain } from '../lib/browserRuns.mjs'
import { TESTS_DIR } from '../lib/project.mjs'
import { isDetected } from './detection.mjs'

const MIN_ROUNDS = 20

export async function run(ctx) {
  const s = newSuite('python')
  const wheel = ctx.args.pyWheel
  const m = path.basename(wheel).match(/^([^-]+)-([^-]+)-/)
  if (!m) throw new Error(`cannot parse the wheel file name ${path.basename(wheel)}`)
  const [, dist, wheelVersion] = m
  // the unpatched control comes from PyPI: a re-release (e.g. 1.64.100) has no upstream twin, so --py-upstream names it
  const version = ctx.args.pyUpstream || wheelVersion
  const py = process.env.PYTHON || 'python3'
  const venv = path.join(ctx.runDir, 'venv')
  const vpy = process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python')
  const pipEnv = { PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONUNBUFFERED: '1' }

  let r = await runCmd(py, ['-m', 'venv', venv], { tmp: ctx.tmp, timeoutMs: 300000 })
  if (r.code !== 0) throw new Error(`python3 -m venv failed: ${tail(r.stderr || r.stdout)}`)
  r = await runCmd(vpy, ['-m', 'pip', 'install', '--quiet', wheel], { tmp: ctx.tmp, env: pipEnv, timeoutMs: 600000 })
  s.gate('wheel-installs', r.code === 0, r.code === 0 ? `${path.basename(wheel)} installed in a fresh venv` : tail(r.stderr || r.stdout, 600))
  if (r.code !== 0) return s.finish()
  const imp = await runCmd(vpy, ['-c', 'import rebrowser_playwright.sync_api'], { tmp: ctx.tmp, timeoutMs: 60000 })
  s.gate('wheel-imports', imp.code === 0, imp.code === 0 ? 'import rebrowser_playwright.sync_api ok' : tail(imp.stderr, 400))
  if (imp.code !== 0) return s.finish()
  const control = await runCmd(vpy, ['-m', 'pip', 'install', '--quiet', `playwright==${version}`], { tmp: ctx.tmp, env: pipEnv, timeoutMs: 600000 })
  // without the unpatched control there is no positive control, so the suite cannot be trusted
  s.gate('unpatched-control-installs', control.code === 0, control.code === 0 ? `playwright==${version} installed from PyPI` : `pip install playwright==${version}: ${tail(control.stderr || control.stdout, 400)}`, { broken: true })
  if (control.code !== 0) return s.finish()

  const worker = f => path.join(TESTS_DIR, 'workers', 'py', f)
  const detectWorker = (module, mode) => async tag => {
    const url = ctx.server.url('poc2.html', 'tag=' + encodeURIComponent(tag))
    const res = await runCmd(vpy, [worker('detect.py'), module, ctx.chrome.path, url], {
      cwd: ctx.runDir, display: true, tmp: ctx.tmp, env: { ...pipEnv, REBROWSER_PATCHES_RUNTIME_FIX_MODE: mode }, timeoutMs: 120000,
    })
    const report = await ctx.server.waitForReport(tag, 3000)
    if (res.code !== 0) return { ok: false, error: res.timedOut ? 'timed out' : tail(res.stderr || res.stdout, 400), report, ms: res.ms }
    if (!report) return { ok: false, error: 'no report from the probe page', ms: res.ms }
    return { ok: true, report, ms: res.ms }
  }

  const cfgs = [
    { id: 'plain-noCDP', role: 'negative-control', expect: 'clean', exec: tag => runPlain(ctx, tag) },
    { id: `py-unpatched-playwright==${version}`, role: 'positive-control', expect: 'detected', exec: detectWorker('playwright') },
    { id: 'py-patched-mode0', role: 'positive-control', expect: 'detected', exec: detectWorker('rebrowser_playwright', '0') },
    { id: 'py-patched-default', role: 'patched', expect: 'clean', exec: detectWorker('rebrowser_playwright') },
    { id: 'py-patched-alwaysIsolated', role: 'patched', expect: 'clean', exec: detectWorker('rebrowser_playwright', 'alwaysIsolated') },
  ]
  const detRows = []
  for (const c of cfgs) {
    const tag = `${c.id}.r1`
    const res = await c.exec(tag)
    const rep = res.report
    const rounds = rep?.rounds
    const ok = res.ok && rounds >= MIN_ROUNDS
    const detected = rep ? isDetected(rep) : null
    const pass = ok && (c.expect === 'detected' ? detected : !detected)
    const outcome = !ok ? 'RUN FAILED' : detected ? 'detected' : 'clean'
    ctx.log(`[python] detection ${c.id}: ${outcome}${rep ? ` (pST ${rep.prepareStackTrace}, name/round ${rep.namePerRound})` : ''}${res.error ? ' ' + String(res.error).split('\n')[0] : ''}`)
    s.rows.push({ kind: 'detection', config: c.id, role: c.role, expect: c.expect, outcome, pass, prepareStackTrace: rep?.prepareStackTrace, namePerRound: rep?.namePerRound, rounds, webdriver: rep?.webdriver, error: res.error })
    s.gate(`detection/${c.id}`, pass, `${c.role}: ${outcome}; expected ${c.expect}${res.error ? ` (${String(res.error).split('\n')[0].slice(0, 200)})` : ''}`, { broken: c.role.endsWith('control') })
    detRows.push([c.id, c.role, c.expect, rep ? `${rep.classicStackGetter} | ${rep.prepareStackTrace} | ${rep.namePerRound} (${rounds})` : 'n/a', pass ? `PASS ${outcome}` : `FAIL ${outcome}`])
  }
  s.line('-- detection (stack | prepareStackTrace | name/round (rounds)) --')
  for (const l of table(['config', 'role', 'expect', 'stack | pST | name/round (rounds)', 'result'], detRows)) s.line(l)
  s.line()

  const scen = [
    { id: `py-unpatched-playwright==${version}`, module: 'playwright', mode: undefined, control: true },
    { id: 'py-patched-default', module: 'rebrowser_playwright', mode: undefined, control: false },
    { id: 'py-patched-alwaysIsolated', module: 'rebrowser_playwright', mode: 'alwaysIsolated', control: false },
  ]
  const grid = new Map()
  const configs = []
  for (const c of scen) {
    const res = await runCmd(vpy, [worker('scenarios.py'), c.module, ctx.chrome.path, ctx.server.url('')], {
      cwd: ctx.runDir, display: true, tmp: ctx.tmp, env: { ...pipEnv, REBROWSER_PATCHES_RUNTIME_FIX_MODE: c.mode }, timeoutMs: 240000,
    })
    const data = lastJsonLine(res.stdout) || { results: [], crash: `no result line (exit ${res.code}): ${tail(res.stderr || res.stdout, 300)}` }
    const results = data.results || []
    const failing = results.filter(x => x.status !== 'ok')
    const pass = results.length === 3 && failing.length === 0 && !data.crash && !data.launchError
    ctx.log(`[python] scenarios ${c.id}: ${results.length - failing.length}/${results.length} ok${data.crash ? ' ' + data.crash : ''}`)
    s.rows.push({ kind: 'scenarios', config: c.id, control: c.control, pass, results, crash: data.crash, launchError: data.launchError })
    s.gate(`scenarios/${c.id}`, pass,
      pass ? '3/3 scenarios pass' : `${c.control ? 'unpatched control' : 'patched'} failed: ${[...failing.map(x => `${x.name} [${x.status}${x.error ? ': ' + x.error.slice(0, 100) : ''}]`), data.crash, data.launchError].filter(Boolean).join('; ') || 'expected 3 scenario results, got ' + results.length}`,
      { broken: c.control })
    configs.push(c)
    for (const x of results) { if (!grid.has(x.name)) grid.set(x.name, {}); grid.get(x.name)[c.id] = x.status }
  }
  s.line('-- scenarios --')
  for (const l of table(['scenario', ...configs.map(c => c.id)], [...grid].map(([n, row]) => [n, ...configs.map(c => ({ ok: 'ok', fail: 'FAIL', timeout: 'TIMEOUT' }[row[c.id]] || row[c.id] || 'MISSING'))]))) s.line(l)
  s.note(`wheel ${path.basename(wheel)} (${dist} ${wheelVersion}, unpatched control playwright==${version})`)
  return s.finish()
}
