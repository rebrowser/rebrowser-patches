// In-process fixture server on two sites: 127.0.0.1:<A> and localhost:<B>. They are different sites, so a
// cross-site iframe becomes an out-of-process iframe (OOPIF). Both serve the same files and accept POST /report.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.png': 'image/png' }

export async function startFixtureServer(fixturesDir) {
  const roots = [path.join(fixturesDir, 'scen'), fixturesDir] // scen/ is served at the site root, as its pages use absolute paths
  const ports = { A: 0, B: 0 }
  const reports = []
  const waiters = []

  const onReport = body => {
    let r
    try { r = JSON.parse(body) } catch { return }
    reports.push(r)
    for (const w of [...waiters]) if (w.tag === r.tag) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(r) }
  }

  const handler = (req, res) => {
    if (req.method === 'POST' && req.url === '/report') {
      let b = ''
      req.on('data', d => { b += d })
      req.on('end', () => { onReport(b); res.writeHead(204); res.end() })
      return
    }
    const name = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '')
    let file = null
    for (const root of roots) {
      const f = path.join(root, name)
      if (name && f.startsWith(root + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) { file = f; break }
    }
    if (!file) { res.writeHead(404); res.end(); return }
    const ext = path.extname(file)
    let body = fs.readFileSync(file)
    if (ext === '.html') body = Buffer.from(body.toString().replaceAll('{{PORT_A}}', ports.A).replaceAll('{{PORT_B}}', ports.B))
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  }

  const servers = []
  for (const k of ['A', 'B']) {
    const s = http.createServer(handler)
    await new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve) })
    ports[k] = s.address().port
    servers.push(s)
  }

  return {
    ports,
    /** URL on site A (127.0.0.1) */
    url: (p, query = '') => `http://127.0.0.1:${ports.A}/${p}${query ? '?' + query : ''}`,
    reports,
    /** Resolves with the report whose `tag` matches, or null after `ms`. */
    waitForReport(tag, ms = 40000) {
      const have = reports.find(r => r.tag === tag)
      if (have) return Promise.resolve(have)
      return new Promise(resolve => {
        const w = { tag, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); resolve(null) }, ms) }
        waiters.push(w)
      })
    },
    close() { for (const s of servers) { try { s.close(); s.closeAllConnections?.() } catch {} } },
  }
}
