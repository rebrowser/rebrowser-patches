// ESM import smoke check.
// usage: node smoke-esm.mjs <packageName> <pptr|pw>
const [name, family] = process.argv.slice(2)
const m = await import(name)
const api = family === 'pptr' ? (m.launch ? m : m.default) : (m.chromium || m.default?.chromium)
if (!api || typeof api.launch !== 'function') {
  console.error(`import('${name}') has no ${family === 'pptr' ? 'launch' : 'chromium.launch'}; keys: ${Object.keys(m).slice(0, 15)}`)
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, kind: 'esm', name }))
