import type { BrowserWindow } from 'electron'

export type NativeThemeSource = 'system' | 'light' | 'dark'

export interface ThemeSnapshot {
  readonly theme: string
  readonly bg: string
}

export interface ThemeSyncOptions {
  readonly setThemeSource?: (source: NativeThemeSource) => void
  readonly log?: (message: string, fields?: Readonly<Record<string, string>>) => void
}

export const THEME_MESSAGE_PREFIX = '__AXEUH_THEME__'
export const THEME_OBSERVER_KEY = '__axeuhThemeSyncV1'

const DEFAULT_BACKGROUND = '#0d0d14'
const THEME_BACKGROUNDS: Readonly<Record<string, string>> = {
  dark: '#0d0d14',
  light: '#f5f7fa',
  glacier: '#e8f4fc',
}
const HEX_COLOR = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const installedWindows = new WeakSet<BrowserWindow>()

export function mapWebThemeToNative(theme: string): NativeThemeSource {
  switch (theme) {
    case 'light':
      return 'light'
    case 'glacier':
      return 'light'
    case 'dark':
      return 'dark'
    default:
      return 'dark'
  }
}

export function backgroundColorForTheme(theme: string, reportedBg?: string): string {
  if (reportedBg !== undefined && HEX_COLOR.test(reportedBg)) return reportedBg
  return THEME_BACKGROUNDS[theme] ?? DEFAULT_BACKGROUND
}

export function parseThemeMessage(message: string): ThemeSnapshot | null {
  if (!message.startsWith(THEME_MESSAGE_PREFIX)) return null

  const raw = message.slice(THEME_MESSAGE_PREFIX.length).trim()
  if (raw.length === 0) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const record = parsed as Record<string, unknown>
  const theme = record.theme
  const bg = record.bg
  if (typeof theme !== 'string' || typeof bg !== 'string') return null
  return { theme, bg }
}

export function buildThemeObserverScript(): string {
  return `(() => {
  const KEY = '${THEME_OBSERVER_KEY}'
  const PREFIX = '${THEME_MESSAGE_PREFIX}'
  const existing = window[KEY]
  if (existing !== null && typeof existing === 'object' && typeof existing.read === 'function') {
    existing.read()
    return
  }
  const state = { last: '', read: null, observer: null }
  state.read = () => {
    const root = document.documentElement
    let stored = ''
    try {
      stored = window.localStorage.getItem('theme') || ''
    } catch {
      stored = ''
    }
    const theme = root.getAttribute('data-theme') || stored || ''
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim()
    const payload = JSON.stringify({ theme: theme, bg: bg })
    if (payload === state.last) return
    state.last = payload
    console.log(PREFIX + payload)
  }
  state.observer = new MutationObserver(() => {
    state.read()
  })
  state.observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'class', 'style'],
  })
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === 'theme') state.read()
  })
  window[KEY] = state
  state.read()
})()`
}

function applyNativeThemeSource(source: NativeThemeSource): void {
  const { nativeTheme } = require('electron') as typeof import('electron')
  nativeTheme.themeSource = source
}

function logAtDebug(message: string, fields?: Readonly<Record<string, string>>): void {
  const { logger } = require('../lib/logger') as typeof import('../lib/logger')
  logger.debug(message, fields)
}

export function installThemeSync(window: BrowserWindow, options: ThemeSyncOptions = {}): void {
  if (installedWindows.has(window)) return
  installedWindows.add(window)

  const setThemeSource = options.setThemeSource ?? applyNativeThemeSource
  const log = options.log ?? logAtDebug
  let lastApplied: string | null = null

  const apply = (snapshot: ThemeSnapshot): void => {
    if (window.isDestroyed()) return

    const key = `${snapshot.theme}\u0000${snapshot.bg}`
    if (key === lastApplied) return
    lastApplied = key

    const source = mapWebThemeToNative(snapshot.theme)
    const background = backgroundColorForTheme(snapshot.theme, snapshot.bg)
    setThemeSource(source)
    window.setBackgroundColor(background)
    log('主窗口主题已同步', { theme: snapshot.theme, source, background })
  }

  window.webContents.on('console-message', (details) => {
    if (window.isDestroyed()) return
    const snapshot = parseThemeMessage(details.message)
    if (snapshot === null) return
    apply(snapshot)
  })

  const inject = (): void => {
    if (window.isDestroyed()) return
    void window.webContents
      .executeJavaScript(buildThemeObserverScript(), true)
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : 'unknown error'
        log('注入主题观察器失败', { error: reason })
      })
  }

  window.webContents.on('dom-ready', inject)
  window.webContents.on('did-finish-load', inject)
}
