import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const FIXTURE_DOWNLOAD_PAYLOAD = 'FIXTURE_DOWNLOAD_PAYLOAD'

const MOBILE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture SPA</title></head>
<body>
  <main>
    <h1>Fixture SPA</h1>
    <button id="echo" type="button">Echo</button>
    <button id="open-settings" type="button">Open settings</button>
    <a id="external" href="https://example.com/">external</a>
    <a id="download" href="/api/download" download="fixture.bin">download</a>
    <pre id="result"></pre>
  </main>
  <script>
    window.__axeuhTokenEvents = []
    window.addEventListener('axeuh-token-refresh', (event) => {
      window.__axeuhTokenEvents.push(event.detail)
    })
  </script>
  <script>
    const params = new URLSearchParams(window.location.search)
    const token = params.get('token')
    if (token) localStorage.setItem('mobile_token', token)
    document.getElementById('echo').addEventListener('click', async () => {
      const response = await fetch('/api/echo')
      document.getElementById('result').textContent = await response.text()
    })
    document.getElementById('open-settings').addEventListener('click', () => {
      window.location.href = 'axeuh://open-settings'
    })
  </script>
</body>
</html>
`

const NDJSON_LINE = JSON.stringify({ path: 'fixture/notes.txt', content: 'fixture file content' })

let certificateCache = null

function loadCertificate() {
  if (certificateCache) return certificateCache
  const dir = mkdtempSync(join(tmpdir(), 'axeuh-e2e-cert-'))
  const keyPath = join(dir, 'key.pem')
  const certPath = join(dir, 'cert.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  )
  certificateCache = {
    keyPath,
    certPath,
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  }
  return certificateCache
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

function send(res, status, contentType, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': contentType, ...extraHeaders })
  res.end(body)
}

function sendJson(res, status, payload) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(payload))
}

export async function startFixtureServer(options = {}) {
  const delayMs = options.delayMs ?? 0
  const stopAfterMs = options.stopAfterMs ?? options.stopAfter ?? 0
  const mobileRedirectTo = options.mobileRedirectTo ?? ''
  const mobileAbort = options.mobileAbort === true
  const { key, cert, keyPath, certPath } = loadCertificate()
  const requests = []
  let stopTimer = null
  let closed = false

  async function handle(req, res) {
    const url = req.url ?? '/'
    const parsed = new URL(url, 'https://fixture.local')
    requests.push({ method: req.method ?? 'GET', url, headers: { ...req.headers } })

    if (delayMs > 0) await sleep(delayMs)

    if (parsed.pathname === '/__requests') {
      sendJson(res, 200, requests.slice(0, -1))
      return
    }

    if (parsed.pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok', server: 'fixture', time: new Date().toISOString() })
      return
    }

    if (parsed.pathname === '/mobile/' && req.method === 'GET') {
      if (mobileAbort) {
        req.socket.destroy()
        return
      }
      if (mobileRedirectTo.length > 0) {
        res.writeHead(302, { Location: mobileRedirectTo })
        res.end()
        return
      }
      send(res, 200, 'text/html; charset=utf-8', MOBILE_HTML)
      return
    }

    if (parsed.pathname === '/api/echo' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, token: req.headers.authorization ?? null })
      return
    }

    if (parsed.pathname === '/api/download' && req.method === 'GET') {
      send(res, 200, 'application/octet-stream', FIXTURE_DOWNLOAD_PAYLOAD, {
        'Content-Disposition': 'attachment; filename="fixture.bin"',
      })
      return
    }

    if (parsed.pathname === '/login' && req.method === 'POST') {
      sendJson(res, 200, {
        success: true,
        token: 'fixture-token',
        user_id: 'fixture',
        display_name: 'Fixture',
      })
      return
    }

    if (parsed.pathname === '/api/pc/sync' && req.method === 'POST') {
      sendJson(res, 200, { success: true })
      return
    }

    if (parsed.pathname === '/api/mobile/files/content' && req.method === 'GET') {
      send(res, 200, 'application/x-ndjson', `${NDJSON_LINE}\n`)
      return
    }

    sendJson(res, 404, { detail: 'not found', path: parsed.pathname })
  }

  const server = createServer({ key, cert }, (req, res) => {
    void handle(req, res).catch((error) => {
      if (!res.headersSent) sendJson(res, 500, { detail: error instanceof Error ? error.message : 'unknown' })
      else res.end()
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('fixture server did not bind a TCP port')
  }

  async function close() {
    if (closed) return
    closed = true
    if (stopTimer) clearTimeout(stopTimer)
    await new Promise((resolve) => {
      server.close(() => resolve())
      server.closeIdleConnections()
      server.closeAllConnections()
    })
  }

  if (stopAfterMs > 0) {
    stopTimer = setTimeout(() => {
      void close()
    }, stopAfterMs)
    stopTimer.unref()
  }

  return {
    url: `https://127.0.0.1:${address.port}`,
    httpsPort: address.port,
    close,
    requests,
    certPath,
    keyPath,
  }
}
