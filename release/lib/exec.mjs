// Process execution with streamed logs and non-zero-exit errors. Node built-ins only.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)/i;

/** Returns a function that masks the values of secret-looking env vars in a string. */
export function makeRedactor(env = process.env) {
  const secrets = Object.entries(env)
    .filter(([key, value]) => SECRET_ENV.test(key) && typeof value === 'string' && value.length >= 8)
    .map(([, value]) => value);
  return (text) => secrets.reduce((acc, secret) => acc.split(secret).join('***'), text);
}
const redact = makeRedactor();

export class ExecError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ExecError';
    Object.assign(this, details);
  }
}

/** Print a progress line to stderr (stdout is reserved for machine output such as --json). */
export function log(...args) {
  process.stderr.write(redact(args.join(' ')) + '\n');
}

/**
 * Run a command. Resolves `{ code, stdout }`; rejects with ExecError on a non-zero exit (unless
 * the code is listed in `okCodes`), on spawn failure, or on timeout.
 *
 * options:
 *   cwd, env (merged over process.env), input (stdin string)
 *   logFile  - append combined output (and the command line) to this file
 *   echo     - mirror output to stderr (default true; false for chatty builds when logFile is given)
 *   capture  - keep stdout in the result (stderr is still echoed / logged)
 *   okCodes  - exit codes treated as success (default [0])
 *   timeoutMs
 */
export function run(cmd, args = [], options = {}) {
  const { cwd, env, input, logFile, echo = true, capture = false, okCodes = [0], timeoutMs } = options;
  const display = redact([cmd, ...args].map((a) => (/[\s'"]/.test(a) ? JSON.stringify(a) : a)).join(' '));
  let logStream = null;
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
    logStream.write(`\n$ (cd ${cwd || process.cwd()}) ${display}\n`);
  }
  if (echo) log(`$ ${display}${cwd ? `   (in ${cwd})` : ''}`);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    const tail = [];
    let stdout = '';
    let partial = '';
    let timer = null;
    let timedOut = false;
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
    }
    const onChunk = (stream, isStdout) => (chunk) => {
      const text = chunk.toString('utf8');
      if (isStdout && capture) stdout += text;
      if (logStream) logStream.write(redact(text));
      if (echo) stream.write(redact(text));
      partial += text;
      const lines = partial.split('\n');
      partial = lines.pop();
      for (const line of lines) {
        tail.push(line);
        if (tail.length > 60) tail.shift();
      }
    };
    child.stdout.on('data', onChunk(process.stderr, true));
    child.stderr.on('data', onChunk(process.stderr, false));
    if (input !== undefined) child.stdin.end(input);
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      logStream?.end();
      reject(new ExecError(`failed to start \`${display}\`: ${err.message}`, { cmd: display, code: null, logFile }));
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (partial) tail.push(partial);
      logStream?.end();
      if (!timedOut && okCodes.includes(code)) return resolve({ code, stdout });
      const why = timedOut ? `timed out after ${timeoutMs}ms` : signal ? `killed by ${signal}` : `exited with code ${code}`;
      const where = logFile ? ` (full log: ${logFile})` : '';
      reject(
        new ExecError(`\`${display}\` ${why}${where}\n${redact(tail.slice(-25).join('\n'))}`, {
          cmd: display,
          code,
          signal,
          logFile,
          tail: tail.slice(),
        }),
      );
    });
  });
}

/** Run and return trimmed stdout; nothing is echoed. */
export async function capture(cmd, args = [], options = {}) {
  const { stdout } = await run(cmd, args, { ...options, echo: false, capture: true });
  return stdout.trim();
}

/** Run `fn` and log how long it took. */
export async function step(label, fn) {
  const start = Date.now();
  log(`==> ${label}`);
  try {
    const result = await fn();
    log(`<== ${label} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    return result;
  } catch (err) {
    log(`<== ${label} FAILED (${((Date.now() - start) / 1000).toFixed(1)}s)`);
    throw err;
  }
}
