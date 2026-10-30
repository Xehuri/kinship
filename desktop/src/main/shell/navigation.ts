import type { BrowserWindow, WebContents } from 'electron'

export type NavigationDecision = 'allow' | 'external' | 'block'
export type PolicyLog = (message: string, fields?: Readonly<Record<string, string>>) => void

export interface WebContentsHolder {
  readonly webContents: WebContents
}

export function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function originOf(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

export function isSameOrigin(value: string, origin: string | null): boolean {
  if (origin === null || origin.length === 0) return false
  const candidate = originOf(value)
  return candidate !== null && candidate === origin
}

export function isOpenSettingsAction(url: string): boolean {
  return url.startsWith('axeuh://open-settings')
}

export function decideMainNavigation(
  url: string,
  allowedOrigin: string | null,
): NavigationDecision {
  if (!isHttpUrl(url)) return 'block'
  if (isSameOrigin(url, allowedOrigin)) return 'allow'
  return 'external'
}

function openExternal(url: string, log: PolicyLog): void {
  if (!isHttpUrl(url)) return
  const { shell } = require('electron') as typeof import('electron')
  void shell.openExternal(url).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : 'unknown error'
    log('打开外部链接失败', { url, error: reason })
  })
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/\/+$/, '')
}

export function isAllowedControlUrl(value: string, allowedPrefixes: readonly string[]): boolean {
  let href: string
  try {
    href = new URL(value).href
  } catch {
    return false
  }

  return allowedPrefixes.some((prefix) => {
    const base = normalizePrefix(prefix)
    if (base.length === 0) return false
    return href === base || href.startsWith(`${base}/`) || href.startsWith(`${base}#`)
  })
}

export function applyMainWindowPolicies(
  window: BrowserWindow,
  getAllowedOrigin: () => string | null,
  log: PolicyLog = () => undefined,
  onOpenSettings?: () => void,
): void {
  const guardNavigation = (event: Electron.Event, url: string): void => {
    if (isOpenSettingsAction(url)) {
      event.preventDefault()
      log('主窗口请求打开系统设置，交给桌面端设置视图', { url })
      onOpenSettings?.()
      return
    }

    const decision = decideMainNavigation(url, getAllowedOrigin())
    if (decision === 'allow') return

    event.preventDefault()
    if (decision === 'external') {
      log('主窗口导航到外部地址，已交给系统浏览器', { url })
      openExternal(url, log)
      return
    }
    log('已阻止主窗口导航', { url })
  }

  window.webContents.on('will-navigate', guardNavigation)
  window.webContents.on('will-redirect', guardNavigation)

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isOpenSettingsAction(url)) {
      log('主窗口请求打开系统设置，交给桌面端设置视图', { url })
      onOpenSettings?.()
      return { action: 'deny' }
    }
    if (isHttpUrl(url)) {
      log('主窗口请求新窗口，已交给系统浏览器', { url })
      openExternal(url, log)
    } else {
      log('已阻止主窗口打开新窗口', { url })
    }
    return { action: 'deny' }
  })
}

export function applyControlWindowPolicies(
  holder: WebContentsHolder,
  allowedPrefixes: readonly string[],
  log: PolicyLog = () => undefined,
): void {
  const guardNavigation = (event: Electron.Event, url: string): void => {
    if (isAllowedControlUrl(url, allowedPrefixes)) return

    event.preventDefault()
    if (isHttpUrl(url)) {
      log('控制页导航到外部地址，已交给系统浏览器', { url })
      openExternal(url, log)
      return
    }
    log('已阻止控制页导航', { url })
  }

  holder.webContents.on('will-navigate', guardNavigation)
  holder.webContents.on('will-redirect', guardNavigation)

  holder.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) {
      log('控制页请求新窗口，已交给系统浏览器', { url })
      openExternal(url, log)
    } else {
      log('已阻止控制页打开新窗口', { url })
    }
    return { action: 'deny' }
  })
}
