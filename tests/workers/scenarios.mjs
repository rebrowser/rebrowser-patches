// Functional-regression scenarios (29 per API family) run against one library build in one browser.
// usage: node scenarios.mjs <importName> <pptr|pw> <chromePath> <portA> <portB>
//   portA = fixture site 127.0.0.1:<portA>, portB = fixture site localhost:<portB> (a different site -> OOPIF);
//   both are served by the test runner. The patch mode comes from REBROWSER_PATCHES_RUNTIME_FIX_MODE.
// Run under a display. Prints one JSON object {lib, mode, product, results:[{name,status,ms,error?,value?}]}.
// Exit code: 0 normally (even when scenarios fail), 2 if the browser cannot launch, 64 on bad usage.
import fs from 'node:fs'

const [lib, family, executablePath, portAArg, portBArg] = process.argv.slice(2)
if (!lib || !['pptr', 'pw'].includes(family) || !executablePath || !portAArg || !portBArg) {
  console.error('usage: node scenarios.mjs <importName> <pptr|pw> <chromePath> <portA> <portB>')
  process.exit(64)
}
const pptr = family === 'pptr'
const ports = { A: +portAArg, B: +portBArg }
const mode = process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE || 'default'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const WATCHDOG_MS = 6 * 60 * 1000
const DEFAULT_TIMEOUT = 15000
// optional debugging aid: SCEN_ONLY=name1,name2 runs just those scenarios
const ONLY = process.env.SCEN_ONLY ? process.env.SCEN_ONLY.split(',') : null

const results = []
const unhandled = []
const note = e => { if (unhandled.length < 5) unhandled.push(String((e && e.message) || e).slice(0, 200)) }
process.on('unhandledRejection', note)
process.on('uncaughtException', note)

// ---- process-tree helpers (only descendants of THIS node process are ever signalled) ----
function descendants(root = process.pid) {
  const kids = new Map()
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8')
      const ppid = +stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]
      if (!kids.has(ppid)) kids.set(ppid, [])
      kids.get(ppid).push(+d)
    } catch {}
  }
  const out = []
  const stack = [root]
  while (stack.length) for (const c of kids.get(stack.pop()) || []) { out.push(c); stack.push(c) }
  return out
}
function killTree() {
  try { for (const pid of descendants()) { try { process.kill(pid, 'SIGKILL') } catch {} } } catch {}
}

const urlA = p => `http://127.0.0.1:${ports.A}/${p}`

// ---- assertion helpers ----
class NotApplicable extends Error {}
const eq = (actual, expected, label = 'value') => {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
const check = (cond, msg) => { if (!cond) throw new Error(msg) }
// Poll an async probe until it returns a truthy value; exceptions from the probe count as "not yet".
async function poll(fn, ms = 6000, step = 100) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; last = v } catch (e) { last = e }
    await sleep(step)
  }
  throw new Error('poll timed out; last=' + String((last && last.message) || last))
}

