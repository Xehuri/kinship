import { app, BrowserWindow, nativeTheme, screen } from 'electron'
import type { DesktopConfig } from '../../shared/types'
import { APP_DISPLAY_NAME } from '../../shared/constants'
import { logger } from '../lib/logger'
import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  MIN_HEIGHT,
  MIN_WIDTH,
  sanitizeWindowBounds,
  type WindowBounds,
} from '../lib/window-state'
import { applyMainWindowPolicies, originOf, type PolicyLog } from '../shell/navigation'
import { installThemeSync } from '../shell/theme-sync'

export interface DesktopWindowOptions {
  readonly bounds?: DesktopConfig['window']['bounds']
  readonly getServerOrigin: () => string | null
  readonly partition: string
  readonly onBoundsChanged: (bounds: WindowBounds) => void
  readonly onHashChanged: (hash: string) => void
  readonly onLoadFailed: (code: number, message: string, url: string) => void
  readonly onFirstReady?: () => void
  readonly onLoaded?: () => void
  readonly onOpenSettings?: () => void
}

interface DesktopWindowState {
  targetUrl: string | null
  loaded: boolean
  failed: boolean
  firstReady: boolean
  themeInstalled: boolean
}

const BOUNDS_DEBOUNCE_MS = 300
const ABORTED_ERROR_CODE = -3

const windowStates = new WeakMap<BrowserWindow, DesktopWindowState>()

function normalizeHash(value: string | undefined): string {
  const trimmed = value?.trim() ?? ''
  if (trimmed.length === 0) return ''
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`
}

function buildMainUrl(serverUrl: string, lastHash: string | undefined): string {
  const base = serverUrl.replace(/\/+$/, '')
  return `${base}/mobile/${normalizeHash(lastHash)}`
}

function isReloadShortcut(input: Electron.Input): boolean {
  if (input.type !== 'keyDown') return false
  if (input.key === 'F5') return true
  return input.control && !input.alt && !input.meta && input.key.toLowerCase() === 'r'
}

function isDevToolsShortcut(input: Electron.Input): boolean {
  if (input.type !== 'keyDown') return false
  if (input.key === 'F12') return true
  return input.control && input.shift && input.key.toLowerCase() === 'i'
}

/**
 * 创建唯一的桌面窗口，但不加载任何 URL。窗口自身的 webContents 是远程 SPA；
 * 本地设置页作为 WebContentsView 覆盖层挂到 contentView 上。
 */
export function createDesktopWindow(options: DesktopWindowOptions): BrowserWindow {
  const displays = screen.getAllDisplays().map((display) => ({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
  }))
  const bounds = sanitizeWindowBounds(
    options.bounds ?? { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT },
    displays,
  )

  const window = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d0d14' : '#f5f7fa',
    title: APP_DISPLAY_NAME,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      partition: options.partition,
    },
  })

  const state: DesktopWindowState = {
    targetUrl: null,
    loaded: false,
    failed: false,
    firstReady: false,
    themeInstalled: false,
  }
  windowStates.set(window, state)

  const log: PolicyLog = (message, fields) => logger.warn(message, fields)
  applyMainWindowPolicies(window, options.getServerOrigin, log, options.onOpenSettings)

  window.webContents.on('before-input-event', (event, input) => {
    if (isReloadShortcut(input)) {
      event.preventDefault()
      window.webContents.reload()
      return
    }
    if (app.isPackaged) return
    if (isDevToolsShortcut(input)) {
      event.preventDefault()
      window.webContents.toggleDevTools()
    }
  })

  window.once('ready-to-show', () => {
    if (window.isDestroyed()) return
    if (state.loaded) window.show()
  })

  window.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    const target = state.targetUrl
    if (target === null) return
    if (originOf(details.url) === originOf(target)) state.failed = false
  })

  window.webContents.on('did-finish-load', () => {
    if (window.isDestroyed()) return
    const target = state.targetUrl
    if (target === null) return
    if (state.failed) return
    if (originOf(window.webContents.getURL()) !== originOf(target)) return
    state.loaded = true
    if (window.isMinimized()) window.restore()
    window.show()
    options.onLoaded?.()
    if (!state.firstReady) {
      state.firstReady = true
      options.onFirstReady?.()
    }
  })

  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame) return
      if (errorCode === ABORTED_ERROR_CODE) return
      const target = state.targetUrl
      if (target === null) return

      state.failed = true
      state.loaded = false
      options.onLoadFailed(errorCode, errorDescription, validatedUrl || target)
    },
  )

  window.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (!isMainFrame) return
    if (state.targetUrl === null) return
    try {
      const hash = new URL(url).hash
      if (hash.length > 0) options.onHashChanged(hash)
    } catch {
      return
    }
  })

  let boundsTimer: NodeJS.Timeout | null = null
  const emitBounds = (): void => {
    if (window.isDestroyed()) return
    options.onBoundsChanged(window.getBounds())
  }
  const scheduleBounds = (): void => {
    if (boundsTimer !== null) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      boundsTimer = null
      emitBounds()
    }, BOUNDS_DEBOUNCE_MS)
  }

  window.on('resize', scheduleBounds)
  window.on('move', scheduleBounds)
  window.on('close', () => {
    if (boundsTimer !== null) {
      clearTimeout(boundsTimer)
      boundsTimer = null
    }
    emitBounds()
  })
  window.on('closed', () => {
    if (boundsTimer !== null) {
      clearTimeout(boundsTimer)
      boundsTimer = null
    }
    windowStates.delete(window)
  })

  // 先给 SPA webContents 一个空白文档：未配置服务器时窗口也有渲染目标，
  // 后续 loadMainUrl 会在同一个 webContents 里导航到 SPA。
  void window.loadURL('about:blank')

  return window
}

/**
 * 在窗口自身的 webContents 中加载 SPA。第一次加载时才安装主题同步，
 * 保证 about:blank 阶段不会注入观察器或触发加载失败处理。
 */
export function loadMainUrl(
  window: BrowserWindow,
  serverUrl: string,
  lastHash?: string,
): void {
  const state = windowStates.get(window)
  if (state === undefined) return

  const targetUrl = buildMainUrl(serverUrl, lastHash)
  state.targetUrl = targetUrl
  state.loaded = false
  state.failed = false

  if (!state.themeInstalled) {
    state.themeInstalled = true
    installThemeSync(window)
  }

  void window.loadURL(targetUrl).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : 'unknown error'
    logger.debug('主窗口 loadURL 失败', { url: targetUrl, error: reason })
  })
}
