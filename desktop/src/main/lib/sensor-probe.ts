export interface SensorHealthBody {
  readonly status: string
  readonly agent_id: string
  readonly agent_name: string
  readonly pid: number
  readonly version: string
}

export type SensorHealthResult =
  | { readonly ok: true; readonly body: SensorHealthBody }
  | { readonly ok: false; readonly error: string }

export type SensorStatusResult =
  | { readonly ok: true; readonly status: Record<string, unknown> }
  | { readonly ok: false; readonly unauthorized?: boolean; readonly error: string }

export type SensorLogsResult =
  | {
      readonly ok: true
      readonly path?: string
      readonly lines: readonly string[]
    }
  | { readonly ok: false; readonly error: string }

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function redact(text: string, secret: string): string {
  if (secret.length === 0) return text
  return text.split(secret).join('******')
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return '请求超时'
    return error.message
  }
  return '未知错误'
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

export async function probeHealth(
  baseUrl: string,
  timeoutMs = 1500,
  fetchFn: FetchLike = fetch,
): Promise<SensorHealthResult> {
  try {
    const response = await fetchFn(joinUrl(baseUrl, '/health'), {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      return { ok: false, error: `健康检查失败：HTTP ${response.status}` }
    }

    const body = await readJson(response)
    if (!isRecord(body) || body['status'] !== 'ok') {
      return { ok: false, error: '健康检查返回异常' }
    }

    return {
      ok: true,
      body: {
        status: 'ok',
        agent_id: readString(body['agent_id']),
        agent_name: readString(body['agent_name']),
        pid: readNumber(body['pid']),
        version: readString(body['version']),
      },
    }
  } catch (error) {
    return { ok: false, error: `健康检查失败：${errorMessage(error)}` }
  }
}

export async function probeStatus(
  baseUrl: string,
  token: string,
  timeoutMs = 2500,
  fetchFn: FetchLike = fetch,
): Promise<SensorStatusResult> {
  try {
    const response = await fetchFn(joinUrl(baseUrl, '/pc-sensor/status'), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status === 401) {
      return { ok: false, unauthorized: true, error: redact('采集端认证失败', token) }
    }
    if (!response.ok) {
      return { ok: false, error: `状态查询失败：HTTP ${response.status}` }
    }

    const body = await readJson(response)
    if (!isRecord(body)) {
      return { ok: false, error: '状态查询返回异常' }
    }

    return { ok: true, status: body }
  } catch (error) {
    return { ok: false, error: redact(`状态查询失败：${errorMessage(error)}`, token) }
  }
}

export async function probeLogs(
  baseUrl: string,
  token: string,
  lines = 200,
  timeoutMs = 3000,
  fetchFn: FetchLike = fetch,
): Promise<SensorLogsResult> {
  try {
    const limit = Math.max(1, Math.floor(lines))
    const response = await fetchFn(
      joinUrl(baseUrl, `/pc-sensor/logs?lines=${String(limit)}`),
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      },
    )
    if (response.status === 401) {
      return { ok: false, error: redact('日志查询认证失败', token) }
    }
    if (!response.ok) {
      return { ok: false, error: `日志查询失败：HTTP ${response.status}` }
    }

    const body = await readJson(response)
    if (!isRecord(body) || !Array.isArray(body['lines'])) {
      return { ok: false, error: '日志查询返回异常' }
    }

    const logLines = body['lines'].filter((line): line is string => typeof line === 'string')
    const path = typeof body['path'] === 'string' ? body['path'] : undefined
    return path === undefined ? { ok: true, lines: logLines } : { ok: true, path, lines: logLines }
  } catch (error) {
    return { ok: false, error: redact(`日志查询失败：${errorMessage(error)}`, token) }
  }
}
