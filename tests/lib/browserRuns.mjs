// Single browser runs against fixtures/poc2.html. Each returns
//   { ok, error?, report?, ms, exit?, sent? }
// where `report` is what the page POSTed to the fixture server (the page does the detection itself).
import fs from 'node:fs'
import path from 'node:path'
import { start, run, sleep, tail } from './util.mjs'

const CHROME_BASE = ['--no-first-run', '--no-default-browser-check', '--no-sandbox', '--disable-dev-shm-usage']
const REPORT_WAIT_MS = 45000

function profileDir(ctx) {
  return fs.mkdtempSync(path.join(ctx.tmp, 'p-'))
}

/** Plain Chrome, no CDP at all: the baseline a clean automation must be indistinguishable from. */
export async function runPlain(ctx, tag) {
  const t0 = Date.now()
  const profile = profileDir(ctx)
  const url = ctx.server.url('poc2.html', 'tag=' + encodeURIComponent(tag))
  const p = start(ctx.chrome.path, [`--user-data-dir=${profile}`, ...CHROME_BASE, url], { display: true, tmp: ctx.tmp })
  try {
    const report = await ctx.server.waitForReport(tag, REPORT_WAIT_MS)
    return report ? { ok: true, report, ms: Date.now() - t0 } : { ok: false, error: 'no report from the probe page', ms: Date.now() - t0 }
  } finally {
    p.kill()
    await p.done
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

async function waitDevToolsPort(profile, p, ms) {
  const file = path.join(profile, 'DevToolsActivePort')
  const end = Date.now() + ms
  let exited = null
  p.done.then(r => { exited = r })
  while (Date.now() < end) {
    if (fs.existsSync(file)) {
      const port = fs.readFileSync(file, 'utf8').split('\n')[0]
      if (port) return port
    }
    if (exited) throw new Error(`chrome exited early (code ${exited.code}): ${tail(exited.stderr)}`)
    await sleep(100)
  }
  throw new Error('no DevToolsActivePort')
}

/** Raw CDP A/B: the same browser and page; the only difference is whether Runtime.enable is sent. */
export async function runRaw(ctx, tag, runtimeEnable) {
  const t0 = Date.now()
  const profile = profileDir(ctx)
  const p = start(ctx.chrome.path, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', ...CHROME_BASE, 'about:blank'], { display: true, tmp: ctx.tmp })
  let ws
  const sent = []
  try {
    const port = await waitDevToolsPort(profile, p, 30000)
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = targets.find(t => t.type === 'page')
    if (!page) throw new Error('no page target')
    ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true }) })
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString())
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    })
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const i = ++id
      sent.push(method)
      pending.set(i, m => (m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m)))
      ws.send(JSON.stringify({ id: i, method, params }))
    })
    await send('Page.enable')
    if (runtimeEnable) await send('Runtime.enable')
    await send('Page.navigate', { url: ctx.server.url('poc2.html', 'tag=' + encodeURIComponent(tag)) })
    const report = await ctx.server.waitForReport(tag, REPORT_WAIT_MS)
    return report
      ? { ok: true, report, sent: [...new Set(sent)], ms: Date.now() - t0 }
      : { ok: false, error: 'no report from the probe page', sent: [...new Set(sent)], ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), sent: [...new Set(sent)], ms: Date.now() - t0 }
  } finally {
    try { ws?.close() } catch {}
    p.kill()
    await p.done
    fs.rmSync(profile, { recursive: true, force: true })
  }
}

/** A library (Puppeteer or Playwright API) working on the page while it probes. `mode` sets REBROWSER_PATCHES_RUNTIME_FIX_MODE. */
export async function runLib(ctx, { lib, family, mode, tag }) {
  const url = ctx.server.url('poc2.html', 'tag=' + encodeURIComponent(tag))
  const r = await run('node', [path.join(ctx.project.workers, 'lib-active.mjs'), lib, family, ctx.chrome.path, url], {
    cwd: ctx.project.dir,
    display: true,
    tmp: ctx.tmp,
    env: { REBROWSER_PATCHES_RUNTIME_FIX_MODE: mode },
    timeoutMs: 120000,
  })
  const report = await ctx.server.waitForReport(tag, 3000)
  if (r.code !== 0) return { ok: false, exit: r.code, error: r.timedOut ? 'timed out' : tail(r.stderr || r.stdout), report, ms: r.ms }
  if (!report) return { ok: false, exit: r.code, error: 'no report from the probe page', ms: r.ms }
  return { ok: true, exit: 0, report, ms: r.ms }
}
