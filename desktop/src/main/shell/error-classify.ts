export type LoadErrorCode = 'UNREACHABLE' | 'CERT_UNTRUSTED' | 'CERT_INVALID' | 'UNKNOWN'

export interface ClassifiedLoadError {
  readonly code: LoadErrorCode
  readonly message: string
}

const UNREACHABLE_CODES: readonly number[] = [-105, -106, -102, -118, -312]

const UNREACHABLE_MARKERS: readonly string[] = [
  'ERR_NAME_NOT_RESOLVED',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_CONNECTION_',
  'ERR_UNSAFE_PORT',
]

function text(value: string): string {
  return typeof value === 'string' ? value : ''
}

export function classifyLoadError(
  errorCode: number,
  errorDescription: string,
): ClassifiedLoadError {
  const description = text(errorDescription)

  if (errorCode === -202 || description.includes('ERR_CERT_AUTHORITY_INVALID')) {
    return { code: 'CERT_UNTRUSTED', message: '服务器证书不受系统信任' }
  }

  if (
    errorCode === -200 ||
    errorCode === -201 ||
    errorCode === -203 ||
    description.includes('ERR_CERT_')
  ) {
    return { code: 'CERT_INVALID', message: '服务器证书无效（主机名或有效期不匹配）' }
  }

  if (
    UNREACHABLE_CODES.includes(errorCode) ||
    UNREACHABLE_MARKERS.some((marker) => description.includes(marker))
  ) {
    return { code: 'UNREACHABLE', message: '无法连接到服务器' }
  }

  return { code: 'UNKNOWN', message: '无法加载服务器页面' }
}
