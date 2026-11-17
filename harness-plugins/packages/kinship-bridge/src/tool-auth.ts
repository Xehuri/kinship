/**
 * Tool credentials pushed by the Kinship backend, plus the loopback HTTP client
 * the sibling `kinship-tools` plugin uses to reach that backend.
 *
 * The backend owns its own listen address and service token, so the harness must
 * not read them from configuration: one push carries them, they are kept in
 * memory only (never written to `$DSH_HOME`), and a harness restart simply waits
 * for the next push. Reaching the backend from inside the harness process keeps
 * the notification, reminder-board and TTS tools native instead of one extra MCP
 * process per feature.
 *
 * The push is validated before it is accepted: a plaintext credential must not
 * be sent to an arbitrary host, so the URL has to be `http(s)` on loopback.
 *
 * @module kinship-bridge/tool-auth
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import { BridgeError } from './errors.js'

/** Pushed tool-auth document schema version. */
export const TOOL_AUTH_SCHEMA = 1

/** How long one backend call may take before it is reported as a timeout. */
export const TOOL_AUTH_TIMEOUT_MS = 30_000

/** Longest backend error detail this bridge copies into a `ToolResult`. */
const ERROR_DETAIL_MAX_CHARS = 200

/** One validated tool-auth push, exactly as the Kinship backend sends it. */
export interface PushedToolAuth {
  /** Wire schema; only `1` is accepted. */
  readonly schema: typeof TOOL_AUTH_SCHEMA
  /** Backend base URL; `http(s)` on loopback only. */
  readonly base_url: string
  /** Backend service token; memory-only and never echoed back. */
  readonly token: string
  /** Producer label; the Kinship backend reports `kinship-backend`. */
  readonly source: string
  /** Producer generation time in epoch milliseconds. */
  readonly generated_at: number
}

/** What the accepted push currently is, projected for siblings (camelCase). */
export interface ToolAuthStatus {
  /** True once a push has been accepted. */
  readonly configured: boolean
  /** Backend base URL, or null before the first push. */
  readonly baseUrl: string | null
  /** Push generation time in epoch milliseconds, or null before the first push. */
  readonly at: number | null
}

/** `GET /v1/kinship/tool-auth` body; deliberately carries no token. */
export interface ToolAuthView {
  readonly ok: true
  readonly schema: typeof TOOL_AUTH_SCHEMA
  readonly configured: boolean
  readonly base_url: string | null
  readonly at: number | null
}

/** Outcome of one backend call, as the sibling tools receive it. */
export interface ToolResult {
  readonly ok: boolean
  readonly status: number | null
  readonly data?: unknown
  readonly error?: string
}

/**
 * A push the route must reject with 400 `bad_request`.
 *
 * This is a `BridgeError`, so the server's existing error path renders it with
 * the contract's stable 400 body and no extra wiring.
 */
export class ToolAuthValidationError extends BridgeError {
  constructor(message: string) {
    super(400, 'bad_request', message)
    this.name = 'ToolAuthValidationError'
  }
}

/** Hosts allowed to receive the pushed token: loopback only. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Trim one message and strip the token, so a `ToolResult` never leaks it. */
function redact(text: string, token: string): string {
  const withoutToken = token === '' ? text : text.split(token).join('[redacted]')
  const collapsed = withoutToken.replace(/\s+/g, ' ').trim()
  return collapsed.length > ERROR_DETAIL_MAX_CHARS
    ? `${collapsed.slice(0, ERROR_DETAIL_MAX_CHARS)}...`
    : collapsed
}

/**
 * Validate one pushed tool-auth document.
 *
 * Unknown fields are dropped, so what stays in memory is exactly the contract's
 * set of fields. A non-loopback URL is refused instead of being accepted with a
 * warning: the push carries a bearer token in plaintext.
 *
 * @param value - untrusted JSON value from the request body.
 * @returns the normalized push document.
 * @throws {ToolAuthValidationError} 400 `bad_request` naming the offending field.
 */
