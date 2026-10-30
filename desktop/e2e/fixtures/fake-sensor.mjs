import { createServer } from 'node:http'

const VERSION = '2.1.0'

const DEFAULT_CONFIG = {
  enabled: true,
  server_url: '',
  username: '',
  agent_id: 'fixture-agent',
  agent_name: 'Fixture PC',
  idle_threshold: 300,
  window_enabled: true,
  idle_enabled: true,
  screen_enabled: true,
  ssl_verify: true,
  ssl_ca_file: '',
  backend_token: '',
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

export async function startFakeSensor(options = {}) {
  const token = options.token ?? 'fixture-sensor-token'
  const backendToken = options.backendToken ?? 'fixture-backend-token'
  const instanceId = options.instanceId ?? 'fixture-instance'
  const agentId = options.agentId ?? 'fixture-agent'
  const agentName = options.agentName ?? 'Fixture PC'
  const enabled = options.enabled ?? true

  let config = {
    ...DEFAULT_CONFIG,
    enabled,
    agent_id: agentId,
    agent_name: agentName,
    backend_token: backendToken,
  }
  let stopped = false
  let shutdownTimer = null
  let closed = false
  const requests = []

  function configView() {
    return { ...config, backend_token: '******' }
  }

  function authorized(req) {
    return req.headers.authorization === `Bearer ${token}`
  }

  async function handle(req, res) {
    const url = req.url ?? '/'
    const parsed = new URL(url, 'http://127.0.0.1')
    const body = req.method === 'POST' ? await readBody(req) : null
    requests.push({ method: req.method ?? 'GET', url, headers: { ...req.headers }, body })

    if (parsed.pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, {
        status: 'ok',
        agent_id: agentId,
        agent_name: agentName,
        pid: process.pid,
        version: VERSION,
      })
      return
    }

    if (!authorized(req)) {
      sendJson(res, 401, { detail: 'unauthorized' })
      return
    }

    if (parsed.pathname === '/pc-sensor/auth-token' && req.method === 'GET') {
      sendJson(res, 200, { token: config.backend_token, expires_in: 3600 })
      return
    }

    if (parsed.pathname === '/pc-sensor/status' && req.method === 'GET') {
      sendJson(res, 200, {
        running: true,
        enabled: config.enabled,
        logged_in: true,
        window: false,
        idle: false,
        last_events: [],
        queue_size: 0,
        pid: process.pid,
        data_dir: 'fixture-data',
        instance_id: instanceId,
        version: VERSION,
      })
      return
    }

    if (parsed.pathname === '/pc-sensor/config' && req.method === 'GET') {
      sendJson(res, 200, configView())
      return
    }

    if (parsed.pathname === '/pc-sensor/config' && req.method === 'POST') {
      let patch
      try {
        patch = JSON.parse(body ?? '')
      } catch {
        sendJson(res, 400, { detail: 'invalid json' })
        return
      }
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        sendJson(res, 400, { detail: 'invalid config payload' })
        return
      }
      config = { ...config, ...patch }
      sendJson(res, 200, configView())
      return
    }

    if (parsed.pathname === '/shutdown' && req.method === 'POST') {
      stopped = true
      sendJson(res, 200, { success: true })
      shutdownTimer = setTimeout(() => {
        void close()
      }, 100)
      shutdownTimer.unref()
      return
    }

    sendJson(res, 404, { detail: 'not found', path: parsed.pathname })
  }

  const server = createServer((req, res) => {
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
    throw new Error('fake sensor did not bind a TCP port')
  }

  async function close() {
    if (closed) return
    closed = true
    if (shutdownTimer) clearTimeout(shutdownTimer)
    await new Promise((resolve) => {
      server.close(() => resolve())
      server.closeIdleConnections()
      server.closeAllConnections()
    })
  }

  return {
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    token,
    requests,
    get config() {
      return configView()
    },
    get stopped() {
      return stopped
    },
    setBackendToken(nextToken) {
      config = { ...config, backend_token: nextToken }
    },
    close,
  }
}
