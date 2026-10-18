#!/usr/bin/env node
// rebrowser-patches test harness. See `node tests/run.mjs --help`.
//
//   node tests/run.mjs --pptr-core <tgz> [--pptr <tgz>] --pw-core <tgz> [--pw <tgz>] [--py-wheel <whl>]
//                      [--chrome <path>] [--suites detection,scenarios,webdriver,smoke,python] --out <dir>
//
// Installs the given tarballs plus the unpatched upstream of the same version (the positive controls) into a
// throwaway project under the work dir, gets a Chrome, serves the fixtures from this process, runs the suites and
// writes <out>/results.json and <out>/summary.txt. Exit code 0 only when every hard gate passed.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parseCli, HELP } from './lib/cli.mjs'
import { acquireChrome } from './lib/browsers.mjs'
import { startFixtureServer } from './lib/server.mjs'
import { createProject, TESTS_DIR } from './lib/project.mjs'
import { errorSuite, writeResults, verdictOf } from './lib/report.mjs'
import { onExit, run as runCmd, needsDisplay, fmtSecs } from './lib/util.mjs'

const parsed = parseCli(process.argv.slice(2))
if (parsed.help) { process.stdout.write(HELP); process.exit(0) }
if (parsed.error) { process.stderr.write(`error: ${parsed.error}\n\n${HELP}`); process.exit(64) }
const args = parsed.args

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`error: Node >= 22 is required (this is ${process.version})`)
  process.exit(64)
}

const T0 = Date.now()
const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '').replace('T', '_')
const runId = `${stamp}-${process.pid}`
const runDir = path.join(args.work, 'tests', runId)
// Chrome rejects long profile/socket paths ("Socket path too long"), so TMPDIR and profiles live in a short /tmp dir
const tmp = fs.mkdtempSync(path.join(fs.existsSync('/tmp') ? '/tmp' : os.tmpdir(), 'rbm.'))
fs.mkdirSync(runDir, { recursive: true })
onExit(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  if (!args.keep) fs.rmSync(runDir, { recursive: true, force: true })
})

const log = msg => console.log(`[+${fmtSecs(Date.now() - T0).padStart(6)}] ${msg}`)
const ctx = { args, runId, runDir, tmp, log, chrome: null, server: null, project: null }

const SUITE_MODULES = {
  detection: './suites/detection.mjs',
  scenarios: './suites/scenarios.mjs',
  webdriver: './suites/webdriver.mjs',
  leaks: './suites/leaks.mjs',
  smoke: './suites/smoke.mjs',
  python: './suites/python.mjs',
  nonchromium: './suites/nonchromium.mjs',
}

const meta = {
  tool: 'rebrowser-patches tests',
  startedAt: new Date(T0).toISOString(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  workDir: args.work,
  suitesRequested: args.suites,
  chrome: null,
  inputs: {},
  upstreamControls: {},
}
const suites = []

function finalize(extra = {}) {
  meta.finishedAt = new Date().toISOString()
  meta.seconds = +((Date.now() - T0) / 1000).toFixed(1)
  return writeResults(args.out, meta, suites, extra)
}

async function main() {
  log(`run ${runId}: suites ${args.suites.join(', ')}; work dir ${args.work}; tmp ${tmp}`)

  if (needsDisplay()) {
    const x = await runCmd('sh', ['-c', 'command -v xvfb-run'])
    if (x.code !== 0) throw new Error('DISPLAY is unset and xvfb-run is not installed; install xvfb or run under a display')
  }

  ctx.chrome = await acquireChrome({ chrome: args.chrome, work: args.work, log: m => log(`[chrome] ${m}`) })
  meta.chrome = ctx.chrome
  log(`browser: ${ctx.chrome.version} (${ctx.chrome.source}) ${ctx.chrome.path}`)

  ctx.server = await startFixtureServer(path.join(TESTS_DIR, 'fixtures'))
  onExit(() => ctx.server.close())
  log(`fixture server: http://127.0.0.1:${ctx.server.ports.A} and http://localhost:${ctx.server.ports.B}`)

  if (args.suites.some(s => s !== 'python')) {
    log('creating the throwaway project (npm install of the tarballs + unpatched upstream + typescript) ...')
    ctx.project = await createProject(ctx)
    for (const fam of [ctx.project.pptr, ctx.project.pw]) {
      if (!fam) continue
      meta.inputs[`${fam.key}-core`] = `${fam.patched.name}@${fam.patched.version}  ${fam.patched.file}`
      if (fam.wrapper) meta.inputs[fam.key] = `${fam.wrapper.name}@${fam.wrapper.version}  ${fam.wrapper.file}`
      meta.upstreamControls[fam.upstream.name] = fam.upstream.version
      meta.inputs[`${fam.key}-control`] = `unpatched ${fam.upstream.name}@${fam.upstream.version} (npm)`
    }
  }
  if (args.pyWheel) meta.inputs['py-wheel'] = args.pyWheel

  for (const name of args.suites) {
    log(`=== suite: ${name} ===`)
    let result
    try {
      const mod = await import(SUITE_MODULES[name])
      result = await mod.run(ctx)
    } catch (e) {
      log(`suite ${name} crashed: ${(e && e.stack) || e}`)
      result = errorSuite(name, e)
    }
    suites.push(result)
    log(`suite ${name}: ${result.status.toUpperCase()} (${result.gates.filter(g => g.ok).length}/${result.gates.length} gates, ${fmtSecs((result.seconds || 0) * 1000)})`)
    finalize({ partial: suites.length < args.suites.length })
  }
}

let fatal = null
try {
  await main()
} catch (e) {
  fatal = e
  console.error(`\nSETUP ERROR: ${(e && e.message) || e}`)
}

const result = finalize(fatal ? { error: String((fatal && fatal.message) || fatal) } : {})
const v = verdictOf(suites)
process.stdout.write('\n' + result.summary)
if (fatal) {
  console.log(`rebrowser-patches tests: ERROR (${String((fatal && fatal.message) || fatal).split('\n')[0]}) -- results in ${args.out}`)
  process.exitCode = 2
} else {
  console.log(`rebrowser-patches tests: ${v.verdict} - ${v.gates - v.failed}/${v.gates} gates passed, ${suites.length} suite(s), ${fmtSecs(Date.now() - T0)} -- results in ${args.out}`)
  process.exitCode = v.pass ? 0 : suites.some(s => s.status === 'error') ? 2 : 1
}
ctx.server?.close()
process.exit(process.exitCode) // runs the 'exit' cleanup (tmp dir, throwaway project) even if a handle is still open
