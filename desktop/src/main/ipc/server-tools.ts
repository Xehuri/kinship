import { X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'
import type { CertInfo, IpcResult, ServerTestResult } from '../../shared/types'
import { normalizeFingerprint, type TrustPolicy } from '../lib/tls'

export interface CertificateClassificationError {
  readonly code: 'CERT_INVALID'
  readonly message: string
}

const PEM_BLOCK_PATTERN =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/

const HOST_MISMATCH_MESSAGE = '证书主机名与服务器地址不匹配'
const VALIDITY_MESSAGE = '证书已过期或尚未生效'
const UNPARSEABLE_MESSAGE = '无法解析服务器证书'

export function firstCertificatePem(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const match = PEM_BLOCK_PATTERN.exec(value)
  return match === null ? undefined : match[0]
}

export function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1)
  return trimmed
}

function parseCertificate(pem: string | undefined): X509Certificate | null {
  const block = firstCertificatePem(pem)
  if (block === undefined) return null
  try {
    return new X509Certificate(block)
  } catch {
    return null
  }
}

function parseDate(value: string): number {
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : Number.NaN
}

export function classifyCertificate(
  host: string,
  leaf: CertInfo,
): CertificateClassificationError | null {
  const certificate = parseCertificate(leaf.caPem)
  if (certificate === null) {
    return { code: 'CERT_INVALID', message: UNPARSEABLE_MESSAGE }
  }

  const requestedHost = normalizeHost(host)
  const hostMatches =
    requestedHost.length > 0 &&
    (isIP(requestedHost) !== 0
      ? certificate.checkIP(requestedHost) !== undefined
      : certificate.checkHost(requestedHost) !== undefined)
  if (!hostMatches) {
    return { code: 'CERT_INVALID', message: HOST_MISMATCH_MESSAGE }
  }

  const validFrom = parseDate(leaf.validFrom)
  const validTo = parseDate(leaf.validTo)
  const certificateFrom = parseDate(certificate.validFrom)
  const certificateTo = parseDate(certificate.validTo)
  const now = Date.now()
  if (
    !Number.isFinite(validFrom) ||
    !Number.isFinite(validTo) ||
    !Number.isFinite(certificateFrom) ||
    !Number.isFinite(certificateTo) ||
    now < validFrom ||
    now > validTo ||
    now < certificateFrom ||
    now > certificateTo
  ) {
    return { code: 'CERT_INVALID', message: VALIDITY_MESSAGE }
  }

  return null
}

export function assertCertificateTrustable(
  host: string,
  leaf: CertInfo,
): CertificateClassificationError | null {
  return classifyCertificate(host, leaf)
}

export function buildServerTestError(
  code: string,
  message: string,
  cert?: CertInfo,
): IpcResult<ServerTestResult> {
  return {
    ok: true,
    data: {
      ok: false,
      error: message,
      code,
      ...(cert === undefined ? {} : { cert }),
    },
  }
}

export function trustPolicyAcceptsLeaf(
  policy: TrustPolicy,
  host: string,
  leaf: CertInfo,
): boolean {
  const requestedHost = normalizeHost(host)
  if (normalizeHost(policy.host) !== requestedHost) return false
  if (!policy.allowUntrustedCa) return false
  if (policy.pin === undefined) return false
  if (normalizeHost(policy.pin.host) !== requestedHost) return false

  const expected = normalizeFingerprint(policy.pin.fingerprint256)
  const actual = normalizeFingerprint(leaf.fingerprint256)
  return expected.length > 0 && expected === actual
}
