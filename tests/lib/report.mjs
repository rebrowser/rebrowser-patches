// Suite result collection and the results.json / summary.txt writers.
import fs from 'node:fs'
import path from 'node:path'
import { fmtSecs } from './util.mjs'

/**
 * A suite collects machine-readable `rows`, hard `gates`, `notes` and human-readable `lines` (its summary table).
 * gate(id, ok, detail, { broken }) : a failed gate with broken=true means a control misbehaved, i.e. the test itself
 * cannot be trusted; the verdict says so.
 */
export function newSuite(name) {
  const s = {
    name,
    status: 'pass',
    t0: Date.now(),
    rows: [],
    gates: [],
    notes: [],
    lines: [],
    gate(id, ok, detail = '', { broken = false } = {}) {
      s.gates.push({ id: `${name}/${id}`, ok: !!ok, broken: !ok && broken, detail })
      if (!ok) s.status = 'fail'
    },
    note(msg) { s.notes.push(msg) },
    line(text = '') { s.lines.push(text) },
    finish() { s.seconds = +((Date.now() - s.t0) / 1000).toFixed(1); return s },
  }
  return s
}

export function skippedSuite(name, reason) {
  const s = newSuite(name)
  s.status = 'skipped'
  s.note(reason)
  return s.finish()
}

export function errorSuite(name, err) {
  const s = newSuite(name)
  s.status = 'error'
  s.gate('suite-ran', false, String((err && err.stack) || err).split('\n').slice(0, 4).join(' | '))
  s.status = 'error'
  return s.finish()
}

export function table(headers, rows) {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i] ?? '').length)))
  const fmt = r => r.map((c, i) => String(c ?? '').padEnd(w[i])).join('  ').trimEnd()
  return [fmt(headers), fmt(w.map(n => '-'.repeat(n))), ...rows.map(fmt)]
}

export function verdictOf(suites) {
  const gates = suites.flatMap(s => s.gates)
  const failed = gates.filter(g => !g.ok)
  const broken = failed.filter(g => g.broken)
  const errored = suites.filter(s => s.status === 'error')
  let verdict = 'PASS'
  if (failed.length) verdict = broken.length ? 'FAIL (a control misbehaved: the test itself is broken)' : 'FAIL'
  return { verdict, pass: failed.length === 0, gates: gates.length, failed: failed.length, broken: broken.length, errored: errored.length }
}

export function renderSummary(meta, suites) {
  const out = []
  out.push('rebrowser-patches test run')
  out.push(`  started   ${meta.startedAt}`)
  out.push(`  node      ${meta.node}  ${meta.platform}/${meta.arch}`)
  out.push(`  browser   ${meta.chrome ? `${meta.chrome.version} (${meta.chrome.source}) ${meta.chrome.path}` : 'n/a'}`)
  for (const [k, v] of Object.entries(meta.inputs)) if (v) out.push(`  ${k.padEnd(9)} ${v}`)
  out.push('')
  for (const s of suites) {
    out.push(`=== ${s.name}: ${s.status.toUpperCase()}${s.seconds !== undefined ? `  (${fmtSecs(s.seconds * 1000)})` : ''} ===`)
    for (const l of s.lines) out.push(l)
    if (s.notes.length) { out.push('notes:'); for (const n of s.notes) out.push('  - ' + n) }
    out.push('')
  }
  const v = verdictOf(suites)
  out.push('=== hard gates ===')
  for (const s of suites) for (const g of s.gates) out.push(`${g.ok ? 'PASS' : g.broken ? 'BROKEN' : 'FAIL'}  ${g.id}${g.detail ? '  -- ' + g.detail : ''}`)
  out.push('')
  out.push(`VERDICT: ${v.verdict}  (${v.gates - v.failed}/${v.gates} gates passed)`)
  return out.join('\n') + '\n'
}

export function writeResults(outDir, meta, suites, extra = {}) {
  fs.mkdirSync(outDir, { recursive: true })
  const v = verdictOf(suites)
  const json = {
    ...meta,
    ...extra,
    verdict: v.verdict,
    pass: v.pass,
    counts: { gates: v.gates, failed: v.failed, broken: v.broken },
    suites: Object.fromEntries(suites.map(s => [s.name, { status: s.status, seconds: s.seconds, rows: s.rows, gates: s.gates, notes: s.notes }])),
  }
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(json, null, 2) + '\n')
  const summary = renderSummary(meta, suites)
  fs.writeFileSync(path.join(outDir, 'summary.txt'), summary)
  return { summary, verdict: v }
}
