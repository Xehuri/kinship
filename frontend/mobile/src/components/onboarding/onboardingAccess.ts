/**
 * 里程碑页的手机访问地址。
 *
 * 用当前页面的 origin 而不是后端配置里的 server.host: 配置值常是 0.0.0.0,
 * 而用户此刻正是经这个 origin 访问到服务器的 (浏览器 / WebView / 桌面壳一致)。
 */
export function phoneAccessUrl(origin: string): string {
  const trimmed = origin.trim().replace(/\/+$/, '')
  if (!trimmed || trimmed === 'null') return '/mobile/'
  return `${trimmed}/mobile/`
}

export function currentPhoneAccessUrl(): string {
  if (typeof window === 'undefined') return '/mobile/'
  return phoneAccessUrl(window.location.origin)
}
