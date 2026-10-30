export const ERROR_CONTEXT_STORAGE_KEY = 'axeuh:last-error'

export type ErrorCode =
  | 'UNREACHABLE'
  | 'CERT_UNTRUSTED'
  | 'CERT_INVALID'
  | 'SENSOR_CONFLICT'
  | 'RUNTIME_MISSING'
  | 'UNKNOWN'

export interface ErrorContext {
  code: ErrorCode
  message: string
  url: string
  host: string
  port: string
  subject: string
  issuer: string
  validFrom: string
  validTo: string
  fingerprint: string
  caPem: string
  selfSigned: boolean
}

export type QueryValue = string | null | Array<string | null> | undefined
export type ErrorQuery = Record<string, QueryValue>

const ERROR_CODES: readonly ErrorCode[] = [
  'UNREACHABLE',
  'CERT_UNTRUSTED',
  'CERT_INVALID',
  'SENSOR_CONFLICT',
  'RUNTIME_MISSING',
  'UNKNOWN',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value)
}

function readStored(): Record<string, unknown> {
  try {
    const raw = sessionStorage.getItem(ERROR_CONTEXT_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

export function readErrorContext(query: ErrorQuery): ErrorContext {
  const stored = readStored()
  const storedCert = isRecord(stored.cert) ? stored.cert : {}

  const pick = (keys: readonly string[]): string => {
    for (const key of keys) {
      const fromQuery = query[key]
      if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery
      if (Array.isArray(fromQuery) && fromQuery.length > 0) {
        const first = fromQuery[0]
        if (typeof first === 'string' && first.length > 0) return first
      }
    }
    for (const key of keys) {
      const direct = asText(stored[key])
      if (direct.length > 0) return direct
      const nested = asText(storedCert[key])
      if (nested.length > 0) return nested
    }
    return ''
  }

  const rawCode = pick(['code']).toUpperCase()
  const code: ErrorCode = isErrorCode(rawCode) ? rawCode : 'UNKNOWN'

  return {
    code,
    message: pick(['message']),
    url: pick(['url']),
    host: pick(['host']),
    port: pick(['port']),
    subject: pick(['subject']),
    issuer: pick(['issuer']),
    validFrom: pick(['validFrom']),
    validTo: pick(['validTo']),
    fingerprint: pick(['fingerprint', 'fingerprint256']),
    caPem: pick(['caPem']),
    selfSigned: pick(['selfSigned']) === 'true',
  }
}
