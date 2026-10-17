// Suite "smoke": package-level checks on the built tarballs.
//   for every core tarball:   installs, version matches, CJS require(), ESM import(), `tsc --noEmit` against a tiny .ts
//   for every wrapper tarball (rebrowser-puppeteer / rebrowser-playwright), in its own project with the LOCAL core
//   tarball injected (the wrapper pins a core version that is not on npm yet):
//       exact pin of the core (npm:rebrowser-...@<core version>, no range), resolves to the local patched core,
//       CJS / ESM / types, launches a browser and evaluates; rebrowser-puppeteer: its postinstall browser download
//       works (skipped with a note when the network is unreachable)
import fs from 'node:fs'
import path from 'node:path'
import { newSuite } from '../lib/report.mjs'
import { run as runCmd, tail } from '../lib/util.mjs'
import { npmInstall, stageWorkers, upstreamName } from '../lib/project.mjs'

const NETWORK_ERROR = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|getaddrinfo|fetch failed|socket hang up|network/i

const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'))

function typesFile(name, family) {
  return family === 'pptr'
    ? `import puppeteer, { type Browser, type Page } from '${name}'

export async function main(): Promise<string> {
  const browser: Browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] })
  const page: Page = await browser.newPage()
  await page.goto('about:blank')
  const title: string = await page.evaluate(() => document.title)
  await browser.close()
  return title
}
`
    : `import { chromium, type Browser, type Page } from '${name}'

export async function main(): Promise<string> {
  const browser: Browser = await chromium.launch({ headless: true })
  const page: Page = await browser.newPage()
  await page.goto('about:blank')
  const title: string = await page.evaluate(() => document.title)
  await browser.close()
  return title
}
`
}

/** Installed version, CJS require, ESM import and tsc against the types, for package `name` installed in `dir`. */
async function checkPackage(ctx, s, { dir, name, family, version, tsc }) {
  const gate = (id, ok, detail) => s.gate(`${name}/${id}`, ok, detail)
  let installed = null
  try { installed = readJson(path.join(dir, 'node_modules', name, 'package.json')) } catch {}
  gate('installed', installed && installed.name === name && installed.version === version, installed ? `${installed.name}@${installed.version}` : 'not installed')
  if (!installed) return
  for (const [id, file] of [['cjs-require', 'smoke-cjs.cjs'], ['esm-import', 'smoke-esm.mjs']]) {
    const r = await runCmd('node', [path.join(dir, 'workers', file), name, family], { cwd: dir, tmp: ctx.tmp, timeoutMs: 120000 })
    gate(id, r.code === 0, r.code === 0 ? 'ok' : tail(r.stderr || r.stdout, 400))
  }
  const dirTypes = path.join(dir, 'smoke-types')
  fs.mkdirSync(dirTypes, { recursive: true })
  const base = name.replace(/[^a-z0-9]+/gi, '-')
  fs.writeFileSync(path.join(dirTypes, `${base}.ts`), typesFile(name, family))
  fs.writeFileSync(path.join(dir, `tsconfig.${base}.json`), JSON.stringify({
    compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022', lib: ['es2022', 'dom'], types: ['node'], strict: true, noEmit: true, skipLibCheck: true },
    files: [`smoke-types/${base}.ts`],
  }, null, 2))
  const t = await runCmd('node', [tsc, '-p', `tsconfig.${base}.json`], { cwd: dir, tmp: ctx.tmp, timeoutMs: 300000 })
  gate('types-tsc', t.code === 0, t.code === 0 ? 'tsc --noEmit ok' : tail(t.stdout || t.stderr, 600))
}

