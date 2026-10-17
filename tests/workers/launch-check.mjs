// Launches a browser through <importName> and evaluates 1 + 1. Used for the wrapper-package smoke test.
// usage: node launch-check.mjs <importName> <pptr|pw> <chromePath>
// Prints one JSON line { sum }. Exit 1 on failure.
const [lib, family, executablePath] = process.argv.slice(2)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let browser
let out
try {
  const mod = await import(lib)
  let page
  if (family === 'pptr') {
    const api = mod.default?.launch ? mod.default : mod
    browser = await api.launch({ executablePath, headless: false, defaultViewport: null, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await browser.newPage()
  } else {
    const chromium = mod.chromium || mod.default?.chromium
    browser = await chromium.launch({ executablePath, headless: false, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    page = await (await browser.newContext({ viewport: null })).newPage()
  }
  await page.goto('about:blank')
  out = { sum: await page.evaluate(() => 1 + 1) }
} catch (e) {
  console.error('FAILED', lib, String((e && e.message) || e).slice(0, 400))
}
try { await Promise.race([browser?.close(), sleep(10000)]) } catch {}
if (out) console.log(JSON.stringify(out))
process.exit(out && out.sum === 2 ? 0 : 1)
