import type { CertInfo, DesktopConfig } from '../../../shared/types'

export interface HostPort {
  host: string
  port: number
}

export function parseHostPort(url: string): HostPort | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    const fallback = parsed.protocol === 'https:' ? 443 : 80
    const port = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : fallback
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    return { host: parsed.hostname, port }
  } catch {
    return null
  }
}

export function pinFromCertificate(cert: CertInfo): NonNullable<DesktopConfig['server']['tlsPin']> {
  return {
    host: cert.host,
    fingerprint256: cert.fingerprint256,
  }
}

/**
 * Preserves an existing pin only while the origin is unchanged. Switching the
 * server URL always drops the old trust state.
 */
export function buildServerPayload(
  url: string,
  trustedCert: CertInfo | null,
  baseline: DesktopConfig['server'],
): DesktopConfig['server'] {
  if (trustedCert) {
    return {
      url,
      allowUntrustedCa: true,
      tlsPin: pinFromCertificate(trustedCert),
    }
  }

  if (baseline.url === url) {
    return {
      url,
      allowUntrustedCa: baseline.allowUntrustedCa,
      ...(baseline.tlsPin ? { tlsPin: baseline.tlsPin } : {}),
    }
  }

  return { url, allowUntrustedCa: false }
}
