import { screen, type BrowserWindow, type WebContents, type WebContentsView } from 'electron'
import type { DesktopConfigManager } from '../app-config'
import { logger } from '../lib/logger'
import { sanitizeWindowBounds } from '../lib/window-state'
import { buildControlUrl, type ControlRoute } from '../shell/control-url'
import { classifyLoadError } from '../shell/error-classify'
import { createDesktopWindow, loadMainUrl } from './main-window'
import { createSettingsView } from './settings-view'

export interface WindowManagerOptions {
  readonly config: DesktopConfigManager
  readonly mainPartition: string
  readonly controlPartition: string
  readonly preloadPath: string
  readonly onMainLoadFailed?: (code: string, message: string, url: string) => Promise<void>
  readonly onMainReady?: () => void
}

const HASH_SAVE_DELAY_MS = 250

/**
 * 单窗口管理器：远程 SPA 占据 BrowserWindow 自身的 webContents，
 * 本地设置页是覆盖整个内容区的 WebContentsView。
 */
export class DesktopWindowManager {
  private window: BrowserWindow | null = null
  private settingsView: WebContentsView | null = null
  private settingsVisible = false
  private mainLoadedUrl: string | null = null
  private hashTimer: NodeJS.Timeout | null = null
  private pendingHash: string | null = null
  private mainFailed = false

  constructor(private readonly options: WindowManagerOptions) {}

