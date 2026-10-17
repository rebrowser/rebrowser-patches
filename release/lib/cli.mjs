// Tiny wrapper around util.parseArgs: --help text, uniform error handling and exit codes.
import { parseArgs } from 'node:util';
import { ExecError, log } from './exec.mjs';

/**
 * parse({ usage, options, allowPositionals }) -> { values, positionals }
 * Prints `usage` and exits 0 on --help, exits 2 on unknown flags.
 */
export function parse({ usage, options = {}, allowPositionals = true, args = process.argv.slice(2) }) {
  let parsed;
  try {
    parsed = parseArgs({ args, options: { help: { type: 'boolean', short: 'h' }, ...options }, allowPositionals });
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${usage}\n`);
    process.exit(2);
  }
  if (parsed.values.help) {
    process.stdout.write(`${usage}\n`);
    process.exit(0);
  }
  return parsed;
}

/** Run an async main(); any failure prints a clean message and exits non-zero. */
export function main(fn) {
  fn().then(
    () => {},
    (err) => {
      if (err instanceof ExitError) {
        if (err.message) log(err.message);
        process.exit(err.exitCode);
      }
      log(`ERROR: ${err instanceof ExecError ? err.message : err.stack || err.message}`);
      process.exit(1);
    },
  );
}

/** Throw to exit with a specific code (e.g. 2 = conflict) after printing `message`. */
export class ExitError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}
