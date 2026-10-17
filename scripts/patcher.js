#! /usr/bin/env node

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import {
  exec,
  fatalError,
  getPatchBaseCmd,
  log,
  resolvePatchVersion,
  validPackagesNames,
} from './utils/index.js';

(async () => {
  // config and preparations
  const cliArgs = yargs(hideBin(process.argv))
    .usage('Usage: <command> [options]')
    .command('patch', 'Apply patch')
    .command('unpatch', 'Reverse patch')
    .command('check', 'Check if patch is already applied')
    .describe('packageName', `Target package name: ${validPackagesNames.join(', ')}`)
    .describe('packagePath', 'Path to the target package')
    .describe('codeTarget', 'What code to patch: src or lib')
    .boolean('debug')
    .describe('debug', 'Enable debugging mode')
    .demandCommand(1, 1, 'Error: choose a command (patch, unpatch, check)')
    .parse()

  let {
    packageName,
    packagePath,
    codeTarget = 'lib',
    debug,
  } = cliArgs

  if (debug) {
    process.env.REBROWSER_PATCHES_DEBUG = 1
  }

  const command = cliArgs._[0]
  let commandResult

  if (!packagePath && !packageName) {
    fatalError('You need to specify either packageName or packagePath.')
  }

  if (!packagePath) {
    packagePath = `${process.cwd()}/node_modules/${packageName}`
  }

  if (!['patch', 'unpatch', 'check'].includes(command)) {
    fatalError(`Unknown command: ${command}`)
  }

  if (!['src', 'lib'].includes(codeTarget)) {
    fatalError(`Unknown codeTarget: ${codeTarget}`)
  }

  log('Config:')
  log(`command = ${command}, packageName = ${packageName}, codeTarget = ${codeTarget}`)
  log(`packagePath = ${packagePath}`)
  log('------')

  // find package
  let packageJson
  const packageJsonPath = resolve(packagePath, 'package.json')
  try {
    const packageJsonText = await readFile(packageJsonPath, { encoding: 'utf8' })
    packageJson = JSON.parse(packageJsonText)
  } catch (err) {
    fatalError('Cannot read package.json', err)
  }
  if (!packageName) {
    if (!validPackagesNames.includes(packageJson.name)) {
      fatalError(`Package name is "${packageJson.name}", but we only support ${validPackagesNames.join(', ')}.`)
    } else {
      packageName = packageJson.name
    }
  } else if (packageJson.name !== packageName) {
    fatalError(`Package name is "${packageJson.name}", but we're looking for "${packageName}". Check your package path.`)
  }
  log(`Found package "${packageJson.name}", version ${packageJson.version}`)

  // Patches are stored per upstream version under patches/<package>/<version>/<codeTarget>.patch.
  // Pick the exact version, else the newest patch for the same major.minor, else the newest overall.
  const resolved = resolvePatchVersion(packageName, packageJson.version, codeTarget)
  if (!resolved) {
    fatalError(`No ${codeTarget}.patch found for ${packageName}. This rebrowser-patches version may not support it.`)
  }
  const patchFilePath = resolved.path
  log(`Using patch version ${resolved.version} (${codeTarget})`)
  if (!resolved.exact) {
    log(`⚠️  No patch tested on ${packageName}@${packageJson.version}; trying the closest one (${resolved.version}).`)
    log('⚠️  If this fails or misbehaves, use the matching drop-in package (e.g. rebrowser-' + packageName + ') instead.')
  }

  // check patch status
  let patchStatus
  try {
    const { stdout, stderr } = await exec(`${getPatchBaseCmd(patchFilePath)} --dry-run`, {
      cwd: packagePath,
    })
    patchStatus = 'unpatched'
  } catch (e) {
    if (e.stdout.includes('No file to patch')) {
      fatalError('Internal error, patch command cannot find file to patch')
    } else if (
      // GNU patch wording varies by version: "Ignoring previously applied (or reversed) patch"
      // vs "Reversed (or previously applied) patch detected!  Skipping patch." — match the common part.
      e.stdout.includes('previously applied') ||
      e.stdout.includes('Reversed (or previously applied)')
    ) {
      patchStatus = 'patched'
    } else if (e.stderr.includes('is not recognized')) {
      let message = 'patch command not found!'
      if (process.platform === 'win32') {
        message += '\nCheck README for how to install patch.exe on Windows.'
      }
      fatalError(message)
    } else if (!resolved.exact) {
      // A non-exact patch that doesn't apply cleanly: don't risk a half-patched install.
      fatalError(
        `The closest patch (${resolved.version}) does not apply to ${packageName}@${packageJson.version}.\n` +
        `Use the matching drop-in package instead: rebrowser-${packageName}@${packageJson.version} ` +
        `(see https://github.com/rebrowser/rebrowser-patches#readme), or install a ${packageName} version that has a patch.`
      )
    } else {
      log('[debug] patch error:', e)
      throw e
    }
  }
  log(`Current patch status = ${patchStatus === 'patched' ? '🟩' : '🟧'} ${patchStatus}`)

  // run command
  let execCmd
  if (command === 'patch') {
    if (patchStatus === 'patched') {
      log('Package already patched.')
    } else {
      execCmd = getPatchBaseCmd(patchFilePath)
    }
  } else if (command === 'unpatch') {
    if (patchStatus === 'unpatched') {
      log('Package already unpatched.')
    } else {
      execCmd = `${getPatchBaseCmd(patchFilePath)} --reverse`
    }
  }

  if (execCmd) {
    try {
      const { stdout, stderr } = await exec(execCmd, {
        cwd: packagePath,
      })
      commandResult = 'success'
    } catch (e) {
      log('patch exec error:', e)
      commandResult = 'error'
    }
  }

  // process results
  let exitCode = 0
  let resultText
  if (!commandResult) {
    resultText = '🟡 nothing changed'
  } else if (commandResult === 'success') {
    resultText = '🟢 success'
  } else if (commandResult === 'error') {
    resultText = '🔴 error'
    exitCode = 1
  }
  log(`Result: ${resultText}`)

  process.exit(exitCode)
})()
