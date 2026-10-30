export type UrlErrorCode =
  | 'EMPTY_URL'
  | 'UNSUPPORTED_SCHEME'
  | 'URL_HAS_CREDENTIALS'
  | 'URL_HAS_PATH'
  | 'INVALID_HOST'
  | 'URL_INVALID'

export class UrlValidationError extends Error {
  readonly code: UrlErrorCode

  constructor(code: UrlErrorCode, message: string) {
    super(message)
    this.name = 'UrlValidationError'
    this.code = code
  }
}

const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const HOST_PORT_REMAINDER_PATTERN = /^\d+(?:[/?#]|$)/

function toUrlCandidate(input: string): string {
  if (input.includes('://')) return input
  const scheme = SCHEME_PATTERN.exec(input)
  if (scheme === null) return `https://${input}`

  const remainder = input.slice(scheme[0].length)
  if (HOST_PORT_REMAINDER_PATTERN.test(remainder)) return `https://${input}`
  return input
}

export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    throw new UrlValidationError('EMPTY_URL', '请输入服务器地址')
  }

  let url: URL
  try {
    url = new URL(toUrlCandidate(trimmed))
  } catch (error) {
    if (error instanceof TypeError) {
      throw new UrlValidationError('URL_INVALID', '服务器地址格式不正确')
    }
    throw error
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlValidationError('UNSUPPORTED_SCHEME', '仅支持 http:// 或 https:// 地址')
  }

  if (url.username.length > 0 || url.password.length > 0) {
    throw new UrlValidationError('URL_HAS_CREDENTIALS', '服务器地址不能包含用户名或密码')
  }

  if (url.pathname !== '' && url.pathname !== '/') {
    throw new UrlValidationError(
      'URL_HAS_PATH',
      '服务器地址只能包含协议、主机和端口，不能带路径',
    )
  }

  const hostname = url.hostname
  if (hostname.trim().length === 0 || /\s/.test(hostname)) {
    throw new UrlValidationError('INVALID_HOST', '服务器地址格式不正确')
  }

  return url.origin
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]'
  )
}