async function wrapperSmoke(ctx, s, fam) {
  const w = fam.wrapper
  const coreName = upstreamName(fam.patched.name) // 'puppeteer-core' / 'playwright-core': the name the wrapper depends on
  const gate = (id, ok, detail) => s.gate(`${w.name}/${id}`, ok, detail)

  const pin = w.dependencies[coreName]
  const want = `npm:${fam.patched.name}@${fam.patched.version}`
  gate('pins-core-exactly', pin === want, `dependencies.${coreName} = ${pin}, expected ${want}`)

  const dir = path.join(ctx.runDir, `wrapper-${fam.key}`)
  fs.mkdirSync(dir, { recursive: true })
  const cacheDir = path.join(ctx.runDir, 'puppeteer-cache') // fresh per run: a stale cache would hide a postinstall that downloads nothing
  const pkgJson = {
    name: `wrapper-smoke-${fam.key}`,
    private: true,
    type: 'module',
    dependencies: { [w.name]: `file:${w.file}`, typescript: '5', '@types/node': '22' },
    overrides: { [coreName]: `file:${fam.patched.file}` },
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkgJson, null, 2))

  // rebrowser-puppeteer has a postinstall that downloads a browser: run it for real (with scripts) into a cache dir
  const withScripts = fam.key === 'pptr'
  const env = { PUPPETEER_CACHE_DIR: cacheDir, PUPPETEER_SKIP_DOWNLOAD: undefined, PUPPETEER_SKIP_CHROME_DOWNLOAD: undefined }
  let r = await npmInstall(dir, { scripts: withScripts, env })
  if (withScripts) {
    // install.mjs prints a warning and still exits 0 when the download (or the installer import) fails, so look at the result
    const out = r.stderr + r.stdout
    let found = []
    try { found = fs.readdirSync(path.join(cacheDir, 'chrome')) } catch {}
    if (r.code === 0 && found.length > 0) {
      gate('postinstall-browser', true, `postinstall downloaded ${found.join(', ')}`)
    } else if (NETWORK_ERROR.test(out) && /Browser download failed|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/.test(out)) {
      s.note(`${w.name}: postinstall browser download SKIPPED (network unreachable): ${tail(out, 300).replace(/\s+/g, ' ')}`)
    } else {
      gate('postinstall-browser', false, r.code === 0
        ? `postinstall exited 0 but downloaded no browser (${cacheDir}/chrome is empty). npm output: ${tail(out, 400).replace(/\s+/g, ' ')}`
        : `npm install (with postinstall) failed: ${tail(out, 500)}`)
    }
    if (r.code !== 0) {
      fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true })
      r = await npmInstall(dir, { scripts: false, env })
    }
  }
  if (r.code !== 0) { gate('install', false, tail(r.stderr || r.stdout, 600)); return }
  gate('install', true, 'npm install ok')
  stageWorkers(dir)

  let core = null
  try { core = readJson(path.join(dir, 'node_modules', coreName, 'package.json')) } catch {}
  gate('resolves-local-patched-core', core && core.name === fam.patched.name && core.version === fam.patched.version,
    core ? `node_modules/${coreName} is ${core.name}@${core.version}` : `node_modules/${coreName} missing`)

  await checkPackage(ctx, s, { dir, name: w.name, family: fam.key, version: w.version, tsc: path.join(dir, 'node_modules', 'typescript', 'bin', 'tsc') })
  const l = await runCmd('node', [path.join(dir, 'workers', 'launch-check.mjs'), w.name, fam.key, ctx.chrome.path], { cwd: dir, display: true, tmp: ctx.tmp, timeoutMs: 120000 })
  gate('launch-and-evaluate', l.code === 0, l.code === 0 ? 'launched a browser and evaluated 1 + 1' : tail(l.stderr || l.stdout, 400))
}

export async function run(ctx) {
  const s = newSuite('smoke')
  for (const fam of [ctx.project.pptr, ctx.project.pw]) {
    if (!fam) continue
    ctx.log(`[smoke] ${fam.patched.name}`)
    await checkPackage(ctx, s, { dir: ctx.project.dir, name: fam.patched.name, family: fam.key, version: fam.patched.version, tsc: ctx.project.tsc })
    if (fam.wrapper) {
      ctx.log(`[smoke] ${fam.wrapper.name}`)
      await wrapperSmoke(ctx, s, fam)
    }
  }
  for (const g of s.gates) s.line(`${g.ok ? 'PASS' : 'FAIL'}  ${g.id}${g.detail ? '  -- ' + g.detail.split('\n')[0].slice(0, 140) : ''}`)
  s.rows = s.gates.map(g => ({ check: g.id, pass: g.ok, detail: g.detail }))
  return s.finish()
}
