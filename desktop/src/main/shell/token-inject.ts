export const SPA_TOKEN_REFRESH_EVENT = 'axeuh-token-refresh'

export function buildTokenInjectionScript(token: string): string {
  const value = JSON.stringify(token)
  return `(() => {
  const token = ${value}
  try {
    window.localStorage.setItem('mobile_token', token)
  } catch {
    // localStorage 不可用时仍通过事件通知 SPA
  }
  window.dispatchEvent(new CustomEvent('${SPA_TOKEN_REFRESH_EVENT}', { detail: token }))
})()`
}
