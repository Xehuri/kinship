/**
 * Loopback HTTP API over one bound Kinship dsh Session.
 *
 * Transport only: authentication, bounded JSON bodies, route dispatch, SSE,
 * and best-effort projections. All Session behavior lives behind `BridgeHost`.
 * Tokens and request bodies are never logged.
 *
 * @module kinship-bridge/server
 */

// allow: SIZE_OK — one HTTP route table; splitting transports from routes would duplicate every error/auth path.

import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { requireBoundSession } from './binding.js'
import { BridgeError } from './errors.js'
import { lastTurnAt, projectMessages } from './messages.js'
import type {
  BridgeEvent,
  BridgeLogger,
  BridgeServerHandle,
  BridgeServerOptions,
} from './types.js'

/** Largest accepted JSON request body. */
export const DEFAULT_BODY_LIMIT_BYTES = 64 * 1024

/** Default and maximum `GET /v1/session/messages` page size. */
export const DEFAULT_MESSAGE_LIMIT = 50
export const MAX_MESSAGE_LIMIT = 200

const INBOX_CLASS = /^[a-z][a-z0-9_-]{0,31}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

function sendError(response: ServerResponse, error: BridgeError): void {
  sendJson(response, error.status, {
    error: error.code,
    message: error.message,
  })
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    const fail = (error: BridgeError): void => {
      if (settled) return
      settled = true
      reject(error)
    }

    request.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        fail(new BridgeError(413, 'body_too_large', `Request body exceeds ${String(limit)} bytes.`))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

async function readJsonObject(
  request: IncomingMessage,
  limit: number,
): Promise<Record<string, unknown>> {
  const raw = await readBody(request, limit)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new BridgeError(400, 'invalid_json', 'Request body is not valid JSON.')
  }
  if (!isRecord(parsed)) {
    throw new BridgeError(422, 'invalid_body', 'Request body must be a JSON object.')
  }
  return parsed
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (header === undefined) return false
  const expected = Buffer.from(`Bearer ${token}`, 'utf8')
  const supplied = Buffer.from(header, 'utf8')
  if (expected.length !== supplied.length) return false
  return timingSafeEqual(expected, supplied)
}

function pathOf(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  } catch {
    return '/'
  }
}

function requireMethod(
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
): boolean {
  if (request.method === method) return true
  response.setHeader('allow', method)
  sendJson(response, 405, { error: 'method_not_allowed' })
  return false
}

function stringField(
  body: Record<string, unknown>,
  key: string,
  options: { readonly allowEmpty?: boolean } = {},
): string {
  const value = body[key]
  if (typeof value !== 'string' || (options.allowEmpty !== true && value.trim() === '')) {
    throw new BridgeError(422, `missing_${key}`, `Field "${key}" must be a non-empty string.`)
  }
  return value
}

function optionalStringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new BridgeError(422, `invalid_${key}`, `Field "${key}" must be a string when present.`)
  }
  return value
}

function parseLimit(value: string | null): number {
  if (value === null) return DEFAULT_MESSAGE_LIMIT
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_MESSAGE_LIMIT) {
    throw new BridgeError(
      400,
      'invalid_limit',
      `limit must be an integer in 1..${String(MAX_MESSAGE_LIMIT)}.`,
    )
  }
  return parsed
}

function parseBefore(value: string | null): number | undefined {
  if (value === null) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new BridgeError(400, 'invalid_before', 'before must be a non-negative integer.')
  }
  return parsed
}

function writeFrame(response: ServerResponse, frame: unknown): void {
  if (!response.writableEnded) response.write(`data: ${JSON.stringify(frame)}\n\n`)
}

function writeSse(response: ServerResponse, event: BridgeEvent): void {
  writeFrame(response, {
    seq: event.seq,
    payload: {
      type: event.type,
      properties: event.data,
    },
  })
}

