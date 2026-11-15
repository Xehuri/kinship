/**
 * Owner-facing JSON API behind the Kinship panel in the dsh web UI.
 *
 * The browser reaches these routes through the dsh Connection's exact Fetch
 * registry, which already applied the Host/Origin fence and a browser-session
 * check, so the panel needs no credential of its own and the bridge's loopback
 * bearer token stays the only secret kinship itself uses. Every write goes
 * through the plugin's own services, never by rewriting the profile patch.
 *
 * @module kinship-bridge/ui
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { BridgeError } from './errors.js'
import type { BindingController, BindingSnapshot, BridgeHost } from './types.js'

/** Absolute route below `/api` that returns one panel snapshot. */
export const UI_STATE_PATH = '/api/kinship/ui/state'
/** Absolute route below `/api` that saves bridge configuration. */
export const UI_CONFIG_PATH = '/api/kinship/ui/config'
/** Absolute route below `/api` that reveals or rotates the bridge bearer token. */
export const UI_TOKEN_PATH = '/api/kinship/ui/token'
/** Absolute route below `/api` that switches the bound Session. */
export const UI_BIND_PATH = '/api/kinship/ui/bind'

/** Largest accepted JSON body on the panel's write routes. */
export const UI_BODY_LIMIT_BYTES = 16 * 1024

/** Largest `bodyLimitBytes` the bridge Config accepts. */
const MAX_BODY_LIMIT_BYTES = 1_048_576

/** Loopback addresses the bridge may bind. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1'])

/** Environment variable names are shell-safe identifiers. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** One bridge configuration value set, as the panel edits it. */
export interface UiConfigView {
  readonly host: string
  readonly port: number
  readonly tokenEnv: string
  readonly tokenFile: string
  readonly policy: 'first' | 'manual'
  readonly sessionId: string
  readonly rebindOnMissing: boolean
  readonly bodyLimitBytes: number
}

/** Where the bridge bearer token comes from; the value itself never rides here. */
export interface UiTokenInfo {
  /** `env` reads `tokenEnv`, `file` reads `tokenFile`, `generated` reads the harness-home file. */
  readonly source: 'env' | 'file' | 'generated'
  /** Environment variable name for the `env` source. */
  readonly env: string | null
  /** Absolute secret-file path for the `file` and `generated` sources. */
  readonly path: string | null
  /** Character count of the current token, so the panel can show it is set. */
  readonly length: number
}

/** One live Kinship Session row. */
export interface UiSessionRow {
  readonly id: string
  readonly title: string | null
  readonly cwd: string | null
  readonly preset: string | null
  readonly status: 'idle' | 'running'
  readonly createdAt: number
  /** True for the Session the bridge currently serves. */
  readonly bound: boolean
}

/** Listening endpoint and version metadata. */
export interface UiBridgeInfo {
  /** URL kinship itself should use. */
  readonly url: string
  readonly host: string
  readonly port: number
  /** Bridge version. */
  readonly version: string
  /** Running harness version. */
  readonly dsh: string
}

/** One complete panel snapshot. */
export interface UiState {
  readonly ok: true
  readonly bridge: UiBridgeInfo
  readonly binding: BindingSnapshot
  /** Bound Session row, or null while unbound. */
  readonly session: UiSessionRow | null
  readonly token: UiTokenInfo
  readonly config: UiConfigView
  /** Whether this deployment can persist configuration edits from the panel. */
  readonly editable: boolean
  /** Live root Sessions running the `kinship` preset. */
  readonly sessions: readonly UiSessionRow[]
}

/** Result of revealing or rotating the token. */
export interface UiTokenAction {
  readonly token: string
  readonly info: UiTokenInfo
}

/** Operations the panel routes need from the plugin. */
export interface UiApiDeps {
  readonly host: BridgeHost
  readonly binding: BindingController
  readonly bridge: () => { readonly host: string; readonly port: number; readonly version: string; readonly dsh: string }
  readonly config: () => UiConfigView
  readonly editable: () => boolean
  readonly tokenInfo: () => UiTokenInfo
  readonly token: (action: 'reveal' | 'rotate') => UiTokenAction
  readonly saveConfig: (next: UiConfigView) => Promise<void>
  readonly bind: (sessionId: string) => BindingSnapshot
}

