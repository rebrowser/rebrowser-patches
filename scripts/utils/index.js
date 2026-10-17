import { exec as execNative } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const promisifiedExec = promisify(execNative)

export const validPackagesNames = ['puppeteer-core', 'playwright-core']

export const exec = async (...args) => {
  if (isDebug()) {
    log('[debug][exec]', args)
  }

  const execRes = await promisifiedExec(...args)

  if (isDebug()) {
    log('[debug][execRes]', execRes)
  }

  return execRes
}
export const log = console.log

export const getPatcherPackagePath = () => {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..')
}

export const fatalError = (...args) => {
  console.error('❌ FATAL ERROR:', ...args)
  process.exit(1)
}

export const getPatchBaseCmd = (patchFilePath) => {
  return `patch --batch -p1 --input=${patchFilePath} --verbose --no-backup-if-mismatch --reject-file=- --forward --silent`
}

// Compare two "x.y.z" (or "x.y.z-tag") versions. Returns <0, 0, >0.
// The numeric x.y.z decides; a version without a pre-release tag ranks above one with a tag.
const compareVersions = (a, b) => {
  const parse = (v) => {
    const [core, ...pre] = String(v).split('-')
    const nums = core.split('.').map((n) => parseInt(n, 10) || 0)
    return { nums, pre: pre.join('-') }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const diff = (pa.nums[i] || 0) - (pb.nums[i] || 0)
    if (diff) return diff
  }
  if (pa.pre === pb.pre) return 0
  if (!pa.pre) return 1
  if (!pb.pre) return -1
  return pa.pre < pb.pre ? -1 : 1
}

// List the versioned patch directories for a package, newest first.
export const listPatchVersions = (packageName) => {
  const dir = resolve(getPatcherPackagePath(), `./patches/${packageName}`)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => compareVersions(b, a))
}

// Pick the patch version directory to try for an installed package version, in order:
// 1) exact match, 2) newest with the same major.minor, 3) newest overall.
// Returns { version, path, exact } or null when there are no versioned patches.
export const resolvePatchVersion = (packageName, installedVersion, codeTarget) => {
  const versions = listPatchVersions(packageName)
  if (versions.length === 0) return null
  const has = (v) => existsSync(resolve(getPatcherPackagePath(), `./patches/${packageName}/${v}/${codeTarget}.patch`))
  const pick = (v) => ({ version: v, path: resolve(getPatcherPackagePath(), `./patches/${packageName}/${v}/${codeTarget}.patch`), exact: v === installedVersion })

  if (versions.includes(installedVersion) && has(installedVersion)) return pick(installedVersion)

  const [maj, min] = String(installedVersion).split('.')
  const sameMinor = versions.filter((v) => {
    const [vMaj, vMin] = v.split('.')
    return vMaj === maj && vMin === min && has(v)
  })
  if (sameMinor.length) return pick(sameMinor[0])

  const anyWithTarget = versions.filter(has)
  if (anyWithTarget.length) return pick(anyWithTarget[0])
  return null
}

export const isDebug = () => {
  return !!process.env.REBROWSER_PATCHES_DEBUG
}
