// Launches Firefox or WebKit through a Playwright build: the Chromium-only patches must stay out of the way
// (issues #105, #112, #126: the 1.52 build crashed on non-Chromium pages with "_sessions is undefined").
// usage: node nonchromium.mjs <importName> <firefox|webkit> <url>
// Prints one JSON line { title, frames, reloaded }. Exit 1 on failure.
const [lib, browserName, url] = process.argv.slice(2)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let browser
let out
try {
  const mod = await import(lib)
  const type = mod[browserName] || mod.default?.[browserName]
  browser = await type.launch({ headless: true })
  const page = await browser.newPage()
  await page.goto(url, { waitUntil: 'load', timeout: 30000 })
  const title = await page.evaluate(() => document.getElementById('title').textContent)
  const frames = page.frames().length
  await page.reload({ waitUntil: 'load', timeout: 30000 })
  const reloaded = await page.evaluate(() => document.getElementById('title').textContent)
  out = { title, frames, reloaded }
} catch (e) {
  console.error('FAILED', lib, browserName, String((e && e.message) || e).slice(0, 400))
}
try { await Promise.race([browser?.close(), sleep(10000)]) } catch {}
if (out) console.log(JSON.stringify(out))
process.exit(out ? 0 : 1)
