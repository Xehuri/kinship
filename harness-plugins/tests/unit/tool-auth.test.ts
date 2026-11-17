/**
 * Acceptance for the bridge's tool-auth handshake and its backend client.
 *
 * The route is exercised over the real loopback HTTP server of the mounted
 * plugin, and the client is exercised against a fake Kinship backend, so the
 * request paths, bodies and error folding are the ones production uses. No real
 * Kinship backend, harness process, or TLS certificate is involved.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Config,
  TOOL_AUTH_SCHEMA,
  ToolAuthClient,
  apply,
  inject,
  name,
} from '../../packages/kinship-bridge/src/index.js'
import type { KinshipBridgeService, PushedToolAuth } from '../../packages/kinship-bridge/src/index.js'
import { ToolAuthStore, parsePushedToolAuth } from '../../packages/kinship-bridge/src/tool-auth.js'

const homes: string[] = []
const bridges: MountedBridge[] = []
const backends: FakeBackend[] = []
const previousHome = process.env['DSH_HOME']
const previousToken = process.env['KINSHIP_BRIDGE_TOKEN']

/** One mounted plugin: the service, the root context, and its HTTP base URL. */
interface MountedBridge {
  readonly ctx: Context
  readonly service: KinshipBridgeService
  readonly base: string
  dispose(): Promise<void>
}

/** Projection of every JSON body the tool-auth route answers with. */
interface ToolAuthResponse {
  readonly ok?: boolean
  readonly schema?: number
  readonly configured?: boolean
  readonly base_url?: string | null
  readonly at?: number | null
  readonly error?: string
  readonly message?: string
  readonly token?: string
}

/** One request the fake backend received. */
interface ReceivedRequest {
  readonly method: string
  readonly path: string
  readonly authorization: string | undefined
  readonly body: string
}

/** Fake Kinship backend: records requests and answers with a canned reply. */
interface FakeBackend {
  readonly base: string
  readonly requests: ReceivedRequest[]
  close(): Promise<void>
}

type Handler = (request: ReceivedRequest, response: ServerResponse) => void

/** The push the Kinship backend sends for one deployment. */
const PUSH: PushedToolAuth = {
  schema: TOOL_AUTH_SCHEMA,
  base_url: 'http://127.0.0.1:18768',
  token: 'service-token-value',
  source: 'kinship-backend',
  generated_at: 1_794_759_000_000,
}

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'kinship-tool-auth-'))
  homes.push(home)
  return home
}

/** Every regular file under one directory tree. */
function filesUnder(root: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    found.push(join(entry.parentPath, entry.name))
  }
  return found
}

/** Mount the real plugin over a fake empty agent registry. */
async function mount(home: string): Promise<MountedBridge> {
  process.env['DSH_HOME'] = home
  process.env['KINSHIP_BRIDGE_TOKEN'] = 'test-token'
  const ctx = new Context()
  ctx.provide('agents', {
    list: () => [],
    get: () => undefined,
  })
  const fiber = ctx.plugin({ name, inject, apply, Config }, {
    host: '127.0.0.1',
    port: 0,
    tokenEnv: 'KINSHIP_BRIDGE_TOKEN',
    tokenFile: '',
    policy: 'first',
    sessionId: '',
    rebindOnMissing: false,
    bodyLimitBytes: 64 * 1024,
  })
  await fiber

  const service = ctx.get('kinshipBridge')
  if (service === undefined) throw new Error('kinship bridge service missing')
  let disposed = false
  const mounted: MountedBridge = {
    ctx,
    service,
    base: `http://127.0.0.1:${String(service.port())}`,
    dispose: async () => {
      if (disposed) return
      disposed = true
      await fiber.dispose()
    },
  }
  bridges.push(mounted)
  return mounted
}

/**
 * Start a fake Kinship backend on an ephemeral loopback port.
 *
 * @param handler - canned answer for every request.
 * @returns the base URL, the recorded requests, and a closer.
 */