/** Fetch-shaped handlers, one per route. */
export interface UiRoutes {
  readonly state: () => Promise<Response>
  readonly config: (request: Request) => Promise<Response>
  readonly token: (request: Request) => Promise<Response>
  readonly bind: (request: Request) => Promise<Response>
}

/** A refusal the panel renders verbatim. */
export class UiError extends Error {
  /**
   * @param status - HTTP status to answer.
   * @param code - stable machine code for the panel's error text.
   * @param message - human sentence shown in the panel.
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'UiError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** JSON response with the panel's no-store policy. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** One failure envelope. */
function fail(status: number, code: string, message: string): Response {
  return json(status, { ok: false, error: { code, message } })
}

/** Map a thrown refusal onto its envelope. */
function errorResponse(error: unknown): Response {
  if (error instanceof UiError) return fail(error.status, error.code, error.message)
  if (error instanceof BridgeError) return fail(error.status, error.code, error.message)
  return fail(500, 'internal', error instanceof Error ? error.message : String(error))
}

/** Read one bounded JSON object body. */
async function readJson(request: Request): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await request.text()
  } catch (error) {
    throw new UiError(400, 'invalid_request', `Could not read the request body: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (text.length > UI_BODY_LIMIT_BYTES) throw new UiError(413, 'body_too_large', `Request body exceeds ${String(UI_BODY_LIMIT_BYTES)} bytes.`)
  if (text.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new UiError(400, 'invalid_request', 'Request body is not valid JSON.')
  }
  if (!isRecord(parsed)) throw new UiError(400, 'invalid_request', 'Request body must be a JSON object.')
  return parsed
}

function requireInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new UiError(400, 'invalid_config', `${field} must be an integer between ${String(min)} and ${String(max)}.`)
  }
  return value
}

/**
 * Apply one partial configuration edit on top of the active values.
 *
 * @param input - JSON object from the panel, holding only the fields it changed.
 * @param current - values the running plugin uses now.
 * @returns the complete next configuration; the plugin Config still validates it.
 * @throws {UiError} `400 invalid_config` naming the first unacceptable field.
 */
export function normalizeConfigPatch(input: unknown, current: UiConfigView): UiConfigView {
  if (!isRecord(input)) throw new UiError(400, 'invalid_request', 'Configuration must be a JSON object.')
  const next: Record<string, unknown> = { ...current }
  for (const [field, value] of Object.entries(input)) {
    switch (field) {
      case 'host':
        if (typeof value !== 'string' || !LOOPBACK_HOSTS.has(value)) {
          throw new UiError(400, 'invalid_config', 'host must be 127.0.0.1 or ::1; the bridge is loopback-only.')
        }
        next[field] = value
        break
      case 'port':
        next[field] = requireInteger(value, 'port', 0, 65_535)
        break
      case 'tokenEnv':
        if (typeof value !== 'string' || !ENV_NAME.test(value)) {
          throw new UiError(400, 'invalid_config', 'tokenEnv must be a shell-safe environment variable name.')
        }
        next[field] = value
        break
      case 'tokenFile': {
        const text = typeof value === 'string' ? value.trim() : undefined
        if (text === undefined) throw new UiError(400, 'invalid_config', 'tokenFile must be a string.')
        if (text !== '' && !isAbsolute(text)) throw new UiError(400, 'invalid_config', 'tokenFile must be an absolute path, or empty.')
        next[field] = text
        break
      }
      case 'policy':
        if (value !== 'first' && value !== 'manual') throw new UiError(400, 'invalid_config', 'policy must be "first" or "manual".')
        next[field] = value
        break
      case 'sessionId':
        if (typeof value !== 'string') throw new UiError(400, 'invalid_config', 'sessionId must be a string; empty means unset.')
        next[field] = value.trim()
        break
      case 'rebindOnMissing':
        if (typeof value !== 'boolean') throw new UiError(400, 'invalid_config', 'rebindOnMissing must be true or false.')
        next[field] = value
        break
      case 'bodyLimitBytes':
        next[field] = requireInteger(value, 'bodyLimitBytes', 1, MAX_BODY_LIMIT_BYTES)
        break
      default:
        throw new UiError(400, 'unknown_field', `Unknown configuration field "${field}".`)
    }
  }
  return next as unknown as UiConfigView
}

/** Kinship's own URL form: an IPv6 literal stays bracketed. */
function bridgeUrl(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${String(port)}`
}

/** Live root Kinship Sessions, oldest first, with the bound one flagged. */
function sessionRows(deps: UiApiDeps): UiSessionRow[] {
  const bound = deps.binding.snapshot().sessionId
  const rows = deps.host.catalog?.()
    ?? deps.host.listSessions().map(row => ({ ...row, title: null, cwd: null }))
  return rows
    .filter(row => row.isRoot && row.preset === 'kinship')
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map(row => ({
      id: row.id,
      title: row.title,
      cwd: row.cwd,
      preset: row.preset,
      status: row.status,
      createdAt: row.createdAt,
      bound: row.id === bound,
    }))
}

/**
 * Build the four route handlers.
 *
 * @param deps - live plugin state and the write operations it owns.
 * @returns one Fetch handler per route.
 */
export function createUiRoutes(deps: UiApiDeps): UiRoutes {
  return {
    state: async () => {
      try {
        const bridge = deps.bridge()
        const sessions = sessionRows(deps)
        const body: UiState = {
          ok: true,
          bridge: {
            url: bridgeUrl(bridge.host, bridge.port),
            host: bridge.host,
            port: bridge.port,
            version: bridge.version,
            dsh: bridge.dsh,
          },
          binding: deps.binding.snapshot(),
          session: sessions.find(row => row.bound) ?? null,
          token: deps.tokenInfo(),
          config: deps.config(),
          editable: deps.editable(),
          sessions,
        }
        return json(200, body)
      } catch (error) {
        return errorResponse(error)
      }
    },

    config: async (request) => {
      try {
        const body = await readJson(request)
        const patch = body['config']
        if (patch === undefined) throw new UiError(400, 'invalid_request', 'Expected a "config" object.')
        if (!deps.editable()) {
          throw new UiError(409, 'config_read_only', 'This deployment cannot persist configuration: the plugin row is not uniquely addressable in the active profile.')
        }
        const next = normalizeConfigPatch(patch, deps.config())
        await deps.saveConfig(next)
        return json(200, { ok: true, config: next, restarted: true })
      } catch (error) {
        return errorResponse(error)
      }
    },

    token: async (request) => {
      try {
        const body = await readJson(request)
        const action = body['action']
        if (action !== 'reveal' && action !== 'rotate') {
          throw new UiError(400, 'invalid_request', 'Expected {"action": "reveal"} or {"action": "rotate"}.')
        }
        const result = deps.token(action)
        return json(200, { ok: true, token: result.token, token_info: result.info })
      } catch (error) {
        return errorResponse(error)
      }
    },

    bind: async (request) => {
      try {
        const body = await readJson(request)
        const sessionId = body['sessionId']
        if (typeof sessionId !== 'string' || sessionId.trim() === '') {
          throw new UiError(400, 'invalid_request', 'sessionId is required.')
        }
        return json(200, { ok: true, binding: deps.bind(sessionId.trim()) })
      } catch (error) {
        return errorResponse(error)
      }
    },
  }
}

/**
 * Register the panel routes on the dsh Connection.
 *
 * The registration belongs to `ctx`, so unloading or reloading this plugin
 * removes the routes and a restarted plugin can claim the same paths again.
 *
 * @param ctx - context carrying `connection`; typically an `inject` child.
 * @param deps - live plugin state and write operations.
 */
export function installUiRoutes(ctx: Context, deps: UiApiDeps): void {
  const routes = createUiRoutes(deps)
  const connection = ctx.connection
  ctx.effect(() => connection.fetch.register({
    path: UI_STATE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: routes.state,
  }), 'kinship-bridge: UI state route')
  ctx.effect(() => connection.fetch.register({
    path: UI_CONFIG_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: routes.config,
  }), 'kinship-bridge: UI config route')
  ctx.effect(() => connection.fetch.register({
    path: UI_TOKEN_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: routes.token,
  }), 'kinship-bridge: UI token route')
  ctx.effect(() => connection.fetch.register({
    path: UI_BIND_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: routes.bind,
  }), 'kinship-bridge: UI bind route')
}
