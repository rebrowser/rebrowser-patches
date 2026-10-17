// Suite "scenarios": 22 functional regression cases per API family (evaluate across navigation, waitForFunction,
// frames incl. an out-of-process iframe, workers, exposeFunction, init scripts, request events/interception, popups,
// storageState, ...), taken from real issues. The page fixtures live in tests/fixtures/scen.
//
// Gates:
//   - the unpatched upstream library must pass every scenario, otherwise the harness is broken (fails the run as such)
//   - a patched build may fail only the scenarios listed in tests/baselines/<package>.json for that mode
//     (known, issue-linked, patch-inherent failures); any other failure is a new regression
import fs from 'node:fs'
import path from 'node:path'
import { newSuite, table } from '../lib/report.mjs'
import { run as runCmd, lastJsonLine, tail } from '../lib/util.mjs'
import { TESTS_DIR } from '../lib/project.mjs'

const CONFIG_TIMEOUT_MS = 450000

export function loadBaseline(upstreamName) {
  return JSON.parse(fs.readFileSync(path.join(TESTS_DIR, 'baselines', `${upstreamName}.json`), 'utf8'))
}

async function runWorker(ctx, { lib, family, mode }) {
  const r = await runCmd('node', [path.join(ctx.project.workers, 'scenarios.mjs'), lib, family, ctx.chrome.path, String(ctx.server.ports.A), String(ctx.server.ports.B)], {
    cwd: ctx.project.dir,
    display: true,
    tmp: ctx.tmp,
    env: { REBROWSER_PATCHES_RUNTIME_FIX_MODE: mode && mode !== 'default' ? mode : undefined },
    timeoutMs: CONFIG_TIMEOUT_MS,
  })
  const data = lastJsonLine(r.stdout)
  if (data) return { data, ms: r.ms }
  return { data: { results: [], crash: `${r.timedOut ? 'timed out' : 'no result line'} (exit ${r.code}): ${tail(r.stderr || r.stdout, 300)}` }, ms: r.ms }
}

export async function run(ctx) {
  const s = newSuite('scenarios')
  for (const fam of [ctx.project.pptr, ctx.project.pw]) {
    if (!fam) continue
    const baseline = loadBaseline(fam.upstream.name)
    const names = baseline.scenarios
    const configs = [
      { id: `${fam.key}-unpatched`, label: `${fam.upstream.name}@${fam.upstream.version}`, lib: fam.upstream.alias, mode: undefined, control: true, allow: new Map() },
      ...Object.entries(baseline.modes).map(([mode, m]) => ({
        id: `${fam.key}-patched-${mode}`,
        label: `${fam.patched.name}@${fam.patched.version} ${mode}`,
        lib: fam.patched.name,
        mode,
        control: false,
        allow: new Map(m.allowFail.map(a => [a.scenario, a])),
      })),
    ]
    const done = []
    for (const c of configs) {
      ctx.log(`[scenarios] ${c.id} ...`)
      const { data, ms } = await runWorker(ctx, { lib: c.lib, family: fam.key, mode: c.mode })
      const byName = new Map((data.results || []).map(r => [r.name, r]))
      const statusOf = n => byName.get(n)?.status ?? 'missing'
      const failing = names.filter(n => statusOf(n) !== 'ok')
      const unexpected = failing.filter(n => !c.allow.has(n))
      const nowPassing = [...c.allow.keys()].filter(n => statusOf(n) === 'ok')
      const extra = (data.results || []).map(r => r.name).filter(n => !names.includes(n))
      const problems = []
      if (data.launchError) problems.push(`launch failed: ${data.launchError}`)
      if (data.crash) problems.push(`worker crashed: ${data.crash}`)
      if (data.watchdog) problems.push('worker watchdog fired (partial results)')
      if (extra.length) problems.push(`scenarios not in the baseline inventory: ${extra.join(', ')}`)
      s.rows.push({
        config: c.id, family: fam.key, lib: c.lib, mode: c.mode || 'default', control: c.control, product: data.product || null, seconds: +(ms / 1000).toFixed(1),
        ok: names.length - failing.length, total: names.length,
        results: Object.fromEntries(names.map(n => [n, { status: statusOf(n), error: byName.get(n)?.error, allowed: c.allow.has(n) }])),
        unexpectedFailures: unexpected, nowPassing, unhandled: data.unhandled, problems,
      })
      if (c.control) {
        const pass = failing.length === 0 && problems.length === 0
        s.gate(`${c.id}-controls-pass-all`, pass,
          pass ? `${names.length}/${names.length} scenarios pass on unpatched ${c.label}` : `unpatched ${c.label} must pass every scenario, it failed: ${[...failing, ...problems].join('; ')}`, { broken: true })
      } else {
        const pass = unexpected.length === 0 && problems.length === 0
        s.gate(`${c.id}-no-new-failures`, pass,
          pass ? `${names.length - failing.length}/${names.length} pass, ${failing.length} known (baseline)` : `new failures: ${unexpected.map(n => `${n} [${statusOf(n)}${byName.get(n)?.error ? ': ' + byName.get(n).error.slice(0, 120) : ''}]`).concat(problems).join('; ')}`)
        if (nowPassing.length) s.note(`${c.id}: baseline entries that now pass (consider removing from baselines/${fam.upstream.name}.json): ${nowPassing.join(', ')}`)
      }
      if (data.unhandled?.length) s.note(`${c.id}: unhandled errors in the worker: ${data.unhandled.join(' || ')}`)
      done.push({ c, byName, statusOf, failing })
    }
    // one grid per family: scenarios x configs
    const cell = (d, n) => {
      const st = d.statusOf(n)
      const label = { ok: 'ok', fail: 'FAIL', timeout: 'TIMEOUT', 'n-a': 'n-a', missing: 'MISSING' }[st] || st
      return !d.c.control && st !== 'ok' && d.c.allow.has(n) ? `${label} (known)` : label
    }
    s.line(`-- ${fam.key === 'pptr' ? 'Puppeteer' : 'Playwright'} API: ${fam.patched.name}@${fam.patched.version} vs unpatched ${fam.upstream.name}@${fam.upstream.version} --`)
    const rows = names.map(n => [n, ...done.map(d => cell(d, n))])
    rows.push(['ok / total', ...done.map(d => `${names.length - d.failing.length}/${names.length}`)])
    for (const l of table(['scenario', ...done.map(d => d.c.id)], rows)) s.line(l)
    s.line()
  }
  const product = s.rows.map(r => r.product).find(Boolean)
  if (product) s.line(`browser: ${product}`)
  return s.finish()
}