export function parsePushedToolAuth(value: unknown): PushedToolAuth {
  if (!isRecord(value)) {
    throw new ToolAuthValidationError('Tool auth document must be a JSON object.')
  }
  if (value['schema'] !== TOOL_AUTH_SCHEMA) {
    throw new ToolAuthValidationError(`Field "schema" must be ${String(TOOL_AUTH_SCHEMA)}.`)
  }
  const rawUrl = value['base_url']
  if (!isNonEmptyString(rawUrl)) {
    throw new ToolAuthValidationError('Field "base_url" must be a non-empty string.')
  }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(rawUrl)
  } catch {
    throw new ToolAuthValidationError(`Field "base_url" must be an absolute URL: ${rawUrl}`)
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new ToolAuthValidationError(
      `Field "base_url" must be an http(s) URL: ${rawUrl}`,
    )
  }
  if (!LOOPBACK_HOSTS.has(parsedUrl.hostname)) {
    throw new ToolAuthValidationError(
      `Field "base_url" must point at 127.0.0.1 or localhost: ${rawUrl}`,
    )
  }
  const token = value['token']
  if (!isNonEmptyString(token)) {
    throw new ToolAuthValidationError('Field "token" must be a non-empty string.')
  }
  const source = value['source']
  if (!isNonEmptyString(source)) {
    throw new ToolAuthValidationError('Field "source" must be a non-empty string.')
  }
  const generatedAt = value['generated_at']
  if (typeof generatedAt !== 'number' || !Number.isInteger(generatedAt) || generatedAt < 0) {
    throw new ToolAuthValidationError('Field "generated_at" must be a non-negative integer.')
  }
  // Normalize the trailing slash away so the request paths join predictably.
  const baseUrl = parsedUrl.origin
  return {
    schema: TOOL_AUTH_SCHEMA,
    base_url: baseUrl,
    token,
    source,
    generated_at: generatedAt,
  }
}

/**
 * Memory-only store for the last accepted tool-auth push.
 *
 * Nothing here touches the filesystem: a restart drops the credentials and the
 * backend pushes again, which is the point of the handshake.
 */
export class ToolAuthStore {
  private state: PushedToolAuth | null = null

  /** Accept one validated push, replacing any previous one. */
  configure(input: PushedToolAuth): PushedToolAuth {
    this.state = input
    return input
  }

  /** Current push document, or null before the first accepted push. */
  current(): PushedToolAuth | null {
    return this.state
  }

  /** Token-free projection for siblings and the panel. */
  status(): ToolAuthStatus {
    const current = this.state
    if (current === null) return { configured: false, baseUrl: null, at: null }
    return { configured: true, baseUrl: current.base_url, at: current.generated_at }
  }

  /** `GET /v1/kinship/tool-auth` body. */
  view(): ToolAuthView {
    const current = this.state
    return {
      ok: true,
      schema: TOOL_AUTH_SCHEMA,
      configured: current !== null,
      base_url: current === null ? null : current.base_url,
      at: current === null ? null : current.generated_at,
    }
  }
}

/** One raw backend response. */
interface RawResponse {
  readonly status: number
  readonly text: string
}

/**
 * Send one HTTP(S) request and read the whole body.
 *
 * `https` skips certificate verification because the main Kinship instance
 * serves a self-signed certificate on loopback; `http` is used as-is.
 */
function sendRequest(
  url: URL,
  token: string,
  method: 'GET' | 'POST',
  body: unknown,
  timeoutMs: number,
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const isHttps = url.protocol === 'https:'
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
    const headers: Record<string, string | number> = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    }
    if (payload !== undefined) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = payload.byteLength
    }
    const options: RequestOptions = { method, headers, agent: false }
    if (isHttps) options.rejectUnauthorized = false

    let settled = false
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      reject(error instanceof Error ? error : new Error(String(error)))
    }

    const request = (isHttps ? httpsRequest : httpRequest)(url, options, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })
      response.on('end', () => {
        if (settled) return
        settled = true
        resolve({
          status: response.statusCode ?? 0,
          text: Buffer.concat(chunks).toString('utf8'),
        })
      })
      response.on('error', fail)
    })
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`request timed out after ${String(timeoutMs)}ms`))
    })
    request.on('error', fail)
    if (payload !== undefined) request.write(payload)
    request.end()
  })
}

