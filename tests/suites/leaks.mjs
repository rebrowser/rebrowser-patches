// Suite "leaks": automation tells outside the Runtime.enable layer, read from a normal launch + evaluate.
//
//   stack:   an Error thrown inside page.evaluate() must not name the library in its stack. Upstream Puppeteer adds
//            "//# sourceURL=pptr:..." and upstream Playwright runs evaluate() through a class named UtilityScript,
//            so the stack says "UtilityScript.evaluate". The patches rename both (REBROWSER_PATCHES_SOURCE_URL=0 turns
//            that off).
//   flag:    (Puppeteer only; Playwright stopped passing it upstream) the browser must not be launched with
//            --enable-automation, which shows the "Chrome is being controlled by automated test software" bar.
//            REBROWSER_PATCHES_WEBDRIVER_FIX=0 turns that off.
//
//   binding: with page.exposeFunction() in use, after a navigation the page must see the CDP binding as missing or
//            native while it parses (never a JS stand-in), and no page-visible function source may name the patches.
//            The unpatched library is the reference (native binding, no marker).
//
//   globals: no global may appear on window (main frame and iframe, across a navigation) while the library evaluates,
//            waits for selectors and reads the DOM. The patches' context lookup must leave nothing behind (the old
//            binding handshake left native functions with random names). The unpatched library is the reference.
//
//   controls (must leak): the unpatched upstream library; the patched library with the opt-out env var
//   gates (must be clean): the patched library with defaults
import path from 'node:path'
import { newSuite, table } from '../lib/report.mjs'
import { run as runCmd, lastJsonLine, tail } from '../lib/util.mjs'

const STACK_MARKER = /UtilityScript|pptr:|__puppeteer_evaluation_script__|__playwright_evaluation_script__/

export async function run(ctx) {
  const s = newSuite('leaks')
  const url = ctx.server.url('main.html')
  const rows = []
  for (const fam of [ctx.project.pptr, ctx.project.pw]) {
    if (!fam) continue
    const unpatched = { lib: fam.upstream.alias, env: {}, control: true }
    const cfgs = [
      { check: 'stack', id: `${fam.key}-stack-unpatched-${fam.upstream.name}@${fam.upstream.version}`, ...unpatched, expectLeak: true },
      { check: 'stack', id: `${fam.key}-stack-patched-SOURCE_URL=0`, lib: fam.patched.name, env: { REBROWSER_PATCHES_SOURCE_URL: '0' }, control: true, expectLeak: true },
      { check: 'stack', id: `${fam.key}-stack-patched-default`, lib: fam.patched.name, env: {}, control: false, expectLeak: false },
    ]
    cfgs.push(
      { check: 'globals', id: `${fam.key}-globals-unpatched-${fam.upstream.name}@${fam.upstream.version}`, ...unpatched, expectLeak: false },
      { check: 'globals', id: `${fam.key}-globals-patched-default`, lib: fam.patched.name, env: {}, control: false, expectLeak: false },
      { check: 'binding', id: `${fam.key}-binding-unpatched-${fam.upstream.name}@${fam.upstream.version}`, ...unpatched, expectLeak: false },
      { check: 'binding', id: `${fam.key}-binding-patched-default`, lib: fam.patched.name, env: {}, control: false, expectLeak: false },
    )
    if (fam.key === 'pptr') {
      cfgs.push(
        { check: 'flag', id: `pptr-flag-unpatched-${fam.upstream.name}@${fam.upstream.version}`, ...unpatched, expectLeak: true },
        { check: 'flag', id: 'pptr-flag-patched-WEBDRIVER_FIX=0', lib: fam.patched.name, env: { REBROWSER_PATCHES_WEBDRIVER_FIX: '0' }, control: true, expectLeak: true },
        { check: 'flag', id: 'pptr-flag-patched-default', lib: fam.patched.name, env: {}, control: false, expectLeak: false },
      )
    }
    // one browser run per distinct (lib, env); both checks read from it
    const runs = new Map()
    for (const c of cfgs) {
      const key = `${c.lib} ${JSON.stringify(c.env)}`
      if (!runs.has(key)) {
        const r = await runCmd('node', [path.join(ctx.project.workers, 'leaks.mjs'), c.lib, fam.key, ctx.chrome.path, url], {
          cwd: ctx.project.dir, display: true, tmp: ctx.tmp, env: c.env, timeoutMs: 120000,
        })
        runs.set(key, { out: r.code === 0 ? lastJsonLine(r.stdout) : null, error: tail(r.stderr || r.stdout, 300) })
      }
      const { out, error } = runs.get(key)
      let leaked = null
      let shown = 'RUN FAILED'
      if (out) {
        if (c.check === 'stack') {
          const m = String(out.stack).match(STACK_MARKER)
          leaked = !!m
          shown = m ? `stack names "${m[0]}"` : 'stack clean'
        } else if (c.check === 'globals') {
          leaked = out.globals.length > 0
          shown = leaked ? `globals appeared: ${out.globals.slice(0, 6).join(', ')}` : 'no globals appeared'
        } else if (c.check === 'binding') {
          const p = out.binding.parse || {}
          const stub = p.type !== 'undefined' && !(p.type === 'function' && p.native)
          leaked = stub || out.binding.marker
          shown = `binding while parsing: ${p.type}${p.type === 'function' ? (p.native ? ' (native)' : ' (JS stand-in)') : ''}; marker in page functions: ${out.binding.marker ? 'yes' : 'no'}`
        } else {
          leaked = /(^|\s)--enable-automation(\s|$)/.test(out.commandLine)
          shown = leaked ? '--enable-automation passed' : 'no --enable-automation'
        }
      }
      const pass = out !== null && leaked === c.expectLeak
      ctx.log(`[leaks] ${c.id}: ${shown}${out ? '' : ' ' + error}`)
      s.rows.push({ config: c.id, family: fam.key, check: c.check, lib: c.lib, control: c.control, expectLeak: c.expectLeak, leaked, pass, stack: out?.stack, error: out ? undefined : error })
      s.gate(c.id, pass, out ? `${c.control ? 'control' : 'patched'}: ${shown}, expected ${c.expectLeak ? 'a leak' : 'clean'}` : `run failed: ${error}`, { broken: c.control })
      rows.push([c.id, c.control ? 'control' : 'gate', c.expectLeak ? 'leak' : 'clean', shown, pass ? 'PASS' : 'FAIL'])
    }
  }
  for (const l of table(['config', 'role', 'expected', 'observed', 'result'], rows)) s.line(l)
  return s.finish()
}
