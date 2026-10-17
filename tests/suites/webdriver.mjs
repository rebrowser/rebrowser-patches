// Suite "webdriver": the patched launchers add --disable-blink-features=AutomationControlled (merged with any
// --disable-blink-features the caller passes), so navigator.webdriver must not be true. Read through a normal evaluate.
//
//   controls (must be true):  the unpatched upstream library; the patched library with REBROWSER_PATCHES_WEBDRIVER_FIX=0
//   gates (must be false or undefined): patched default; patched default when the caller also passes its own
//                                       --disable-blink-features (the two flags must be merged, not overwrite each other)
import path from 'node:path'
import { newSuite, table } from '../lib/report.mjs'
import { run as runCmd, lastJsonLine, tail } from '../lib/util.mjs'

export async function run(ctx) {
  const s = newSuite('webdriver')
  const url = ctx.server.url('main.html')
  const rows = []
  for (const fam of [ctx.project.pptr, ctx.project.pw]) {
    if (!fam) continue
    const cfgs = [
      { id: `${fam.key}-unpatched-${fam.upstream.name}@${fam.upstream.version}`, lib: fam.upstream.alias, env: {}, extra: [], expect: true, control: true },
      { id: `${fam.key}-patched-WEBDRIVER_FIX=0`, lib: fam.patched.name, env: { REBROWSER_PATCHES_WEBDRIVER_FIX: '0' }, extra: [], expect: true, control: true },
      { id: `${fam.key}-patched-default`, lib: fam.patched.name, env: {}, extra: [], expect: false, control: false },
      { id: `${fam.key}-patched-merges-user-blink-features`, lib: fam.patched.name, env: {}, extra: ['--disable-blink-features=RebrowserPatchesTestUnknownFeature'], expect: false, control: false },
    ]
    for (const c of cfgs) {
      const r = await runCmd('node', [path.join(ctx.project.workers, 'webdriver.mjs'), c.lib, fam.key, ctx.chrome.path, url, ...c.extra], {
        cwd: ctx.project.dir, display: true, tmp: ctx.tmp, env: c.env, timeoutMs: 120000,
      })
      const out = r.code === 0 ? lastJsonLine(r.stdout) : null
      const value = out ? out.webdriver : null
      // expect true -> must be exactly true; expect false -> must be false or undefined
      const pass = out !== null && (c.expect ? value === true : value === false || value === 'undefined')
      const shown = out ? String(value) : 'RUN FAILED'
      ctx.log(`[webdriver] ${c.id}: navigator.webdriver = ${shown}${out ? '' : ' ' + tail(r.stderr || r.stdout, 200)}`)
      s.rows.push({ config: c.id, family: fam.key, lib: c.lib, control: c.control, expect: c.expect ? 'true' : 'false/undefined', value: out ? value : null, pass, error: out ? undefined : tail(r.stderr || r.stdout, 300) })
      s.gate(c.id, pass, out ? `${c.control ? 'control' : 'patched'}: navigator.webdriver = ${shown}, expected ${c.expect ? 'true' : 'false/undefined'}` : `run failed: ${tail(r.stderr || r.stdout, 200)}`, { broken: c.control })
      rows.push([c.id, c.control ? 'control' : 'gate', c.expect ? 'true' : 'false/undefined', shown, pass ? 'PASS' : 'FAIL'])
    }
  }
  for (const l of table(['config', 'role', 'expected', 'navigator.webdriver', 'result'], rows)) s.line(l)
  return s.finish()
}