async function startBackend(handler: Handler): Promise<FakeBackend> {
  const requests: ReceivedRequest[] = []
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    request.on('end', () => {
      const received: ReceivedRequest = {
        method: request.method ?? '',
        path: request.url ?? '',
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      requests.push(received)
      handler(received, response)
    })
  })
  await new Promise<void>((resolveStart, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolveStart()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  let closing: Promise<void> | undefined
  const backend: FakeBackend = {
    base: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () => {
      if (closing !== undefined) return closing
      closing = new Promise<void>((resolveClose, reject) => {
        server.close(error => {
          if (error !== undefined && error !== null) reject(error)
          else resolveClose()
        })
      })
      return closing
    },
  }
  backends.push(backend)
  return backend
}

/** Answer one JSON body with a fixed status. */
function replyJson(status: number, body: unknown): Handler {
  return (_request, response) => {
    const payload = JSON.stringify(body)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
    })
    response.end(payload)
  }
}

async function call(
  base: string,
  path: string,
  options: RequestInit & { readonly auth?: boolean } = {},
): Promise<{ readonly status: number, readonly body: ToolAuthResponse }> {
  const { auth = true, ...init } = options
  const headers = new Headers(init.headers)
  if (auth) headers.set('authorization', 'Bearer test-token')
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  const response = await fetch(`${base}${path}`, { ...init, headers })
  const text = await response.text()
  const body = (text === '' ? {} : JSON.parse(text)) as ToolAuthResponse
  return { status: response.status, body }
}

afterEach(async () => {
  for (const bridge of bridges.splice(0).reverse()) await bridge.dispose()
  for (const backend of backends.splice(0).reverse()) await backend.close()
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  if (previousToken === undefined) delete process.env['KINSHIP_BRIDGE_TOKEN']
  else process.env['KINSHIP_BRIDGE_TOKEN'] = previousToken
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('tool-auth validation', () => {
  it('normalizes one valid push and keeps only the contract fields', () => {
    const parsed = parsePushedToolAuth({ ...PUSH, unknown_field: 'dropped' })
    expect(parsed).toEqual(PUSH)
  })

  it('normalizes a trailing slash away from the base URL', () => {
    const parsed = parsePushedToolAuth({ ...PUSH, base_url: 'https://localhost:8768/' })
    expect(parsed.base_url).toBe('https://localhost:8768')
  })

  it('accepts https on localhost, the self-signed main instance', () => {
    expect(parsePushedToolAuth({ ...PUSH, base_url: 'https://localhost:8768' }).base_url)
      .toBe('https://localhost:8768')
  })

  it('refuses a document that is not an object', () => {
    expect(() => parsePushedToolAuth([])).toThrow('must be a JSON object')
    expect(() => parsePushedToolAuth('nope')).toThrow('must be a JSON object')
  })

  it('refuses every invalid field', () => {
    const cases: { readonly name: string, readonly body: Record<string, unknown> }[] = [
      { name: 'wrong schema', body: { ...PUSH, schema: 2 } },
      { name: 'relative base_url', body: { ...PUSH, base_url: '/api' } },
      { name: 'non-http scheme', body: { ...PUSH, base_url: 'ftp://127.0.0.1:8768' } },
      { name: 'non-loopback host', body: { ...PUSH, base_url: 'https://kinship.example.com' } },
      { name: 'empty token', body: { ...PUSH, token: '  ' } },
      { name: 'missing source', body: { ...PUSH, source: undefined } },
      { name: 'negative generated_at', body: { ...PUSH, generated_at: -1 } },
      { name: 'non-integer generated_at', body: { ...PUSH, generated_at: 1.5 } },
    ]
    for (const testCase of cases) {
      expect(() => parsePushedToolAuth(testCase.body), testCase.name).toThrow()
    }
  })
})

describe('tool-auth route', () => {
  it('answers the unconfigured view before the first push', async () => {
    const bridge = await mount(tempHome())
    const response = await call(bridge.base, '/v1/kinship/tool-auth')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      ok: true,
      schema: TOOL_AUTH_SCHEMA,
      configured: false,
      base_url: null,
      at: null,
    })
  })

  it('stores a push in memory and never echoes the token', async () => {
    const bridge = await mount(tempHome())
    const events: { configured: boolean, baseUrl: string | null, at: number | null }[] = []
    const off = bridge.ctx.on('kinship/tool-auth', status => {
      events.push(status)
      return undefined
    })

    const pushed = await call(bridge.base, '/v1/kinship/tool-auth', {
      method: 'POST',
      body: JSON.stringify(PUSH),
    })
    off()

    expect(pushed.status).toBe(200)
    expect(pushed.body).toEqual({
      ok: true,
      schema: TOOL_AUTH_SCHEMA,
      configured: true,
      base_url: PUSH.base_url,
      at: PUSH.generated_at,
    })
    expect(JSON.stringify(pushed.body)).not.toContain(PUSH.token)

    const fetched = await call(bridge.base, '/v1/kinship/tool-auth')
    expect(fetched.status).toBe(200)
    expect(fetched.body).toEqual(pushed.body)

    expect(bridge.service.toolAuth()).toEqual({
      configured: true,
      baseUrl: PUSH.base_url,
      at: PUSH.generated_at,
    })
    expect(events).toEqual([{ configured: true, baseUrl: PUSH.base_url, at: PUSH.generated_at }])
    expect(JSON.stringify(events)).not.toContain(PUSH.token)
  })

  it('keeps the credentials off disk', async () => {
    const home = tempHome()
    const bridge = await mount(home)
    const pushed = await call(bridge.base, '/v1/kinship/tool-auth', {
      method: 'POST',
      body: JSON.stringify(PUSH),
    })
    expect(pushed.status).toBe(200)

    const leaked = filesUnder(home).filter(file => readFileSync(file, 'utf8').includes(PUSH.token))
    expect(leaked).toEqual([])
  })

  it('rejects an invalid push with 400 and keeps the previous state', async () => {
    const bridge = await mount(tempHome())
    const rejected = await call(bridge.base, '/v1/kinship/tool-auth', {
      method: 'POST',
      body: JSON.stringify({ ...PUSH, base_url: 'https://example.com:8768' }),
    })
    expect(rejected.status).toBe(400)
    expect(rejected.body.error).toBe('bad_request')
    expect(bridge.service.toolAuth().configured).toBe(false)

    await call(bridge.base, '/v1/kinship/tool-auth', {
      method: 'POST',
      body: JSON.stringify(PUSH),
    })
    const malformed = await call(bridge.base, '/v1/kinship/tool-auth', {
      method: 'POST',
      body: '{"schema":1,',
    })
    expect(malformed.status).toBe(400)
    expect(malformed.body.error).toBe('invalid_json')
    // The accepted push survived the refused ones.
    expect(bridge.service.toolAuth().baseUrl).toBe(PUSH.base_url)
  })

  it('rejects an unauthenticated push with 401', async () => {
    const bridge = await mount(tempHome())
    const response = await call(bridge.base, '/v1/kinship/tool-auth', {
      method: 'POST',
      auth: false,
      body: JSON.stringify(PUSH),
    })
    expect(response.status).toBe(401)
    expect(response.body.error).toBe('unauthorized')
    expect(bridge.service.toolAuth().configured).toBe(false)
  })

  it('rejects an unsupported method with 405', async () => {
    const bridge = await mount(tempHome())
    const response = await call(bridge.base, '/v1/kinship/tool-auth', { method: 'DELETE' })
    expect(response.status).toBe(405)
    expect(response.body.error).toBe('method_not_allowed')
  })
})