/**
 * Loopback HTTP client for the Kinship backend's notification/reminder/TTS API.
 *
 * Every failure (no push yet, a non-2xx answer, a non-JSON body, a connection
 * error) is folded into `ok:false` with a short message instead of a throw: the
 * calling tool must always be able to answer the model.
 */
export class ToolAuthClient {
  private readonly auth: () => PushedToolAuth | null
  private readonly timeoutMs: number

  constructor(options: {
    readonly auth: () => PushedToolAuth | null
    readonly timeoutMs?: number
  }) {
    this.auth = options.auth
    this.timeoutMs = options.timeoutMs ?? TOOL_AUTH_TIMEOUT_MS
  }

  /** The message every call reports before the backend pushes its credentials. */
  private unconfigured(): ToolResult {
    return {
      ok: false,
      status: null,
      error: 'Kinship tool auth is not configured: the backend has not pushed /v1/kinship/tool-auth yet.',
    }
  }

  /**
   * Run one backend call.
   *
   * @param path - backend API path, joined onto the pushed base URL.
   * @param method - `GET` or `POST`.
   * @param body - JSON request body for a POST.
   * @returns the folded result; `error` never contains the service token.
   */
  private async call(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
  ): Promise<ToolResult> {
    const auth = this.auth()
    if (auth === null) return this.unconfigured()
    let url: URL
    try {
      url = new URL(path, auth.base_url)
    } catch (error) {
      return { ok: false, status: null, error: redact(messageOf(error), auth.token) }
    }

    let raw: RawResponse
    try {
      raw = await sendRequest(url, auth.token, method, body, this.timeoutMs)
    } catch (error) {
      return { ok: false, status: null, error: redact(messageOf(error), auth.token) }
    }

    if (raw.status < 200 || raw.status >= 300) {
      let detail = ''
      try {
        const parsed: unknown = JSON.parse(raw.text)
        if (isRecord(parsed)) {
          const candidate = parsed['detail'] ?? parsed['message']
          if (typeof candidate === 'string') detail = candidate
        }
      } catch {
        // A non-JSON error body contributes no detail; the status says enough.
      }
      const suffix = detail === '' ? '' : `: ${redact(detail, auth.token)}`
      return { ok: false, status: raw.status, error: `HTTP ${String(raw.status)}${suffix}` }
    }

    if (raw.text.trim() === '') return { ok: true, status: raw.status }
    try {
      return { ok: true, status: raw.status, data: JSON.parse(raw.text) }
    } catch {
      return { ok: false, status: raw.status, error: 'The Kinship backend returned a non-JSON body.' }
    }
  }

  /** `POST /api/notification/send` — one phone notification. */
  notify(input: { title: string; content: string }): Promise<ToolResult> {
    return this.call('/api/notification/send', 'POST', {
      title: input.title,
      content: input.content,
    })
  }

  /** `POST /api/reminders` — overwrite the whole reminder board. */
  remind(input: { text: string }): Promise<ToolResult> {
    return this.call('/api/reminders', 'POST', { text: input.text })
  }

  /** `GET /api/reminders` — read the reminder board envelope. */
  listReminders(): Promise<ToolResult> {
    return this.call('/api/reminders', 'GET')
  }

  /** `POST /api/screen/tts/speak` — synthesize and play one utterance. */
  tts(input: {
    text: string
    voice?: string
    style?: string
    user_id?: string
  }): Promise<ToolResult> {
    return this.call('/api/screen/tts/speak', 'POST', {
      text: input.text,
      ...(input.voice === undefined ? {} : { voice: input.voice }),
      ...(input.style === undefined ? {} : { style: input.style }),
      send_audio: true,
      ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
    })
  }
}
