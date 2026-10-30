import type { Session } from 'electron'

export interface AuthFailureGuardOptions {
  readonly getOrigin: () => string | null
  readonly onUnauthorized: (url: string) => void | Promise<void>
  readonly log?: (message: string) => void
}

export function isSameOriginUnauthorized(
  url: string,
  origin: string | null,
  statusCode: number,
): boolean {
  if (statusCode !== 401) return false
  if (origin === null || origin.length === 0) return false
  return url === origin || url.startsWith(`${origin}/`)
}

export function installAuthFailureGuard(
  session: Pick<Session, 'webRequest'>,
  options: AuthFailureGuardOptions,
): void {
  session.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
    if (!isSameOriginUnauthorized(details.url, options.getOrigin(), details.statusCode)) return
    options.log?.(`SPA 请求返回 401：${details.url}`)
    void Promise.resolve(options.onUnauthorized(details.url)).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : 'unknown error'
      options.log?.(`处理 401 失败：${reason}`)
    })
  })
}