  ensureWindow(): BrowserWindow {
    const existing = this.window
    if (existing !== null && !existing.isDestroyed()) return existing

    this.mainLoadedUrl = null
    this.mainFailed = false

    const window = createDesktopWindow({
      bounds: this.options.config.getBounds(),
      getServerOrigin: () => this.options.config.getServerOrigin(),
      partition: this.options.mainPartition,
      onBoundsChanged: (bounds) => this.options.config.saveBounds(bounds),
      onHashChanged: (hash) => this.scheduleHashSave(hash),
      onLoadFailed: (errorCode, description, failedUrl) => {
        const classified = classifyLoadError(errorCode, description)
        logger.warn('主窗口加载失败', { errorCode, description, url: failedUrl })
        const handler = this.options.onMainLoadFailed
        const failure =
          handler === undefined
            ? this.notifyMainLoadFailed(classified.code, classified.message, failedUrl)
            : handler(classified.code, classified.message, failedUrl)
        void failure.catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : 'unknown error'
          logger.error('打开错误页失败', { error: reason })
        })
      },
      onFirstReady: () => {
        logger.info('主窗口已加载', { url: this.options.config.getServerUrl() })
      },
      onLoaded: () => {
        this.options.onMainReady?.()
      },
      onOpenSettings: () => {
        void this.openControl('settings').catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : 'unknown error'
          logger.error('打开桌面设置失败', { error: reason })
        })
      },
    })

    this.window = window
    window.on('resize', () => this.syncSettingsBounds())
    window.once('closed', () => {
      if (this.window !== window) return
      this.destroySettingsView(window)
      this.window = null
      this.mainLoadedUrl = null
      this.mainFailed = false
      this.commitHash()
    })

    logger.info('桌面窗口已创建')
    return window
  }

  async openControl(
    route: ControlRoute,
    query?: Readonly<Record<string, string>>,
  ): Promise<void> {
    const window = this.ensureWindow()
    const view = this.ensureSettingsView()
    const url = buildControlUrl(route, query, process.env.AXEUH_RENDERER_URL)

    try {
      await view.webContents.loadURL(url)
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error'
      logger.warn('设置视图加载失败', { url, error: reason })
    }

    if (window.isDestroyed()) return
    window.contentView.addChildView(view)
    this.settingsVisible = true
    this.syncSettingsBounds()
    this.focusWindow(window)
    logger.info('设置视图已打开', { route })
  }

  showMain(): void {
    const serverUrl = this.options.config.getServerUrl()
    const window = this.getMainWindow()

    if (window === null) {
      if (serverUrl.length === 0) return
      this.createMainWindowIfNeeded()
      return
    }

    this.setSettingsVisible(window, false)

    if (this.mainFailed) {
      this.reloadMain()
      return
    }

    if (serverUrl.length > 0 && this.mainLoadedUrl !== serverUrl) {
      this.loadSpa(serverUrl)
    }

    this.focusWindow(window)
  }

  reloadMain(): void {
    const serverUrl = this.options.config.getServerUrl()
    if (serverUrl.length === 0) return

    const window = this.getMainWindow()
    if (window === null) {
      this.createMainWindowIfNeeded()
      return
    }

    this.mainFailed = false
    if (this.mainLoadedUrl !== serverUrl) {
      this.loadSpa(serverUrl)
      return
    }
    window.webContents.reload()
  }

  createMainWindowIfNeeded(): void {
    const serverUrl = this.options.config.getServerUrl()
    const existing = this.getMainWindow()

    if (existing !== null) {
      if (serverUrl.length === 0) return
      if (this.mainFailed) {
        this.reloadMain()
        return
      }
      if (this.mainLoadedUrl !== serverUrl) this.loadSpa(serverUrl)
      this.focusWindow(existing)
      return
    }

    this.ensureWindow()
    if (serverUrl.length === 0) return
    this.loadSpa(serverUrl)
  }

  closeMainWindow(): void {
    const window = this.window
    this.window = null
    this.mainLoadedUrl = null
    this.mainFailed = false
    this.commitHash()
    this.destroySettingsView(window)
    if (window !== null && !window.isDestroyed()) window.destroy()
  }

  async notifyMainLoadFailed(
    code: string,
    message: string,
    url: string,
    extra?: Readonly<Record<string, string>>,
  ): Promise<void> {
    logger.error('主窗口加载失败', { code, message, url })
    this.mainFailed = true
    await this.openControl('error', { ...extra, code, message, url })
  }

  focus(): void {
    const window = this.getMainWindow()
    if (window !== null) {
      if (this.settingsVisible) {
        this.focusWindow(window)
        return
      }
      this.showMain()
      return
    }

    if (this.options.config.getServerUrl().length > 0) {
      this.createMainWindowIfNeeded()
      return
    }
    void this.openControl('setup').catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : 'unknown error'
      logger.error('创建设置视图失败', { error: reason })
    })
  }

  saveWindowState(): void {
    this.commitHash()
    const window = this.getMainWindow()
    if (window === null) return

    const displays = screen.getAllDisplays().map((display) => ({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
    }))
    this.options.config.saveBounds(sanitizeWindowBounds(window.getBounds(), displays))
  }

  getMainWindow(): BrowserWindow | null {
    const window = this.window
    return window !== null && !window.isDestroyed() ? window : null
  }

  getSettingsWebContents(): WebContents | null {
    const view = this.settingsView
    if (view === null || view.webContents.isDestroyed()) return null
    return view.webContents
  }

  isSettingsVisible(): boolean {
    return this.settingsVisible
  }

  private ensureSettingsView(): WebContentsView {
    const existing = this.settingsView
    if (existing !== null && !existing.webContents.isDestroyed()) return existing

    const view = createSettingsView({
      preloadPath: this.options.preloadPath,
      partition: this.options.controlPartition,
    })
    this.settingsView = view
    return view
  }

  private loadSpa(serverUrl: string): void {
    const window = this.window
    if (window === null || window.isDestroyed()) return

    this.mainLoadedUrl = serverUrl
    this.mainFailed = false
    loadMainUrl(window, serverUrl, this.options.config.getLastHash())
  }

  private setSettingsVisible(window: BrowserWindow, visible: boolean): void {
    const view = this.settingsView
    if (view === null) {
      this.settingsVisible = false
      return
    }

    if (visible) {
      window.contentView.addChildView(view)
      this.settingsVisible = true
      this.syncSettingsBounds()
      return
    }

    window.contentView.removeChildView(view)
    this.settingsVisible = false
  }

  private syncSettingsBounds(): void {
    if (!this.settingsVisible) return
    const window = this.window
    const view = this.settingsView
    if (window === null || window.isDestroyed() || view === null) return

    const bounds = window.getContentBounds()
    view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height })
  }

  private destroySettingsView(window: BrowserWindow | null): void {
    const view = this.settingsView
    this.settingsView = null
    this.settingsVisible = false
    if (view === null) return

    if (window !== null && !window.isDestroyed()) {
      window.contentView.removeChildView(view)
    }
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  private focusWindow(window: BrowserWindow): void {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  private scheduleHashSave(hash: string): void {
    this.pendingHash = hash
    if (this.hashTimer !== null) clearTimeout(this.hashTimer)
    this.hashTimer = setTimeout(() => {
      this.hashTimer = null
      this.commitHash()
    }, HASH_SAVE_DELAY_MS)
  }

  private commitHash(): void {
    if (this.hashTimer !== null) {
      clearTimeout(this.hashTimer)
      this.hashTimer = null
    }
    const hash = this.pendingHash
    this.pendingHash = null
    if (hash !== null) this.options.config.saveLastHash(hash)
  }
}