// ---- API-family adapter ----
let browser, context
const adapter = pptr
  ? {
      async launch(mod) {
        const api = mod.default?.launch ? mod.default : mod
        browser = await api.launch({ executablePath, headless: false, defaultViewport: null, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
        return browser.version()
      },
      connected: () => browser.connected ?? browser.isConnected?.() ?? true,
      newPage: () => browser.newPage(),
      pages: async () => Promise.race([browser.pages(), sleep(3000).then(() => [])]),
      browserCdp: async () => { const s = await browser.target().createCDPSession(); return s },
      workerEvent: 'workercreated',
      addInitScript: (page, fn) => page.evaluateOnNewDocument(fn),
      waitForFunction: (page, fn, timeout) => page.waitForFunction(fn, { timeout }),
      async interceptAll(page, onRequest) {
        await page.setRequestInterception(true)
        page.on('request', r => { onRequest(); r.continue() })
      },
      popup: page => new Promise(r => page.once('popup', r)),
    }
  : {
      async launch(mod) {
        const chromium = mod.chromium || mod.default?.chromium
        browser = await chromium.launch({ executablePath, headless: false, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
        const product = browser.version()
        context = await browser.newContext({ viewport: null })
        return product
      },
      connected: () => browser.isConnected?.() ?? true,
      newPage: () => context.newPage(),
      pages: async () => context.pages(),
      browserCdp: () => browser.newBrowserCDPSession(),
      workerEvent: 'worker',
      addInitScript: (page, fn) => page.addInitScript(fn),
      waitForFunction: (page, fn, timeout) => page.waitForFunction(fn, null, { timeout }),
      async interceptAll(page, onRequest) {
        await page.route('**/*', r => { onRequest(); r.continue().catch(() => {}) })
      },
      popup: page => page.waitForEvent('popup', { timeout: 8000 }),
    }

// ---- scenario runner ----
async function closeWithin(p, ms = 4000) {
  await Promise.race([Promise.resolve().then(() => p.close({ runBeforeUnload: false })).catch(() => {}), sleep(ms)])
}
async function runScenario(name, fn, { timeout = DEFAULT_TIMEOUT } = {}) {
  if (ONLY && !ONLY.includes(name)) return
  const t0 = Date.now()
  const rec = { name }
  if (!adapter.connected()) {
    results.push({ name, status: 'fail', ms: 0, error: 'browser disconnected' })
    return
  }
  let baseline = new Set()
  try { baseline = new Set(await adapter.pages()) } catch {}
  let timer
  const work = (async () => {
    const page = await adapter.newPage()
    return fn(page)
  })()
  work.catch(() => {})
  try {
    const out = await Promise.race([
      work,
      new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`scenario timeout after ${timeout}ms`), { isTimeout: true })), timeout) }),
    ])
    rec.status = 'ok'
    if (out !== undefined) rec.value = out
  } catch (e) {
    if (e instanceof NotApplicable) { rec.status = 'n-a'; rec.error = e.message }
    else if (e && e.isTimeout) { rec.status = 'timeout'; rec.error = e.message }
    else { rec.status = 'fail'; rec.error = String((e && e.message) || e).split('\n')[0].slice(0, 500) }
  } finally {
    clearTimeout(timer)
  }
  rec.ms = Date.now() - t0
  results.push(rec)
  // close this scenario's page(s), including popups; a page that will not close is abandoned
  try {
    const now = await adapter.pages()
    await Promise.all(now.filter(p => !baseline.has(p)).map(p => closeWithin(p)))
  } catch {}
}

// ---- main ----
let finished = false
let productName = null
function finish(code, extra = {}) {
  if (finished) return
  finished = true
  const out = { lib, mode, product: productName, results, ...extra }
  if (unhandled.length) out.unhandled = unhandled
  console.log(JSON.stringify(out))
  killTree()
  process.exit(code)
}
setTimeout(() => finish(0, { watchdog: true }), WATCHDOG_MS)

try {
  const mod = await import(lib)
  productName = await adapter.launch(mod)
} catch (e) {
  console.error('LAUNCH FAILED', String((e && e.stack) || e).slice(0, 1500))
  finish(2, { launchError: String((e && e.message) || e).split('\n')[0].slice(0, 500) })
}

// 1
await runScenario('evaluate-basic', async page => {
  await page.goto(urlA('main.html'))
  eq(await page.evaluate(() => 1 + 1), 2)
})

// 2 (reads a main-world JS global on purpose)
await runScenario('evaluate-main-world-global', async page => {
  await page.goto(urlA('main.html'))
  eq(await page.evaluate(() => window.pageVar), 42, 'window.pageVar (main-world global)')
})

// 3
await runScenario('dom-read', async page => {
  await page.goto(urlA('main.html'))
  eq(await page.$eval('#title', el => el.textContent), 'Hello Scen')
})

// 4
await runScenario('setContent', async page => {
  await page.setContent('<p id=x>hi</p>')
  eq(await page.$eval('#x', el => el.textContent), 'hi')
})

// 5
await runScenario('click', async page => {
  await page.goto(urlA('main.html'))
  await page.click('#btn')
  eq(await page.$eval('#btn', el => el.getAttribute('data-clicked')), 'yes', 'data-clicked')
})

