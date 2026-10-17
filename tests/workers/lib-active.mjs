// Drives a page with an automation library while fixtures/poc2.html probes run on it (the probes report to the
// fixture server by themselves). The library keeps working until the probe page has finished, so the activity
// (exposeFunction, goto, evaluate, $eval, waitForFunction) overlaps the whole 8 s probe window.
// usage: node lib-active.mjs <importName> <pptr|pw> <chromePath> <url>
// The patch mode comes from REBROWSER_PATCHES_RUNTIME_FIX_MODE in the environment. Exits non-zero on any failure.
const [lib, family, executablePath, url] = process.argv.slice(2)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const isPptr = family === 'pptr'
const steps = []
let browser
let failed = false
try {
  const mod = await import(lib)
  let page
  if (isPptr) {
    const api = mod.default?.launch ? mod.default : mod
    browser = await api.launch({ executablePath, headless: false, defaultViewport: null, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage()
  } else {
    const chromium = mod.chromium || mod.default?.chromium
    browser = await chromium.launch({ executablePath, headless: false, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await (await browser.newContext({ viewport: null })).newPage()
  }
  await page.exposeFunction('exposedFn', () => 1)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  const deadline = Date.now() + 30000
  let finished = false
  for (let i = 0; Date.now() < deadline; i++) {
    steps.push(['evaluate', await page.evaluate(() => document.title)])
    steps.push(['query', await page.$eval('pre', el => el.tagName)])
    if (i === 3) {
      if (isPptr) await page.waitForFunction(() => document.readyState === 'complete', { timeout: 5000 })
      else await page.waitForFunction(() => document.readyState === 'complete', null, { timeout: 5000 })
      steps.push(['waitForFunction', 'ok'])
    }
    finished = await page.evaluate(() => (document.getElementById('out')?.textContent || '').length > 0)
    if (finished && i >= 9) break
    await sleep(600)
  }
  if (!finished) throw new Error('the probe page did not finish within 30 s')
} catch (e) {
  failed = true
  console.error('FAILED', lib, String((e && e.message) || e).slice(0, 400))
}
try { await Promise.race([browser?.close(), sleep(10000)]) } catch {}
console.log(JSON.stringify({ lib, mode: process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE || 'default', steps: steps.length, failed }))
process.exit(failed ? 1 : 0)
