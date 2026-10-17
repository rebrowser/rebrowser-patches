// Suite "detection": does an unpatched CDP client leak Runtime.enable to the page, and do the patched builds not?
//
// The page (fixtures/poc2.html) runs three probes every 50 ms for 8 s while the library is actively working on it:
//   - classic .stack getter on a logged Error (dead on Chrome >= 137, kept for older Chrome)
//   - Error.prepareStackTrace firing on console.debug(new Error())
//   - extra `name` getter calls on an Error subclass passed to console.debug
// "detected" = prepareStackTrace hits > 0  OR  name-getter calls per round > 1.5.
//
// Controls (a failed control means the oracle itself is wrong, which fails the whole run as "broken"):
//   negative, must be clean:    plain Chrome with no CDP; raw CDP with Runtime.enable OFF
//   positive, must be detected: raw CDP with Runtime.enable ON; the unpatched upstream library; the patched
//                               library with REBROWSER_PATCHES_RUNTIME_FIX_MODE=0
// Hard gates: patched default and alwaysIsolated builds are clean (equal to plain Chrome).
// enableDisable (Puppeteer only) is a documented "bounded exposure" mode: recorded, never gated on the leak.
import { newSuite, table } from '../lib/report.mjs'
import { runPlain, runRaw, runLib } from '../lib/browserRuns.mjs'

const MIN_ROUNDS = 20 // the page does ~150 rounds in 8 s; far fewer means the probe did not really run
export const isDetected = r => r.prepareStackTrace > 0 || r.namePerRound > 1.5

function buildConfigs(ctx) {
  const cfgs = [
    { id: 'plain-noCDP', family: '-', role: 'negative-control', expect: 'clean', exec: tag => runPlain(ctx, tag) },
    { id: 'rawCDP-RuntimeEnable-OFF', family: '-', role: 'negative-control', expect: 'clean', exec: tag => runRaw(ctx, tag, false) },
    { id: 'rawCDP-RuntimeEnable-ON', family: '-', role: 'positive-control', expect: 'detected', exec: tag => runRaw(ctx, tag, true) },
  ]
  for (const fam of [ctx.project.pptr, ctx.project.pw]) {
    if (!fam) continue
    const lib = fam.patched.name
    const exec = (importName, mode) => tag => runLib(ctx, { lib: importName, family: fam.key, mode, tag })
    cfgs.push({ id: `${fam.key}-unpatched-${fam.upstream.name}@${fam.upstream.version}`, family: fam.key, role: 'positive-control', expect: 'detected', exec: exec(fam.upstream.alias) })
    cfgs.push({ id: `${fam.key}-patched-default`, family: fam.key, role: 'patched', mode: 'default', expect: 'clean', exec: exec(lib, undefined) })
    cfgs.push({ id: `${fam.key}-patched-alwaysIsolated`, family: fam.key, role: 'patched', mode: 'alwaysIsolated', expect: 'clean', exec: exec(lib, 'alwaysIsolated') })
    if (fam.key === 'pptr') cfgs.push({ id: 'pptr-patched-enableDisable', family: 'pptr', role: 'patched', mode: 'enableDisable', expect: 'bounded', exec: exec(lib, 'enableDisable') })
    cfgs.push({ id: `${fam.key}-patched-mode0`, family: fam.key, role: 'positive-control', mode: '0', expect: 'detected', exec: exec(lib, '0') })
  }
  return cfgs
}

export async function run(ctx) {
  const s = newSuite('detection')
  const cfgs = buildConfigs(ctx)
  const results = new Map(cfgs.map(c => [c.id, []]))

  for (let rep = 1; rep <= ctx.args.reps; rep++) {
    for (const c of cfgs) {
      const tag = `${c.id}.r${rep}`
      const r = await c.exec(tag)
      const rep_ = { rep, ok: r.ok, ms: r.ms, error: r.error, sent: r.sent }
      if (r.report) {
        Object.assign(rep_, {
          classicStackGetter: r.report.classicStackGetter,
          prepareStackTrace: r.report.prepareStackTrace,
          namePerRound: r.report.namePerRound,
          rounds: r.report.rounds,
          webdriver: r.report.webdriver,
        })
        rep_.detected = isDetected(r.report)
        if (r.report.rounds < MIN_ROUNDS) { rep_.ok = false; rep_.error = `probe ran only ${r.report.rounds} rounds (< ${MIN_ROUNDS})` }
      }
      results.get(c.id).push(rep_)
      ctx.log(`[detection] ${c.id} rep ${rep}/${ctx.args.reps}: ${rep_.ok ? (rep_.detected ? 'DETECTED' : 'clean') : 'RUN FAILED'}` +
        (r.report ? ` (stack ${rep_.classicStackGetter}, prepareStackTrace ${rep_.prepareStackTrace}, name/round ${rep_.namePerRound})` : '') +
        (rep_.error ? ` ${String(rep_.error).split('\n')[0].slice(0, 160)}` : ''))
    }
  }

  const tableRows = []
  for (const c of cfgs) {
    const runs = results.get(c.id)
    const allOk = runs.every(r => r.ok)
    let pass
    let outcome
    if (!allOk) { pass = false; outcome = 'RUN FAILED' }
    else if (c.expect === 'clean') { pass = runs.every(r => !r.detected); outcome = pass ? 'clean' : 'DETECTED' }
    else if (c.expect === 'detected') { pass = runs.every(r => r.detected); outcome = pass ? 'detected' : 'NOT DETECTED' }
    else { pass = true; outcome = runs.some(r => r.detected) ? 'bounded (leaks a little)' : 'bounded (clean this time)' }
    const control = c.role.endsWith('control')
    const detail = allOk
      ? `${outcome}; expected ${c.expect}`
      : `${runs.filter(r => !r.ok).map(r => r.error).join(' | ').slice(0, 300)}`
    s.rows.push({ config: c.id, family: c.family, role: c.role, mode: c.mode, expect: c.expect, outcome, pass, runs })
    s.gate(c.id, pass, `${c.role}: ${detail}`, { broken: control })
    tableRows.push([
      c.id,
      c.role,
      c.expect,
      runs.map(r => (r.rounds === undefined ? 'n/a' : `${r.classicStackGetter} | ${r.prepareStackTrace} | ${r.namePerRound} (${r.rounds})`)).join('  /  '),
      pass ? `PASS ${outcome}` : `FAIL ${outcome}`,
    ])
  }

  s.line('probe columns per run: stackGetter | prepareStackTrace | name-getter calls per round (rounds); detected = prepareStackTrace>0 or name/round>1.5')
  s.line()
  for (const l of table(['config', 'role', 'expect', 'stack | pST | name/round (rounds)', 'result'], tableRows)) s.line(l)

  const failedControls = s.gates.filter(g => !g.ok && g.broken)
  if (failedControls.length) s.note(`CONTROL FAILURE: ${failedControls.map(g => g.id).join(', ')} -- the oracle is wrong, do not trust the other results`)
  const ed = results.get('pptr-patched-enableDisable')
  if (ed) s.note('enableDisable (Puppeteer) is bounded exposure: ~3 extra getter calls per 155 rounds (name/round ~1.02) are expected; recorded, never gated.')
  return s.finish()
}
