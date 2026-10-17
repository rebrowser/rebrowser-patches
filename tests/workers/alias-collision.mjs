// Alias-collision check (#74): with the upstream package of the same version installed next to the wrapper,
// the wrapper must still get the PATCHED core (rebrowser-*-core). When the wrapper depended on the core through an
// npm alias ("puppeteer-core": "npm:rebrowser-puppeteer-core@V"), npm deduped it to the real puppeteer-core.
// Resolves the core from the wrapper's own directory, like the wrapper's code does, checks that it is the patched
// one, and then checks the identity of what the wrapper actually exports: it must be the very object / class of the
// patched core and not the upstream core's (a wrapper whose code still loads 'playwright-core' resolves the patched
// core fine, it just never uses it).
//   puppeteer-core (ESM only): the wrapper's default export is a PuppeteerNode created inside the wrapper;
//     it must be an instance of the patched core's PuppeteerNode and of no upstream PuppeteerNode
//   playwright-core: require() and import() of the wrapper must give the patched core's `chromium`, not upstream's
// Run from <project>/workers.
// usage: node alias-collision.mjs <wrapperName> <coreName> <coreVersion> <upstreamName> <upstreamVersion>
//   e.g. rebrowser-puppeteer rebrowser-puppeteer-core 25.14.0 puppeteer 25.14.0
// Prints one JSON line. Exit 1 on failure.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [wrapperName, coreName, coreVersion, upstreamName, upstreamVersion] = process.argv.slice(2)
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const upstreamCoreName = coreName.replace(/^rebrowser-/, '')
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const fail = msg => { console.error(msg); process.exit(1) }

/** First .js/.mjs/.cjs file below dir that mentions rebrowser-patches (only patched cores have one). */
function findPatchedFile(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue
      const found = findPatchedFile(p)
      if (found) return found
    } else if (/\.[cm]?js$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('rebrowser-patches')) {
      return p
    }
  }
  return null
}

// the collision must be real, otherwise the check proves nothing
let upstream = null
try { upstream = readJson(path.join(project, 'node_modules', upstreamName, 'package.json')) } catch {}
if (!upstream || upstream.name !== upstreamName || upstream.version !== upstreamVersion) {
  fail(`${upstreamName}@${upstreamVersion} is not installed next to ${wrapperName} (found ${upstream ? `${upstream.name}@${upstream.version}` : 'nothing'}), nothing to collide with`)
}

const fromWrapper = createRequire(path.join(project, 'node_modules', wrapperName, 'package.json'))
let corePackageJson
try {
  corePackageJson = fromWrapper.resolve(`${coreName}/package.json`)
} catch (e) {
  let other = ''
  try {
    const p = fromWrapper.resolve(`${upstreamCoreName}/package.json`)
    const j = readJson(p)
    other = `; ${upstreamCoreName} resolves to the UNPATCHED ${j.name}@${j.version} (${path.relative(project, path.dirname(p))})`
  } catch {}
  fail(`${wrapperName} cannot resolve ${coreName} (${e.code || e.message})${other}`)
}
const core = readJson(corePackageJson)
if (core.name !== coreName || core.version !== coreVersion) {
  fail(`${wrapperName} resolves ${coreName} to ${core.name}@${core.version} (${path.relative(project, path.dirname(corePackageJson))}), expected ${coreName}@${coreVersion}`)
}
// patched code below the entry point the wrapper loads (lib/puppeteer/ for puppeteer-core, the whole package for playwright-core)
const coreEntry = fromWrapper.resolve(coreName)
const patched = findPatchedFile(path.dirname(coreEntry))
if (!patched) fail(`${core.name}@${core.version} (${path.relative(project, path.dirname(corePackageJson))}) has no file that mentions rebrowser-patches: not the patched core`)

const rel = file => path.relative(project, file)

