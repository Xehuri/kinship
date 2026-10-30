import type { CertInfo } from '../../../shared/types'

interface CertInfoWithCaPem extends CertInfo {
  caPem?: string
}

/**
 * The frozen CertInfo contract has no caPem field yet (T11 is expected to add
 * it). Read it defensively at runtime so trust stays disabled when it is absent.
 */
export function certificateCaPem(cert: CertInfo | null | undefined): string | undefined {
  if (!cert) return undefined
  const candidate = (cert as CertInfoWithCaPem).caPem
  if (typeof candidate !== 'string') return undefined
  const trimmed = candidate.trim()
  return trimmed.length > 0 ? candidate : undefined
}
