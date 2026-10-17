// Chrome acquisition for the tests.
//   --chrome <path>      use as is
//   linux-arm64          official Google arm64 .deb, extracted with `dpkg-deb -x` (no root, nothing installed)
//   everything else      Chrome for Testing stable via `npx @puppeteer/browsers install chrome@stable`
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { run, tail } from './util.mjs'

const DEB_URL = 'https://dl.google.com/linux/direct/google-chrome-stable_current_arm64.deb'
const MAX_AGE_MS = 7 * 24 * 3600 * 1000 // "stable" moves; refresh the cached arm64 build weekly

async function chromeVersion(chrome) {
  const r = await run(chrome, ['--version'], { timeoutMs: 30000 })
  const out = (r.stdout || r.stderr).trim()
  if (r.code !== 0 || !/chrome|chromium/i.test(out)) throw new Error(`cannot run ${chrome} --version (exit ${r.code}): ${tail(r.stderr || r.stdout)}`)
  return out
}

async function acquireArm64Deb(browsersDir, log) {
  const dir = path.join(browsersDir, 'chrome-stable-arm64')
  const chrome = path.join(dir, 'extract', 'opt', 'google', 'chrome', 'chrome')
  const deb = path.join(dir, 'google-chrome-stable_current_arm64.deb')
  const fresh = fs.existsSync(chrome) && fs.existsSync(deb) && Date.now() - fs.statSync(deb).mtimeMs < MAX_AGE_MS
  if (fresh) return chrome
  fs.mkdirSync(dir, { recursive: true })
  log(`downloading ${DEB_URL}`)
  const res = await fetch(DEB_URL, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${DEB_URL}`)
  const part = deb + '.part'
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part))
  fs.renameSync(part, deb)
  const tmpExtract = path.join(dir, 'extract.tmp')
  fs.rmSync(tmpExtract, { recursive: true, force: true })
  const x = await run('dpkg-deb', ['-x', deb, tmpExtract], { timeoutMs: 300000 })
  if (x.code !== 0) throw new Error(`dpkg-deb -x failed: ${tail(x.stderr)}`)
  fs.rmSync(path.join(dir, 'extract'), { recursive: true, force: true })
  fs.renameSync(tmpExtract, path.join(dir, 'extract'))
  if (!fs.existsSync(chrome)) throw new Error(`chrome binary not found after extraction: ${chrome}`)
  return chrome
}

export async function acquireCfT(browsersDir, log) {
  fs.mkdirSync(browsersDir, { recursive: true })
  log('npx @puppeteer/browsers install chrome@stable')
  const r = await run('npx', ['--yes', '@puppeteer/browsers', 'install', 'chrome@stable', '--path', browsersDir], { timeoutMs: 900000, env: { NODE_ENV: undefined } })
  if (r.code !== 0) throw new Error(`@puppeteer/browsers install failed (exit ${r.code}): ${tail(r.stderr || r.stdout)}`)
  const line = r.stdout.split('\n').map(l => l.trim()).reverse().find(l => /^chrome@\S+\s+/.test(l))
  const chrome = line && line.replace(/^chrome@\S+\s+/, '')
  if (!chrome || !fs.existsSync(chrome)) throw new Error(`could not find the installed chrome path in: ${tail(r.stdout)}`)
  return chrome
}

/** Resolves { path, version, source }. */
export async function acquireChrome({ chrome, work, log }) {
  if (chrome) {
    const p = path.resolve(chrome)
    if (!fs.existsSync(p)) throw new Error(`--chrome ${p} does not exist`)
    return { path: p, version: await chromeVersion(p), source: '--chrome' }
  }
  const browsersDir = path.join(work, 'browsers')
  const arm64Linux = process.platform === 'linux' && process.arch === 'arm64'
  const p = arm64Linux ? await acquireArm64Deb(browsersDir, log) : await acquireCfT(browsersDir, log)
  return { path: p, version: await chromeVersion(p), source: arm64Linux ? 'google-chrome-stable arm64 .deb' : 'Chrome for Testing stable' }
}