// 6 (Playwright: fill sets the value directly; pressSequentially types key by key)
await runScenario('type-fill', async page => {
  await page.goto(urlA('main.html'))
  if (pptr) {
    await page.type('#inp', 'hello')
    await page.type('#inp2', 'world')
  } else {
    await page.fill('#inp', 'hello')
    await page.locator('#inp2').pressSequentially('world')
  }
  eq(await page.$eval('#inp', el => el.value), 'hello', '#inp.value')
  eq(await page.$eval('#inp2', el => el.value), 'world', '#inp2.value')
})

// 7
await runScenario('waitForSelector-delayed', async page => {
  await page.goto(urlA('delayed.html'))
  const t0 = Date.now()
  const handle = await page.waitForSelector('#late', { timeout: 8000 })
  const waited = Date.now() - t0
  check(handle, 'waitForSelector returned null')
  eq(await page.$eval('#late', el => el.textContent), 'late-ok')
  return { waitedMs: waited }
})

// 8 (Puppeteer issue #129 class)
await runScenario('waitForFunction-across-navigation', async page => {
  await page.goto(urlA('main.html'))
  let settled = false
  const w = adapter.waitForFunction(page, () => document.title === 'second', 10000)
  w.then(() => { settled = true }, () => {})
  await sleep(400)
  check(!settled, 'waitForFunction resolved before the navigation')
  await page.goto(urlA('second.html'))
  await w
  eq(await page.evaluate(() => document.title), 'second')
})

// 9
await runScenario('evaluate-after-navigation', async page => {
  await page.goto(urlA('main.html'))
  await page.goto(urlA('second.html'))
  eq(await page.evaluate(() => document.getElementById('title').textContent), 'Second Page')
})

// 10 (issue #97 class)
await runScenario('long-evaluate-5s', async page => {
  await page.goto(urlA('main.html'))
  eq(await page.evaluate(() => new Promise(r => setTimeout(() => r('done-5s'), 5000))), 'done-5s')
}, { timeout: 25000 })

// 11
await runScenario('concurrent-evaluates', async page => {
  await page.goto(urlA('main.html'))
  const out = await Promise.all([0, 1, 2, 3, 4].map(i =>
    page.evaluate(n => new Promise(r => setTimeout(() => r(n * 2), 50 * (5 - n))), i)))
  eq(JSON.stringify(out), '[0,2,4,6,8]', 'results')
})

const FRAME_EXPECT = o => `${o}|frame-ok`
async function frameOf(page, selector) {
  const handle = await page.waitForSelector(selector, { timeout: 8000 })
  return poll(() => handle.contentFrame(), 6000)
}
const readFrame = frame => frame.evaluate(() =>
  document.getElementById('origin').textContent + '|' + document.getElementById('fid').textContent)

// 12
await runScenario('iframe-same-origin', async page => {
  await page.goto(urlA('iframes.html'))
  const frame = await frameOf(page, '#same')
  const v = await poll(async () => { const r = await readFrame(frame); return r.startsWith('http') && r }, 6000)
  eq(v, FRAME_EXPECT(`http://127.0.0.1:${ports.A}`), 'frame DOM')
})

// 13 (cross-site child frame, rendered out-of-process under site isolation)
await runScenario('iframe-cross-site-oopif', async page => {
  await page.goto(urlA('iframes.html'))
  const frame = await frameOf(page, '#cross')
  const v = await poll(async () => { const r = await readFrame(frame); return r.startsWith('http') && r }, 6000)
  eq(v, FRAME_EXPECT(`http://localhost:${ports.B}`), 'frame DOM')
  // sanity: the fixture must really produce an out-of-process iframe target
  let oopif = null
  try {
    const s = await adapter.browserCdp()
    const { targetInfos } = await s.send('Target.getTargets')
    oopif = targetInfos.some(t => t.type === 'iframe' && t.url.includes(`localhost:${ports.B}`))
    await s.detach().catch(() => {})
  } catch {}
  check(oopif !== false, 'fixture invalid: cross-site frame is not an out-of-process iframe target')
  return { oopifTarget: oopif }
})

// 14
await runScenario('worker-evaluate', async page => {
  const workers = []
  page.on(adapter.workerEvent, w => workers.push(w))
  await page.goto(urlA('worker.html'))
  const w = await poll(() => workers[0] || page.workers()[0], 6000)
  eq(await w.evaluate(() => self.location.pathname + '|' + self.workerComputed), '/worker.js|42', 'worker value')
})

