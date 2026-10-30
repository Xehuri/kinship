import { X509Certificate, randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname } from 'node:path'
import { connect, type TLSSocket } from 'node:tls'
import type { CertInfo } from '../../shared/types'

export type TlsErrorCode = 'TLS_FETCH_FAILED' | 'INVALID_CA_BUNDLE'

export class TlsError extends Error {
  readonly code: TlsErrorCode

  constructor(code: TlsErrorCode, message: string) {
    super(message)
    this.name = 'TlsError'
    this.code = code
  }
}

export interface TrustDecisionInput {
  hostname: string
  errorCode: number
  verificationResult?: string
  certificate?: {
    fingerprint256?: string
    /** Certificate validity start in seconds since the UNIX epoch, as Electron reports it. */
    validStart?: number
    /** Certificate validity end in seconds since the UNIX epoch, as Electron reports it. */
    validExpiry?: number
  }
}

export interface TrustPolicy {
  host: string
  allowUntrustedCa: boolean
  insecure?: boolean
  pin?: { host: string; fingerprint256: string }
}

export type TrustDecision = 'accept' | 'reject' | 'defer'

export interface FetchCertificateChainOptions {
  readonly host: string
  readonly port: number
  readonly servername?: string
  readonly timeoutMs?: number
}

export interface CertificateChainResult {
  chainPem: string
  leaf: CertInfo
  chain: CertInfo[]
}

interface PeerCertificateNode {
  raw?: Buffer
  fingerprint256?: string
  issuerCertificate?: PeerCertificateNode
}

const CERT_AUTHORITY_INVALID_CODE = -202
const DEFAULT_FETCH_TIMEOUT_MS = 8_000
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/

const VERIFICATION_CODES = {
  accept: 0,
  reject: -2,
  defer: -3,
} as const satisfies Record<TrustDecision, number>

function stripBrackets(host: string): string {
  const trimmed = host.trim()
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
}

function canonicalHost(host: string): string {
  return stripBrackets(host).toLowerCase()
}

export function isIpAddress(host: string): boolean {
  return isIP(stripBrackets(host)) !== 0
}

export function normalizeFingerprint(value: string): string {
  const prefixed = /^sha256\/(.+)$/i.exec(value.trim())
  if (prefixed !== null) {
    const decoded = Buffer.from(prefixed[1], 'base64')
    if (decoded.length === 32) return decoded.toString('hex')
  }

  const normalized = value.replace(/[\s:]/g, '').toLowerCase()
  return FINGERPRINT_PATTERN.test(normalized) ? normalized : ''
}

export function isAuthorityInvalid(errorCode: number, verificationResult?: string): boolean {
  if (errorCode === CERT_AUTHORITY_INVALID_CODE) return true
  // Electron reports Chromium errors with the ERR_ prefix; older builds omit it.
  return verificationResult?.includes('CERT_AUTHORITY_INVALID') === true
}

/**
 * Checks a certificate validity window in seconds since the UNIX epoch (the unit
 * Electron reports). Absent bounds mean the window is unknown and impose no
 * constraint; present but non-finite bounds are treated as invalid.
 */
export function isCertificateTimeValid(
  validStart: number | undefined,
  validExpiry: number | undefined,
  now: number,
): boolean {
  if (!Number.isFinite(now)) return false
  if (validStart !== undefined && (!Number.isFinite(validStart) || now < validStart)) {
    return false
  }
  if (validExpiry !== undefined && (!Number.isFinite(validExpiry) || now > validExpiry)) {
    return false
  }
  return true
}

export function shouldAcceptCertificate(
  input: TrustDecisionInput,
  policy: TrustPolicy,
): TrustDecision {
  if (canonicalHost(input.hostname) !== canonicalHost(policy.host)) return 'defer'
  if (input.errorCode === 0) return 'defer'
  if (policy.insecure === true) return 'accept'
  if (!policy.allowUntrustedCa) return 'defer'

  const pin = policy.pin
  if (pin === undefined) return 'defer'
  if (canonicalHost(pin.host) !== canonicalHost(policy.host)) return 'reject'

  const expected = normalizeFingerprint(pin.fingerprint256)
  const actual = normalizeFingerprint(input.certificate?.fingerprint256 ?? '')
  if (expected.length === 0 || actual !== expected) return 'reject'
  if (!isAuthorityInvalid(input.errorCode, input.verificationResult)) return 'reject'
  if (
    !isCertificateTimeValid(
      input.certificate?.validStart,
      input.certificate?.validExpiry,
      Date.now() / 1000,
    )
  ) {
    return 'reject'
  }
  return 'accept'
}

function readFingerprint256(certificate: Electron.Certificate): string | undefined {
  if ('fingerprint256' in certificate) {
    const fingerprint = certificate.fingerprint256
    if (typeof fingerprint === 'string' && normalizeFingerprint(fingerprint).length > 0) {
      return fingerprint
    }
  }
  // Electron's Certificate exposes the SHA-256 fingerprint as `fingerprint`.
  return certificate.fingerprint
}

