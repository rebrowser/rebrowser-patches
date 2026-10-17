// Throwaway npm project: the patched tarballs under test + the unpatched upstream of the same version
// (the positive controls) + typescript for the type checks. Lives under the work dir, never in the repo.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, tail } from './util.mjs'

export const TESTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function inspectTarball(file) {
  const r = await run('tar', ['-xzOf', file, 'package/package.json'], { timeoutMs: 60000 })
  if (r.code !== 0) throw new Error(`cannot read package/package.json from ${file}: ${tail(r.stderr)}`)
  const pkg = JSON.parse(r.stdout)
  return { file, name: pkg.name, version: pkg.version, dependencies: pkg.dependencies || {} }
}

/** upstream package name of a rebrowser-* package: rebrowser-puppeteer-core -> puppeteer-core */
export const upstreamName = name => name.replace(/^rebrowser-/, '')

export async function npmInstall(dir, { scripts = false, env = {}, timeoutMs = 600000 } = {}) {
  // with scripts enabled, --foreground-scripts keeps lifecycle output (npm hides it otherwise) so callers can inspect it
  const args = ['install', '--no-audit', '--no-fund', '--loglevel=error', ...(scripts ? ['--foreground-scripts'] : ['--ignore-scripts'])]
  return run('npm', args, { cwd: dir, timeoutMs, env: { NODE_ENV: 'development', ...env } })
}

/** Copy the worker scripts next to the project's node_modules so their bare imports resolve there. */
export function stageWorkers(projectDir) {
  const dst = path.join(projectDir, 'workers')
  fs.rmSync(dst, { recursive: true, force: true })
  fs.cpSync(path.join(TESTS_DIR, 'workers'), dst, { recursive: true })
  return dst
}

/**
 * Inspects the given tarballs, writes the project's package.json and runs npm install.
 * Returns { dir, workers, pptr: {...}|null, pw: {...}|null } where each family describes
 *   { patched: {name, version, file}, upstream: {alias, name, version}, wrapper: {...}|null }.
 */
export async function createProject(ctx) {
  const { args, runDir } = ctx
  const dir = path.join(runDir, 'project')
  fs.mkdirSync(dir, { recursive: true })
  const families = {}
  const deps = { typescript: '5', '@types/node': '22' }
  for (const [key, coreFile, wrapFile, upOverride, expectedCore] of [
    ['pptr', args.pptrCore, args.pptr, args.pptrUpstream, 'rebrowser-puppeteer-core'],
    ['pw', args.pwCore, args.pw, args.pwUpstream, 'rebrowser-playwright-core'],
  ]) {
    if (!coreFile) continue
    const core = await inspectTarball(coreFile)
    if (core.name !== expectedCore) throw new Error(`${coreFile} is ${core.name}@${core.version}, expected ${expectedCore}`)
    const upVersion = upOverride || core.version
    const alias = `upstream-${upstreamName(core.name)}`
    deps[core.name] = `file:${coreFile}`
    deps[alias] = `npm:${upstreamName(core.name)}@${upVersion}`
    families[key] = {
      key,
      patched: { name: core.name, version: core.version, file: coreFile },
      upstream: { alias, name: upstreamName(core.name), version: upVersion },
      wrapper: null,
    }
    if (wrapFile) {
      const w = await inspectTarball(wrapFile)
      const expectedWrapper = core.name.replace(/-core$/, '')
      if (w.name !== expectedWrapper) throw new Error(`${wrapFile} is ${w.name}@${w.version}, expected ${expectedWrapper}`)
      families[key].wrapper = { name: w.name, version: w.version, file: wrapFile, dependencies: w.dependencies }
    }
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'rebrowser-patches-test-project', private: true, type: 'module', dependencies: deps }, null, 2))
  const r = await npmInstall(dir)
  if (r.code !== 0) throw new Error(`npm install failed in the throwaway project (exit ${r.code}): ${tail(r.stderr || r.stdout, 1500)}`)
  const workers = stageWorkers(dir)
  const tsc = path.join(dir, 'node_modules', 'typescript', 'bin', 'tsc')
  return { dir, workers, tsc, families, pptr: families.pptr || null, pw: families.pw || null }
}
