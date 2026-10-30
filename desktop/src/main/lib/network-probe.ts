import { readFileSync } from 'node:fs'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import type { NetworkLayer } from '../../shared/types'
import { isIpAddress, normalizeFingerprint } from './tls'

export interface LayerProbeResult {
  readonly ok: boolean
  readonly latencyMs: number
  readonly error?: string
  readonly code?: string
}

export interface ProbeLayerOptions {
  readonly timeoutMs?: number
}

const DEFAULT_PROBE_TIMEOUT_MS = 3_000
const MAX_RESPONSE_BYTES = 64 * 1024

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function describeProbeError(error: unknown): { message: string; code: string } {
  const raw = error instanceof Error ? error.message : '未知错误'
  const nodeCode =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : ''
  const text = raw.trim().length > 0 ? raw.slice(0, 180) : '连接失败'
  if (nodeCode === 'ETIMEDOUT' || /timeout/i.test(raw)) {
    return { message: '连接超时', code: 'TIMEOUT' }
  }
  if (
    nodeCode.startsWith('ERR_TLS') ||
    nodeCode.startsWith('DEPTH_') ||
    nodeCode.includes('CERT') ||
    /certificate|tls/i.test(raw)
  ) {
    return { message: `TLS 校验失败：${text}`, code: 'TLS_ERROR' }
  }
  return { message: text, code: 'CONNECT_FAILED' }
}

function peerFingerprint(response: IncomingMessage): string {
  const socket = response.socket as
    | (typeof response.socket & { getPeerCertificate?: (detailed?: boolean) => unknown })
    | null
  const certificate = socket?.getPeerCertificate?.(true)
  if (typeof certificate !== 'object' || certificate === null) return ''
  const record = certificate as Record<string, unknown>
  const raw = record['fingerprint256'] ?? record['fingerprint']
  return typeof raw === 'string' ? normalizeFingerprint(raw) : ''
}

function finishOnResponse(
  response: IncomingMessage,
  layer: NetworkLayer,
  startedAt: number,
  finish: (result: LayerProbeResult) => void,
): void {
  const pinnedFingerprint = peerFingerprint(response)
  let received = 0
  response.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (received > MAX_RESPONSE_BYTES) response.destroy()
  })
  response.on('end', () => {
    const latencyMs = Date.now() - startedAt
    const status = response.statusCode ?? 0
    if (status < 200 || status >= 300) {
      finish({
        ok: false,
        latencyMs,
        error: `健康检查返回 HTTP ${String(status)}`,
        code: 'HEALTH_STATUS',
      })
      return
    }
    if (layer.tlsMode === 'pinned' && layer.fingerprint256 !== undefined) {
      if (
        pinnedFingerprint.length === 0 ||
        pinnedFingerprint !== normalizeFingerprint(layer.fingerprint256)
      ) {
        finish({
          ok: false,
          latencyMs,
          error: '服务器证书指纹与固定值不匹配',
          code: 'TLS_PIN_MISMATCH',
        })
        return
      }
    }
    finish({ ok: true, latencyMs })
  })
  response.on('error', (error: Error) => {
    finish({ ok: false, latencyMs: Date.now() - startedAt, ...describeProbeError(error) })
  })
}

function probeHttpsLayer(
  layer: NetworkLayer,
  timeoutMs: number,
): Promise<LayerProbeResult> {
  const url = new URL(layer.address)
  const host = stripBrackets(url.hostname)
  const port = url.port.length > 0 ? Number(url.port) : 443
  const startedAt = Date.now()

  const options: RequestOptions = {
    method: 'GET',
    hostname: host,
    port,
    path: '/health',
    timeout: timeoutMs,
    headers: { accept: 'application/json', 'user-agent': 'Kinship-Desktop-Network-Probe' },
    rejectUnauthorized: layer.tlsMode === 'system',
  }
  if (!isIpAddress(host)) options.servername = host

  if (layer.tlsMode === 'pinned' && layer.caPemPath !== undefined) {
    try {
      options.ca = readFileSync(layer.caPemPath)
      options.rejectUnauthorized = true
    } catch {
      return Promise.resolve({
        ok: false,
        latencyMs: 0,
        error: '固定证书的 CA 文件不可用',
        code: 'TLS_CA_UNAVAILABLE',
      })
    }
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (result: LayerProbeResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const request = httpsRequest(options, (response) => {
      finishOnResponse(response, layer, startedAt, finish)
    })
    request.on('timeout', () => {
      request.destroy(new Error('timeout'))
    })
    request.on('error', (error: Error) => {
      finish({ ok: false, latencyMs: Date.now() - startedAt, ...describeProbeError(error) })
    })
    request.end()
  })
}

function probeHttpLayer(layer: NetworkLayer, timeoutMs: number): Promise<LayerProbeResult> {
  const url = new URL(layer.address)
  const host = stripBrackets(url.hostname)
  const port = url.port.length > 0 ? Number(url.port) : 80
  const startedAt = Date.now()

  return new Promise((resolve) => {
    let settled = false
    const finish = (result: LayerProbeResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const request = httpRequest(
      {
        method: 'GET',
        hostname: host,
        port,
        path: '/health',
        timeout: timeoutMs,
        headers: { accept: 'application/json', 'user-agent': 'Kinship-Desktop-Network-Probe' },
      },
      (response) => {
        finishOnResponse(response, layer, startedAt, finish)
      },
    )
    request.on('timeout', () => {
      request.destroy(new Error('timeout'))
    })
    request.on('error', (error: Error) => {
      finish({ ok: false, latencyMs: Date.now() - startedAt, ...describeProbeError(error) })
    })
    request.end()
  })
}

export function probeNetworkLayer(
  layer: NetworkLayer,
  options: ProbeLayerOptions = {},
): Promise<LayerProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  let url: URL
  try {
    url = new URL(layer.address)
  } catch {
    return Promise.resolve({
      ok: false,
      latencyMs: 0,
      error: '网络层地址无效',
      code: 'INVALID_ADDRESS',
    })
  }

  if (url.protocol === 'http:') return probeHttpLayer(layer, timeoutMs)
  if (url.protocol === 'https:') return probeHttpsLayer(layer, timeoutMs)
  return Promise.resolve({
    ok: false,
    latencyMs: 0,
    error: '网络层地址必须使用 http 或 https',
    code: 'INVALID_ADDRESS',
  })
}
