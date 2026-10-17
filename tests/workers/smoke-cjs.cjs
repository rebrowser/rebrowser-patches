// CommonJS require() smoke check (puppeteer 25 ships ESM only, so this relies on require(esm), Node >= 22.12).
// usage: node smoke-cjs.cjs <packageName> <pptr|pw>
const [name, family] = process.argv.slice(2)
const m = require(name)
const api = family === 'pptr' ? (m.launch ? m : m.default) : m.chromium
if (!api || typeof api.launch !== 'function') {
  console.error(`require('${name}') has no ${family === 'pptr' ? 'launch' : 'chromium.launch'}; keys: ${Object.keys(m).slice(0, 15)}`)
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, kind: 'cjs', name }))