describe('tool-auth backend client', () => {
  it('sends notifications to /api/notification/send with the pushed token', async () => {
    const backend = await startBackend(replyJson(200, { status: 'ok' }))
    const store = new ToolAuthStore()
    store.configure({ ...PUSH, base_url: backend.base })
    const client = new ToolAuthClient({ auth: () => store.current() })

    const result = await client.notify({ title: '标题', content: '正文' })

    expect(result).toEqual({ ok: true, status: 200, data: { status: 'ok' } })
    expect(backend.requests).toHaveLength(1)
    const request = backend.requests[0]
    expect(request?.method).toBe('POST')
    expect(request?.path).toBe('/api/notification/send')
    expect(request?.authorization).toBe(`Bearer ${PUSH.token}`)
    expect(JSON.parse(request?.body ?? '{}')).toEqual({ title: '标题', content: '正文' })
  })

  it('writes and reads the reminder board', async () => {
    const backend = await startBackend((request, response) => {
      const body = request.method === 'GET'
        ? { text: '记得喝水', updated_at: 1_794_759_000 }
        : { text: '写回', updated_at: 1_794_759_001 }
      replyJson(200, body)(request, response)
    })
    const store = new ToolAuthStore()
    store.configure({ ...PUSH, base_url: backend.base })
    const client = new ToolAuthClient({ auth: () => store.current() })

    expect(await client.remind({ text: '写回' })).toEqual({
      ok: true,
      status: 200,
      data: { text: '写回', updated_at: 1_794_759_001 },
    })
    expect(await client.listReminders()).toEqual({
      ok: true,
      status: 200,
      data: { text: '记得喝水', updated_at: 1_794_759_000 },
    })
    expect(backend.requests.map(request => request.method)).toEqual(['POST', 'GET'])
    expect(JSON.parse(backend.requests[0]?.body ?? '{}')).toEqual({ text: '写回' })
  })

  it('sends voice synthesis with send_audio and only the optional fields present', async () => {
    const backend = await startBackend(replyJson(200, { status: 'sent' }))
    const store = new ToolAuthStore()
    store.configure({ ...PUSH, base_url: backend.base })
    const client = new ToolAuthClient({ auth: () => store.current() })

    await client.tts({ text: '你好' })
    await client.tts({ text: '你好', voice: 'v1', style: '开心', user_id: 'u1' })

    expect(backend.requests.map(request => request.path)).toEqual([
      '/api/screen/tts/speak',
      '/api/screen/tts/speak',
    ])
    expect(JSON.parse(backend.requests[0]?.body ?? '{}')).toEqual({ text: '你好', send_audio: true })
    expect(JSON.parse(backend.requests[1]?.body ?? '{}')).toEqual({
      text: '你好',
      voice: 'v1',
      style: '开心',
      send_audio: true,
      user_id: 'u1',
    })
  })

  it('folds a non-2xx answer into ok:false with the backend detail', async () => {
    const backend = await startBackend(replyJson(500, { detail: 'db down' }))
    const store = new ToolAuthStore()
    store.configure({ ...PUSH, base_url: backend.base })
    const client = new ToolAuthClient({ auth: () => store.current() })

    expect(await client.notify({ title: 't', content: 'c' })).toEqual({
      ok: false,
      status: 500,
      error: 'HTTP 500: db down',
    })
  })

  it('reports a non-JSON success body as a failure', async () => {
    const backend = await startBackend((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('OK')
    })
    const store = new ToolAuthStore()
    store.configure({ ...PUSH, base_url: backend.base })
    const client = new ToolAuthClient({ auth: () => store.current() })

    const result = await client.listReminders()
    expect(result.ok).toBe(false)
    expect(result.status).toBe(200)
    expect(result.error).toContain('non-JSON')
  })

  it('reports a connection failure without leaking the token', async () => {
    const backend = await startBackend(replyJson(200, { status: 'ok' }))
    const base = backend.base
    await backend.close()
    backends.splice(backends.indexOf(backend), 1)

    const store = new ToolAuthStore()
    store.configure({ ...PUSH, base_url: base })
    const client = new ToolAuthClient({ auth: () => store.current() })

    const result = await client.notify({ title: 't', content: 'c' })
    expect(result.ok).toBe(false)
    expect(result.status).toBeNull()
    expect(result.error).toBeDefined()
    expect(result.error).not.toContain(PUSH.token)
  })

  it('redacts the token when the backend echoes it back', async () => {
    const backend = await startBackend(replyJson(400, { detail: `bad token ${PUSH.token}` }))
    const store = new ToolAuthStore()
    store.configure({ ...PUSH, base_url: backend.base })
    const client = new ToolAuthClient({ auth: () => store.current() })

    const result = await client.remind({ text: 'x' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('[redacted]')
    expect(result.error).not.toContain(PUSH.token)
  })

  it('times out a backend that never answers', async () => {
    const backend = await startBackend(() => {
      // Intentionally never respond: the client owns the timeout.
    })
    const store = new ToolAuthStore()
    store.configure({ ...PUSH, base_url: backend.base })
    const client = new ToolAuthClient({ auth: () => store.current(), timeoutMs: 50 })

    const result = await client.listReminders()
    expect(result.ok).toBe(false)
    expect(result.status).toBeNull()
    expect(result.error).toContain('timed out')
  })

  it('answers unconfigured without a request when nothing was pushed', async () => {
    const store = new ToolAuthStore()
    const client = new ToolAuthClient({ auth: () => store.current() })
    const result = await client.notify({ title: 't', content: 'c' })
    expect(result.ok).toBe(false)
    expect(result.status).toBeNull()
    expect(result.error).toContain('not configured')
  })
})