// the collision's other side: the core the upstream package itself loads
let upstreamCoreEntry
try {
  upstreamCoreEntry = createRequire(path.join(project, 'node_modules', upstreamName, 'package.json')).resolve(upstreamCoreName)
} catch (e) {
  fail(`${upstreamName}@${upstreamVersion} cannot resolve its own ${upstreamCoreName} (${e.code || e.message}), nothing to tell the patched core apart from`)
}
if (fs.realpathSync(upstreamCoreEntry) === fs.realpathSync(coreEntry)) {
  fail(`${wrapperName} and ${upstreamName} load the same ${upstreamCoreName} file (${rel(coreEntry)})`)
}

const checked = []
const must = (ok, what, msg) => { if (!ok) fail(`${wrapperName} ${msg}`); checked.push(what) }

if (upstreamCoreName === 'puppeteer-core') {
  let wrapperModule, coreModule, upstreamModule
  try {
    wrapperModule = await import(wrapperName)
    coreModule = await import(pathToFileURL(coreEntry).href)
    upstreamModule = await import(pathToFileURL(upstreamCoreEntry).href)
  } catch (e) {
    fail(`import('${wrapperName}') failed next to ${upstreamName}@${upstreamVersion}: ${String((e && e.message) || e).slice(0, 300)}`)
  }
  const instance = wrapperModule.default
  must(typeof coreModule.PuppeteerNode === 'function' && typeof upstreamModule.PuppeteerNode === 'function', 'PuppeteerNode exported by both cores',
    `check: ${coreName} or ${upstreamCoreName} does not export the PuppeteerNode class`)
  must(instance && typeof instance === 'object', 'default export is an object', `has no default export object (got ${typeof instance})`)
  must(!(instance instanceof upstreamModule.PuppeteerNode), 'default export is no upstream PuppeteerNode',
    `default export is an instance of the UPSTREAM ${upstreamCoreName} PuppeteerNode (${rel(upstreamCoreEntry)}): its code still loads ${upstreamCoreName}`)
  must(instance instanceof coreModule.PuppeteerNode && Object.getPrototypeOf(instance).constructor === coreModule.PuppeteerNode, 'default export is a patched PuppeteerNode',
    `default export is not an instance of the PuppeteerNode of ${coreName} (${rel(coreEntry)})`)
  must(wrapperModule.PuppeteerNode === coreModule.PuppeteerNode, 'PuppeteerNode re-export is the patched one',
    `exports a PuppeteerNode that is not the one of ${coreName} (${rel(coreEntry)})`)
} else if (upstreamCoreName === 'playwright-core') {
  const requireFromProject = createRequire(path.join(project, 'package.json'))
  let wrapperCjs, wrapperEsm, coreCjs, upstreamCjs
  try {
    wrapperCjs = requireFromProject(wrapperName)
    wrapperEsm = await import(wrapperName)
    coreCjs = requireFromProject(coreEntry)
    upstreamCjs = requireFromProject(upstreamCoreEntry)
  } catch (e) {
    fail(`loading '${wrapperName}' failed next to ${upstreamName}@${upstreamVersion}: ${String((e && e.message) || e).slice(0, 300)}`)
  }
  must(coreCjs.chromium && upstreamCjs.chromium && coreCjs.chromium !== upstreamCjs.chromium, 'two distinct cores each export chromium',
    `check: ${coreName} and ${upstreamCoreName} do not export two distinct chromium objects`)
  for (const [kind, chromium] of [['require()', wrapperCjs.chromium], ['import()', wrapperEsm.chromium]]) {
    must(chromium !== upstreamCjs.chromium, `${kind} chromium is no upstream chromium`,
      `${kind} exports the UPSTREAM ${upstreamCoreName} chromium (${rel(upstreamCoreEntry)}): its code still loads ${upstreamCoreName}`)
    must(chromium === coreCjs.chromium, `${kind} chromium is the patched one`,
      `${kind} exports a chromium that is not the one of ${coreName} (${rel(coreEntry)})`)
  }
} else {
  fail(`unknown core ${upstreamCoreName}: no identity check for it`)
}

console.log(JSON.stringify({
  ok: true,
  core: `${core.name}@${core.version}`,
  coreDir: path.relative(project, path.dirname(corePackageJson)),
  patchedFile: path.relative(path.dirname(corePackageJson), patched),
  upstream: `${upstream.name}@${upstream.version}`,
  checked,
}))
