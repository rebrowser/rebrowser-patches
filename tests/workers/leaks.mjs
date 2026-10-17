// Reads two automation tells through a normal launch:
//   stack:       Error().stack thrown inside page.evaluate (library names like "UtilityScript." or "pptr:" leak here)
//   commandLine: the browser command line from chrome://version (--enable-automation shows the "controlled by
//                automated test software" bar)
//   binding:     with page.exposeFunction() in use, what a page sees after a navigation: the CDP binding while the
//                document is still parsing (must be missing or native, never a JS stand-in) and the source of the
//                page-visible functions (must not name rebrowser-patches)
// usage: node leaks.mjs <importName> <pptr|pw> <chromePath> <url>
// Prints one JSON line { stack, commandLine, binding }. Exit 1 on failure.
const [lib, family, executablePath, url] = process.argv.slice(2)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const args = ['--no-sandbox', '--disable-dev-shm-usage']
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
  const stack = await page.evaluate(() => { try { null.x } catch (e) { return e.stack } })
  await page.goto('chrome://version', { waitUntil: 'load', timeout: 30000 })
  const commandLine = await page.evaluate(() => document.getElementById('command_line')?.textContent || '')
  // a fresh page: expose a function, then navigate twice so the binding goes through a navigation
  const page2 = family === 'pptr' ? await browser.newPage() : await page.context().newPage()
  await page2.exposeFunction('nodeAdd', (a, b) => a + b)
  await page2.goto(url, { waitUntil: 'load', timeout: 30000 })
  await page2.goto(url.replace(/[^/]*$/, 'expose-parse.html'), { waitUntil: 'load', timeout: 30000 })
  const binding = await page2.evaluate(() => {
    const controller = window.__playwright__binding__controller__
    const sources = [String(window.nodeAdd), controller ? String(controller.callBinding) + String(controller.addBinding) : '']
    return { parse: window.__parse, marker: sources.some(src => /rebrowser/i.test(src)) }
  })
  out = { stack, commandLine, binding }
} catch (e) {
  console.error('FAILED', lib, String((e && e.message) || e).slice(0, 400))
}
try { await Promise.race([browser?.close(), sleep(10000)]) } catch {}
if (out) console.log(JSON.stringify(out))
process.exit(out ? 0 : 1)
