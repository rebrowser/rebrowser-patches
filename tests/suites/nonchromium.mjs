// Suite "nonchromium" (Playwright only, opt-in): the patched build must still drive Firefox and WebKit, unpatched,
// instead of crashing (issues #105, #112, #126). Needs those browsers installed for the Playwright version under
// test (e.g. `npx playwright-core@<version> install --with-deps firefox webkit`).
//   controls (must work, else the environment is broken): unpatched upstream on each browser
//   gates (must work): patched default on each browser
import path from 'node:path'
import { newSuite, table } from '../lib/report.mjs'
import { run as runCmd, lastJsonLine, tail } from '../lib/util.mjs'

export async function run(ctx) {
  const s = newSuite('nonchromium')
  const fam = ctx.project.pw
  const rows = []
  if (!fam) {
    s.note('no Playwright build given (--pw-core), nothing to check')
    return s.finish()
  }
  const url = ctx.server.url('iframes.html')
  for (const browserName of ['firefox', 'webkit']) {
    for (const c of [
      { id: `${browserName}-unpatched-${fam.upstream.name}@${fam.upstream.version}`, lib: fam.upstream.alias, control: true },
      { id: `${browserName}-patched-default`, lib: fam.patched.name, control: false },
    ]) {
      const r = await runCmd('node', [path.join(ctx.project.workers, 'nonchromium.mjs'), c.lib, browserName, url], {
        cwd: ctx.project.dir, display: true, tmp: ctx.tmp, timeoutMs: 120000,
      })
      const out = r.code === 0 ? lastJsonLine(r.stdout) : null
      const pass = !!out && out.title === 'Iframes' && out.reloaded === 'Iframes'
      const shown = out ? `title=${out.title} frames=${out.frames} reload=${out.reloaded}` : `RUN FAILED: ${tail(r.stderr || r.stdout, 200)}`
      ctx.log(`[nonchromium] ${c.id}: ${shown}`)
      s.rows.push({ config: c.id, browser: browserName, lib: c.lib, control: c.control, pass, out, error: out ? undefined : tail(r.stderr || r.stdout, 300) })
      s.gate(c.id, pass, shown, { broken: c.control })
      rows.push([c.id, c.control ? 'control' : 'gate', shown.slice(0, 80), pass ? 'PASS' : 'FAIL'])
    }
  }
  for (const l of table(['config', 'role', 'observed', 'result'], rows)) s.line(l)
  return s.finish()
}
