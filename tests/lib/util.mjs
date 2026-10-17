// Process helpers shared by the test runner: tracked child processes, whole-tree kills, a virtual display wrapper.
// Only processes started by this runner (and their descendants) are ever signalled.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'

export const sleep = ms => new Promise(r => setTimeout(r, ms))

const live = new Set() // root pids of children that are still running
const exitHooks = []
let handlersInstalled = false

/** Register a synchronous cleanup that also runs on SIGINT/SIGTERM and on process exit. */
export function onExit(fn) {
  installHandlers()
  exitHooks.push(fn)
}

function installHandlers() {
  if (handlersInstalled) return
  handlersInstalled = true
  const cleanup = () => {
    for (const pid of [...live]) killTree(pid)
    for (const fn of exitHooks.splice(0)) { try { fn() } catch {} }
  }
  process.on('exit', cleanup)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { cleanup(); process.exit(sig === 'SIGINT' ? 130 : 143) })
  }
}

function childMap() {
  const kids = new Map()
  const add = (pid, ppid) => { if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid) }
  if (fs.existsSync('/proc/self/stat')) {
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue
      try {
        const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8')
        add(+d, +stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      } catch {}
    }
  } else {
    try {
      for (const line of execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)$/)
        if (m) add(+m[1], +m[2])
      }
    } catch {}
  }
  return kids
}

export function descendants(root) {
  const kids = childMap()
  const out = []
  const stack = [root]
  while (stack.length) for (const c of kids.get(stack.pop()) || []) { out.push(c); stack.push(c) }
  return out
}

/** SIGKILL `pid`, everything below it, and (for children started by us, which lead their own group) the whole group. */
export function killTree(pid, { group = true } = {}) {
  const pids = [...descendants(pid), pid]
  if (group && process.platform !== 'win32') { try { process.kill(-pid, 'SIGKILL') } catch {} }
  for (const p of pids.reverse()) { try { process.kill(p, 'SIGKILL') } catch {} }
}

/** Environment for a child: inherited env minus any REBROWSER_PATCHES_* setting, plus overrides (undefined deletes). */
export function childEnv(overrides = {}, tmp) {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('REBROWSER_PATCHES_')) delete env[k]
  if (tmp) env.TMPDIR = tmp
  for (const [k, v] of Object.entries(overrides)) { if (v === undefined) delete env[k]; else env[k] = String(v) }
  return env
}

export const needsDisplay = () => process.platform === 'linux' && !process.env.DISPLAY

/**
 * Start a tracked child. Resolves `.done` with { code, signal, stdout, stderr } once it exits (it never rejects).
 * opts: { cwd, env (overrides), tmp (TMPDIR), display (wrap in xvfb-run -a when DISPLAY is unset), onStdout(line) }
 */
export function start(cmd, args = [], opts = {}) {
  installHandlers()
  let c = cmd
  let a = args
  if (opts.display && needsDisplay()) { c = 'xvfb-run'; a = ['-a', '-s', '-screen 0 1280x1024x24', cmd, ...args] }
  const child = spawn(c, a, { cwd: opts.cwd, env: childEnv(opts.env, opts.tmp), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  live.add(child.pid)
  let stdout = ''
  let stderr = ''
  let carry = ''
  child.stdout.on('data', d => {
    stdout += d
    if (stdout.length > 16e6) stdout = stdout.slice(-8e6)
    if (opts.onStdout) {
      carry += d
      const lines = carry.split('\n')
      carry = lines.pop()
      for (const l of lines) opts.onStdout(l)
    }
  })
  child.stderr.on('data', d => { stderr += d; if (stderr.length > 4e6) stderr = stderr.slice(-2e6) })
  const done = new Promise(resolve => {
    let settled = false
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      live.delete(child.pid)
      // leftovers of the same group (a browser that outlived its driver) must not keep running
      if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
      resolve({ code, signal, stdout, stderr })
    }
    child.on('error', e => { stderr += String(e.message || e); finish(-1, null) })
    // 'close' waits for the stdio pipes, which an orphaned browser could hold open; 'exit' plus a short grace is enough
    child.on('exit', (code, signal) => setTimeout(() => finish(code, signal), 800).unref())
    child.on('close', (code, signal) => finish(code, signal))
  })
  return { child, pid: child.pid, done, kill: () => killTree(child.pid) }
}

/** Run to completion. Resolves { code, signal, stdout, stderr, timedOut, ms }; never rejects. */
export async function run(cmd, args = [], opts = {}) {
  const t0 = Date.now()
  const p = start(cmd, args, opts)
  let timedOut = false
  const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; p.kill() }, opts.timeoutMs) : null
  const res = await p.done
  if (timer) clearTimeout(timer)
  return { ...res, timedOut, ms: Date.now() - t0 }
}

export const tail = (s, n = 600) => (s.length > n ? '...' + s.slice(-n) : s).trim()

/** Last stdout line starting with '{' that parses as JSON, or null. */
export function lastJsonLine(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('{'))
  for (let i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]) } catch {} }
  return null
}

export const fmtSecs = ms => (ms / 1000).toFixed(1) + 's'