// 15
await runScenario('exposeFunction-called-by-page', async page => {
  await page.exposeFunction('nodeAdd', (a, b) => a + b)
  await page.goto(urlA('expose.html'))
  await page.click('#go')
  const v = await poll(async () => (await page.$eval('#out', el => el.textContent)) || false, 6000)
  eq(v, '5', '#out text')
})

// 16
await runScenario('init-script', async page => {
  await adapter.addInitScript(page, () => {
    const mark = () => { document.documentElement.dataset.init = '1' }
    if (document.documentElement) mark()
    else {
      const mo = new MutationObserver(() => { if (document.documentElement) { mo.disconnect(); mark() } })
      mo.observe(document, { childList: true })
    }
  })
  await page.goto(urlA('init.html'))
  eq(await page.$eval('html', el => el.dataset.init + '|' + el.dataset.initSeen), '1|1', 'data-init | seen-by-page-script')
})

// 17 (issue #118 class)
await runScenario('request-events', async page => {
  const urls = []
  page.on('request', r => urls.push(r.url()))
  await page.goto(urlA('events.html'))
  check(urls.length >= 1, 'no request events')
  check(urls.some(u => u.endsWith('/img.png')), 'no request event for img.png')
  check(urls.some(u => u.endsWith('/ext.js')), 'no request event for ext.js')
  return { requests: urls.length }
})

// 18
await runScenario('request-interception', async page => {
  let n = 0
  await adapter.interceptAll(page, () => { n++ })
  await page.goto(urlA('events.html'))
  eq(await page.$eval('#title', el => el.textContent), 'Events Page')
  eq(await page.$eval('html', el => el.getAttribute('data-ext')), '1', 'subresource script ran')
  check(n >= 3, `only ${n} intercepted requests`)
  return { intercepted: n }
})

// 19
await runScenario('popup-window-open', async page => {
  await page.goto(urlA('popup.html'))
  const popupP = adapter.popup(page)
  await page.click('#open')
  const popup = await popupP
  check(popup, 'popup event gave no page')
  const v = await poll(async () => (await popup.$eval('#title', el => el.textContent)) || false, 6000)
  eq(v, 'Popup Page')
})

// 20
await runScenario('reload-then-evaluate', async page => {
  await page.goto(urlA('reload.html'))
  eq(await page.evaluate(() => document.getElementById('loads').textContent), '1', 'loads before reload')
  await page.reload()
  eq(await page.evaluate(() => document.getElementById('loads').textContent), '2', 'loads after reload')
})

// 21
await runScenario('elementHandle-evaluate', async page => {
  await page.goto(urlA('main.html'))
  const handle = await page.$('#title')
  check(handle, '$("#title") returned null')
  eq(await handle.evaluate(el => el.tagName), 'H1')
})

if (pptr) {
  // 22 (Puppeteer only)
  await runScenario('isolatedRealm-evaluate', async page => {
    await page.goto(urlA('main.html'))
    const frame = page.mainFrame()
    if (typeof frame.isolatedRealm !== 'function') throw new NotApplicable('frame.isolatedRealm not present')
    eq(await frame.isolatedRealm().evaluate(() => document.title), 'first', 'document.title via isolatedRealm')
  })
} else {
  // 22 (Playwright only; issue #81: export, then restore several origins)
  await runScenario('storageState', async page => {
    await page.goto(urlA('main.html'))
    await page.evaluate(() => localStorage.setItem('scen-key', 'scen-val'))
    const state = await page.context().storageState()
    const origin = (state.origins || []).find(o => o.origin === `http://127.0.0.1:${ports.A}`)
    check(origin, `storageState has no origin entry for 127.0.0.1:${ports.A}: ${JSON.stringify(state.origins)}`)
    const item = origin.localStorage.find(i => i.name === 'scen-key')
    eq(item && item.value, 'scen-val', 'storageState localStorage scen-key')
    // restore several origins into a new context (issue #81: this hung in alwaysIsolated mode)
    const restored = await browser.newContext({
      viewport: null,
      storageState: {
        cookies: [],
        origins: [
          { origin: `http://127.0.0.1:${ports.A}`, localStorage: [{ name: 'k', value: 'A' }] },
          { origin: `http://localhost:${ports.B}`, localStorage: [{ name: 'k', value: 'B' }] },
        ],
      },
    })
    try {
      const p = await restored.newPage()
      await p.goto(urlA('main.html'))
      eq(await p.evaluate(() => localStorage.getItem('k')), 'A', 'restored localStorage on site A')
      await p.goto(`http://localhost:${ports.B}/main.html`)
      eq(await p.evaluate(() => localStorage.getItem('k')), 'B', 'restored localStorage on site B')
    } finally {
      await restored.close().catch(() => {})
    }
  })
}

