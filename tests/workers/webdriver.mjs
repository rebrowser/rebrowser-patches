// Reads navigator.webdriver through a normal page.evaluate.
// usage: node webdriver.mjs <importName> <pptr|pw> <chromePath> <url> [extraChromeArg ...]
// Prints one JSON line { webdriver, ua }. Exit 1 on failure.
const [lib, family, executablePath, url, ...extraArgs] = process.argv.slice(2)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const args = ['--no-sandbox', '--disable-dev-shm-usage', ...extraArgs]
let browser
let out
try {
  const mod = await import(lib)
  let page
  if (family === 'pptr') {
    const api = mod.default?.launch ? mod.default : mod
    browser = await api.launch({ executablePath, headless: false, defaultViewport: null, args })
    page = await browser.newPage()
  } else {
    const chromium = mod.chromium || mod.default?.chromium
    browser = await chromium.launch({ executablePath, headless: false, args })
    page = await (await browser.newContext({ viewport: null })).newPage()
  }
  await page.goto(url, { waitUntil: 'load', timeout: 30000 })
  out = await page.evaluate(() => ({ webdriver: navigator.webdriver === undefined ? 'undefined' : navigator.webdriver, ua: navigator.userAgent }))
} catch (e) {
  console.error('FAILED', lib, String((e && e.message) || e).slice(0, 400))
}
try { await Promise.race([browser?.close(), sleep(10000)]) } catch {}
if (out) console.log(JSON.stringify(out))
process.exit(out ? 0 : 1)