function toTrustDecisionInput(request: Electron.Request): TrustDecisionInput {
  const input: TrustDecisionInput = {
    hostname: request.hostname,
    errorCode: request.errorCode,
    verificationResult: request.verificationResult,
  }
  const certificate = request.certificate
  const fingerprint256 = certificate === undefined ? undefined : readFingerprint256(certificate)
  const details: NonNullable<TrustDecisionInput['certificate']> = {}
  if (fingerprint256 !== undefined) details.fingerprint256 = fingerprint256
  if (certificate !== undefined) {
    details.validStart = certificate.validStart
    details.validExpiry = certificate.validExpiry
  }
  if (Object.keys(details).length > 0) input.certificate = details
  return input
}

export function installCertificateVerifyProc(
  session: Pick<Electron.Session, 'setCertificateVerifyProc'>,
  getPolicy: () => TrustPolicy,
  log?: (line: string) => void,
): void {
  // callback(0) also disables Chromium's Certificate Transparency check for this
  // request. That is acceptable only because the user explicitly pinned this exact
  // leaf certificate for this exact host; all other errors keep Chromium's default.
  session.setCertificateVerifyProc((request, callback) => {
    const decision = shouldAcceptCertificate(toTrustDecisionInput(request), getPolicy())
    log?.(
      `tls verify host=${request.hostname} decision=${decision} errorCode=${request.errorCode}`,
    )
    callback(VERIFICATION_CODES[decision])
  })
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = error.code
  return typeof code === 'string' ? code : undefined
}

function toFetchError(error: unknown): TlsError {
  if (error instanceof TlsError) return error
  const code = readErrorCode(error)
  return new TlsError(
    'TLS_FETCH_FAILED',
    code === undefined ? '无法获取服务器证书' : `无法获取服务器证书（${code}）`,
  )
}

function waitForSecureConnection(socket: TLSSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TlsError('TLS_FETCH_FAILED', '连接服务器超时，未能获取证书'))
    }, timeoutMs)
    timer.unref()

    socket.once('secureConnect', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once('error', (error: Error) => {
      clearTimeout(timer)
      reject(toFetchError(error))
    })
  })
}

function readRawChain(peer: PeerCertificateNode): Buffer[] {
  const raws: Buffer[] = []
  const seen = new Set<string>()
  let node: PeerCertificateNode | undefined = peer

  while (node !== undefined) {
    const raw = node.raw
    if (raw === undefined || raw.length === 0) break
    const key = node.fingerprint256 ?? raw.toString('hex')
    if (seen.has(key)) break
    seen.add(key)
    raws.push(raw)
    node = node.issuerCertificate
  }

  return raws
}

function toCertInfo(certificate: X509Certificate, host: string, port: number): CertInfo {
  const subject = certificate.subject.trim()
  const issuer = certificate.issuer.trim()
  return {
    host,
    port,
    subject,
    issuer,
    validFrom: new Date(certificate.validFrom).toISOString(),
    validTo: new Date(certificate.validTo).toISOString(),
    fingerprint256: normalizeFingerprint(certificate.fingerprint256),
    selfSigned: subject === issuer,
  }
}

function buildChain(socket: TLSSocket, host: string, port: number): CertificateChainResult {
  const raws = readRawChain(socket.getPeerCertificate(true))
  if (raws.length === 0) throw new TlsError('TLS_FETCH_FAILED', '服务器未返回可用的证书链')

  const entries = raws.map((raw) => {
    const certificate = new X509Certificate(raw)
    return { pem: certificate.toString(), info: toCertInfo(certificate, host, port) }
  })
  const chainPem = entries.map((entry) => entry.pem).join('\n')
  const chain = entries.map((entry) => entry.info)
  const leaf: CertInfo = { ...entries[0].info, caPem: chainPem }

  return { chainPem, leaf, chain }
}

export async function fetchCertificateChain(
  options: FetchCertificateChainOptions,
): Promise<CertificateChainResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const servername = options.servername ?? (isIpAddress(options.host) ? undefined : options.host)
  let socket: TLSSocket | undefined

  try {
    socket = connect({
      host: stripBrackets(options.host),
      port: options.port,
      servername,
      rejectUnauthorized: false,
      timeout: timeoutMs,
    })
    await waitForSecureConnection(socket, timeoutMs)
    return buildChain(socket, options.host, options.port)
  } catch (error) {
    throw toFetchError(error)
  } finally {
    socket?.destroy()
  }
}

function normalizeCaBundle(chainPem: string): string {
  const trimmed = chainPem.trim()
  if (trimmed.length === 0) throw new TlsError('INVALID_CA_BUNDLE', 'CA 证书内容为空')

  const blockPattern = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
  const blocks = trimmed.match(blockPattern)
  if (blocks === null || blocks.length === 0) {
    throw new TlsError('INVALID_CA_BUNDLE', 'CA 证书内容不是有效的 PEM 格式')
  }
  if (trimmed.replace(blockPattern, '').trim().length > 0) {
    throw new TlsError('INVALID_CA_BUNDLE', 'CA 证书只能包含 CERTIFICATE 区块')
  }

  return blocks.map((block) => `${block.trim()}\n`).join('')
}

export function writeCaBundle(path: string, chainPem: string): void {
  const content = normalizeCaBundle(chainPem)
  mkdirSync(dirname(path), { recursive: true })

  const tempPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  try {
    writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 })
    renameSync(tempPath, path)
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }
}
