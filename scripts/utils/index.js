import { exec as execNative } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export const exec = promisify(execNative)
export const log = console.log

export const getPatcherPackagePath = () => {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..')
}

export const getAvailablePatchesNames = async () => {
  const pptrBaseDir = resolve(getPatcherPackagePath(), './patches/puppeteer-core/')
  const pptrVersions = await readdir(pptrBaseDir)
  const latestVersionPatches = await readdir(resolve(pptrBaseDir, pptrVersions[0]))
  return latestVersionPatches.map(p => p.split('.')[0])
}

export const fatalError = (...args) => {
  console.error('❌ FATAL ERROR:', ...args)
  process.exit(1)
}

export const getPatchBaseCmd = (patchFilePath) => {
  return `patch --batch -p1 --input=${patchFilePath} --verbose --reject-file=- --forward --silent`
}