/**
 * Start the bridge HTTP server.
 *
 * @param options - host adapter, binding controller, bearer token, bind address, and version metadata.
 * @returns the bound handle; `port()` resolves `port: 0`.
 */
export async function startBridgeServer(options: BridgeServerOptions): Promise<BridgeServerHandle> {
  if (!isLoopbackHost(options.hostname)) {
    throw new Error(
      `kinship-bridge: refusing non-loopback bind "${options.hostname}"; use 127.0.0.1 or ::1`,
    )
  }
  if (options.token.trim() === '') {
    throw new Error('kinship-bridge: bearer token must not be empty')
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(`kinship-bridge: invalid port ${String(options.port)}`)
  }
  if (!Number.isInteger(options.bodyLimitBytes) || options.bodyLimitBytes < 1) {
    throw new Error('kinship-bridge: bodyLimitBytes must be a positive integer')
  }

  const { host, binding, logger } = options
  // Revolved from the panel without reopening the listener; every request
  // reads the current value, so a rotated token takes effect immediately.
  let token = options.token
  const openSse = new Set<ServerResponse>()
  /** Bound Session id per open SSE response; live frames are routed by it. */
  const sseSessions = new Map<ServerResponse, string>()
  /**
   * Live frames are not durable, so they have no log sequence of their own.
   * They are ordered strictly between the last durable event and the next one
   * with a monotone fraction: `durable + n/(n+1000)` stays below `durable + 1`,
   * never repeats, and resets when a durable event advances the base.
   */
  const liveSeq = { durable: 0, n: 0 }
  const nextLiveSeq = (): number => {
    liveSeq.n += 1
    return liveSeq.durable + liveSeq.n / (liveSeq.n + 1000)
  }

  const handleEvents = (
    request: IncomingMessage,
    response: ServerResponse,
  ): void => {
    const bound = requireBoundSession(binding, host)
    const sessionId = bound.id
    let ready = false
    const unsubscribe = host.subscribe((eventSessionId, event) => {
      if (!ready || eventSessionId !== sessionId) return
      if (Number.isFinite(event.seq)) liveSeq.durable = Math.max(liveSeq.durable, event.seq)
      writeSse(response, event)
    })
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    response.write('retry: 3000\n\n')
    response.write(': connected\n\n')
    ready = true
    openSse.add(response)
    sseSessions.set(response, sessionId)
    const bindingUnsubscribe = binding.onChange(() => {
      if (!response.writableEnded) {
        response.write(': binding-changed\n\n')
        response.end()
      }
    })
    const keepAlive = setInterval(() => {
      if (!response.writableEnded) response.write(': ping\n\n')
    }, 15_000)
    keepAlive.unref()

    let cleaned = false
    const cleanup = (): void => {
      if (cleaned) return
      cleaned = true
      clearInterval(keepAlive)
      unsubscribe()
      bindingUnsubscribe()
      openSse.delete(response)
      sseSessions.delete(response)
    }
    request.on('close', cleanup)
    response.on('close', cleanup)
  }

  const dispatch = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (!tokenMatches(request.headers.authorization, token)) {
      response.setHeader('www-authenticate', 'Bearer')
      sendJson(response, 401, { error: 'unauthorized' })
      return
    }

    const path = pathOf(request)

    if (path === '/v1/health') {
      if (!requireMethod(request, response, 'GET')) return
      const snapshot = binding.snapshot()
      sendJson(response, 200, {
        ok: true,
        version: options.version,
        dsh: options.dshVersion,
        session_id: snapshot.sessionId,
        preset: snapshot.sessionId === null ? null : 'kinship',
        status: snapshot.status,
      })
      return
    }

    if (path === '/v1/session') {
      if (!requireMethod(request, response, 'GET')) return
      const bound = requireBoundSession(binding, host)
      sendJson(response, 200, {
        session_id: bound.id,
        preset: 'kinship',
        status: 'bound',
        bound_at: binding.snapshot().boundAt,
        policy: binding.snapshot().policy,
      })
      return
    }

    if (path === '/v1/session/bind') {
      if (!requireMethod(request, response, 'POST')) return
      const body = await readJsonObject(request, options.bodyLimitBytes)
      const sessionId = stringField(body, 'session_id')
      const snapshot = binding.bind(sessionId, host)
      sendJson(response, 200, {
        ok: true,
        session_id: snapshot.sessionId,
        preset: 'kinship',
        status: snapshot.status,
        bound_at: snapshot.boundAt,
        policy: snapshot.policy,
      })
      return
    }

    if (path === '/v1/session/messages') {
      if (request.method === 'GET') {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        const limit = parseLimit(url.searchParams.get('limit'))
        const before = parseBefore(url.searchParams.get('before'))
        const bound = requireBoundSession(binding, host)
        const page = projectMessages(bound.session.events(), limit, before)
        sendJson(response, 200, {
          session_id: bound.id,
          messages: page.messages,
          has_more: page.has_more,
          next_before: page.next_before,
        })
        return
      }
      if (request.method === 'POST') {
        const body = await readJsonObject(request, options.bodyLimitBytes)
        const text = stringField(body, 'text')
        const source = optionalStringField(body, 'source')
        const bound = requireBoundSession(binding, host)
        const messageId = bound.session.send(
          text,
          source === undefined ? { kind: 'bridge' } : { kind: 'bridge', source },
          'next-turn',
        )
        sendJson(response, 202, {
          accepted: true,
          session_id: bound.id,
          message_id: messageId,
        })
        return
      }
      response.setHeader('allow', 'GET, POST')
      sendJson(response, 405, { error: 'method_not_allowed' })
      return
    }

    if (path === '/v1/session/abort') {
      if (!requireMethod(request, response, 'POST')) return
      const bound = requireBoundSession(binding, host)
      const result = bound.session.abort()
      sendJson(response, 202, {
        ok: true,
        session_id: bound.id,
        was_running: result.wasRunning,
      })
      return
    }

    if (path === '/v1/session/status') {
      if (!requireMethod(request, response, 'GET')) return
      const bound = requireBoundSession(binding, host)
      const info = bound.session.info()
      sendJson(response, 200, {
        session_id: bound.id,
        status: info.status,
        running: info.status === 'running',
        last_turn_at: lastTurnAt(bound.session.events()),
      })
      return
    }

    if (path === '/v1/session/children') {
      if (!requireMethod(request, response, 'GET')) return
      const bound = requireBoundSession(binding, host)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5_000)
      timer.unref()
      try {
        const children = await bound.session.children(controller.signal)
        sendJson(response, 200, { session_id: bound.id, children })
      } catch (error) {
        if (error instanceof BridgeError) throw error
        if (error instanceof Error && error.name === 'AbortError') {
          throw new BridgeError(504, 'children_timeout', 'Subagent listing timed out.')
        }
        throw new BridgeError(
          500,
          'children_failed',
          `Subagent listing failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      } finally {
        clearTimeout(timer)
      }
      return
    }

    if (path === '/v1/models') {
      if (!requireMethod(request, response, 'GET')) return
      requireBoundSession(binding, host)
      const providers = host.models === undefined ? [] : await host.models()
      sendJson(response, 200, { providers })
      return
    }

    if (path === '/v1/session/context') {
      if (!requireMethod(request, response, 'GET')) return
      const bound = requireBoundSession(binding, host)
      const row = host.context?.(bound.id) ?? null
      sendJson(response, 200, {
        session_id: bound.id,
        provider: row?.provider ?? null,
        model: row?.model ?? null,
        contextWindow: row?.contextWindow ?? null,
        usedTokens: row?.usedTokens ?? null,
        projectedTokens: row?.projectedTokens ?? null,
      })
      return
    }

    if (path === '/v1/session/compact') {
      if (!requireMethod(request, response, 'POST')) return
      const bound = requireBoundSession(binding, host)
      const result = host.compact?.(bound.id) ?? { status: 'unavailable' as const }
      if (result.status === 'busy') {
        throw new BridgeError(409, 'compaction_busy', 'Manual compaction needs an idle session.')
      }
      if (result.status === 'unavailable') {
        throw new BridgeError(500, 'compaction_unavailable', 'This harness composition has no manual compaction command.')
      }
      sendJson(response, 202, { accepted: true, session_id: bound.id, status: 'compacting' })
      return
    }

    if (path === '/v1/session/compaction') {
      if (!requireMethod(request, response, 'GET')) return
      const bound = requireBoundSession(binding, host)
      const snapshot = host.compaction?.(bound.id) ?? null
      sendJson(response, 200, {
        session_id: bound.id,
        status: snapshot?.status ?? 'none',
        covered_count: snapshot?.covered_count ?? 0,
        summary_text: snapshot?.summary_text ?? '',
        anchor_message_id: snapshot?.anchor_message_id ?? null,
        anchor_timestamp_ms: snapshot?.anchor_timestamp_ms ?? null,
        running: snapshot?.running === true,
      })
      return
    }

    if (path === '/v1/session/events') {
      if (!requireMethod(request, response, 'GET')) return
      handleEvents(request, response)
      return
    }

    if (path === '/v1/inbox') {
      if (!requireMethod(request, response, 'POST')) return
      const body = await readJsonObject(request, options.bodyLimitBytes)
      const wakeClass = stringField(body, 'class')
      if (!INBOX_CLASS.test(wakeClass)) {
        throw new BridgeError(422, 'invalid_class', 'class must match [a-z][a-z0-9_-]{0,31}.')
      }
      const text = stringField(body, 'text')
      const threadId = optionalStringField(body, 'thread_id')
      const bound = requireBoundSession(binding, host)
      const target = wakeClass === 'interrupt' && bound.session.info().status === 'running'
        ? 'next-step'
        : 'next-turn'
      const id = bound.session.send(
        `[${wakeClass}] ${text}`,
        {
          kind: 'inbox',
          class: wakeClass,
          ...(threadId === undefined ? {} : { threadId }),
        },
        target,
      )
      sendJson(response, 202, {
        accepted: true,
        id,
        class: wakeClass,
        target,
        session_id: bound.id,
      })
      return
    }

    sendJson(response, 404, { error: 'not_found' })
  }

  const disposeLive = host.subscribeLive?.((sessionId, live) => {
    for (const [response, boundId] of sseSessions) {
      if (boundId !== sessionId) continue
      writeFrame(response, {
        seq: nextLiveSeq(),
        payload: {
          type: live.type,
          properties: live.data,
        },
      })
    }
  })

  const server: Server = createServer((request, response) => {
    void dispatch(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        if (!response.writableEnded) response.end()
        return
      }
      if (error instanceof BridgeError) {
        sendError(response, error)
        return
      }
      logger?.error(
        'kinship-bridge: request failed: %s',
        error instanceof Error ? error.message : String(error),
      )
      sendJson(response, 500, { error: 'internal' })
    })
  })
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.hostname, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : options.port
  let closing: Promise<void> | undefined

  return {
    port: () => boundPort,
    setToken: (next: string) => {
      if (next.trim() === '') throw new Error('kinship-bridge: bearer token must not be empty')
      token = next
    },
    close: () => {
      if (closing !== undefined) return closing
      closing = new Promise<void>((resolve, reject) => {
        disposeLive?.()
        for (const response of openSse) {
          if (!response.writableEnded) response.end()
        }
        openSse.clear()
        sseSessions.clear()
        server.close(error => {
          if (error !== undefined && error !== null) reject(error)
          else resolve()
        })
        server.closeIdleConnections()
      })
      return closing
    },
  }
}

/** Exported for tests that need the same logger contract. */
export type { BridgeLogger }