// 23 (issue #129 class, the selector flavour)
await runScenario('waitForSelector-across-navigation', async page => {
  await page.goto(urlA('main.html'))
  let settled = false
  const wait = page.waitForSelector('h1[data-page="second"]', { timeout: 10000 })
  wait.then(() => { settled = true }, () => {})
  await sleep(400)
  check(!settled, 'waitForSelector resolved before the navigation')
  await page.goto(urlA('second.html'))
  check(await wait, 'waitForSelector returned null')
})

// 24 (issue #86 class: an in-process child frame without its own URL)
await runScenario('iframe-srcdoc', async page => {
  await page.goto(urlA('iframes.html'))
  const frame = await frameOf(page, '#srcdoc')
  const v = await poll(async () => { const r = await readFrame(frame); return r.startsWith('srcdoc') && r }, 6000)
  eq(v, FRAME_EXPECT('srcdoc'), 'frame DOM')
})

// 25 (issues #100, #116: the page reassigns the global `self`)
await runScenario('page-reassigns-self', async page => {
  await page.goto(urlA('self-reassigned.html'))
  eq(await page.evaluate(() => document.getElementById('title').textContent), 'Self Reassigned')
  check(await page.waitForSelector('#title', { timeout: 8000 }), 'waitForSelector returned null')
})

// 26 (issue #59: the page turns `self` into a throwing getter, like LavaMoat on MetaMask pages)
await runScenario('page-scuttles-self', async page => {
  await page.goto(urlA('self-scuttled.html'))
  eq(await page.evaluate(() => document.getElementById('title').textContent), 'Self Scuttled')
  check(await page.waitForSelector('#title', { timeout: 8000 }), 'waitForSelector returned null')
})

// 27 (issues #97, #115: frames attaching and detaching must not destroy the main frame's pending evaluate)
await runScenario('iframe-churn-long-evaluate', async page => {
  await page.goto(urlA('churn.html'))
  const long = page.evaluate(() => new Promise(r => setTimeout(() => r('long-ok'), 5000)))
  for (let i = 0; i < 20; i++) {
    eq(await page.evaluate(() => document.getElementById('title').textContent), 'Churn', `short evaluate #${i}`)
    await sleep(100)
  }
  eq(await long, 'long-ok', 'long evaluate')
}, { timeout: 25000 })

// 28 (issue #69: the page calls the exposed function while the document is still loading)
await runScenario('exposeFunction-called-on-load', async page => {
  await page.exposeFunction('nodeAdd', (a, b) => a + b)
  await page.goto(urlA('expose-early.html'))
  const v = await poll(async () => (await page.$eval('#out', el => el.textContent)) || false, 6000)
  eq(v, '5', '#out text')
})

// 29 (issue #69: the exposed function must survive a reload)
await runScenario('exposeFunction-after-reload', async page => {
  await page.exposeFunction('nodeAdd', (a, b) => a + b)
  await page.goto(urlA('expose.html'))
  await page.click('#go')
  eq(await poll(async () => (await page.$eval('#out', el => el.textContent)) || false, 6000), '5', '#out before reload')
  await page.reload()
  await page.click('#go')
  eq(await poll(async () => (await page.$eval('#out', el => el.textContent)) || false, 6000), '5', '#out after reload')
})

// ---- shutdown: clean close with a deadline, then reap anything left over ----
await Promise.race([Promise.resolve().then(() => browser.close()).catch(() => {}), sleep(10000)])
finish(0)
