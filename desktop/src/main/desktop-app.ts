import { join } from 'node:path'
import { app, type BrowserWindow, type Tray, type WebContents } from 'electron'
import {
  DEFAULT_SENSOR_PORT,
  LOG_DIRECTORY_NAME,
  LOG_FILENAME,
  SENSOR_PORT_SCAN_RANGE,
} from '../shared/constants'
import { IPC } from '../shared/ipc'
import type { SensorStatus } from '../shared/types'
import { AppController, type SpaAccessResult } from './app-controller'
import { registerIpcHandlers } from './ipc/handlers'
import { LogStreamService } from './lib/log-stream'
import { logger } from './lib/logger'
import { resolveSensorPaths, type SensorPaths } from './lib/sensor-paths'
import { SensorSupervisor } from './lib/sensor-supervisor'
import { waitForStartupAuth } from './lib/startup-auth'
import { installAuthFailureGuard } from './shell/auth-guard'
import { buildTokenInjectionScript } from './shell/token-inject'
import { createAppTray } from './shell/tray'
import { openSensorWindow } from './windows/sensor-window'

const TOKEN_STATUS_THROTTLE_MS = 30_000
const DEFAULT_TOKEN_POLL_MS = 300_000
const MIN_TOKEN_POLL_MS = 100
const DEFAULT_STARTUP_AUTH_WAIT_MS = 20_000
const STARTUP_AUTH_POLL_MS = 250
const UNAUTHORIZED_DEBOUNCE_MS = 3_000

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误'
}

function readTokenPollIntervalMs(): number {
  const raw = process.env.AXEUH_TOKEN_POLL_MS?.trim() ?? ''
  if (raw.length === 0) return DEFAULT_TOKEN_POLL_MS
  const value = Number(raw)
  if (!Number.isFinite(value) || value < MIN_TOKEN_POLL_MS) return DEFAULT_TOKEN_POLL_MS
  return Math.trunc(value)
}

function readStartupAuthWaitMs(): number {
  const raw = process.env.AXEUH_STARTUP_AUTH_WAIT_MS?.trim() ?? ''
  if (raw.length === 0) return DEFAULT_STARTUP_AUTH_WAIT_MS
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return DEFAULT_STARTUP_AUTH_WAIT_MS
  return Math.trunc(value)
}



export class DesktopApp {
  private controller: AppController | null = null
  private supervisor: SensorSupervisor | null = null
  private tray: Tray | null = null
  private lastStatus: SensorStatus | null = null
  private startPromise: Promise<void> | null = null
  private shutdownPromise: Promise<void> | null = null
  private closeHandlerInstalled = false
  private readonly closeGuarded = new WeakSet<BrowserWindow>()
  private lastInjectedToken: string | null = null
  private lastInjectedOrigin: string | null = null
  private lastTokenSyncAt = 0
  private authResetGeneration = 0
  private pendingTokenSync: Promise<void> | null = null
  private tokenPollTimer: ReturnType<typeof setInterval> | null = null
  private readonly tokenHookAttached = new WeakSet<WebContents>()
  private logStream: LogStreamService | null = null
  private unauthorizedGuardInstalled = false
  private lastUnauthorizedAt = 0

  start(): Promise<void> {
    if (this.startPromise === null) {
      this.startPromise = this.startInternal()
    }
    return this.startPromise
  }

  private async startInternal(): Promise<void> {
    const controller = new AppController()
    this.controller = controller

    const paths = resolveSensorPaths({
      resourcesPath: app.isPackaged
        ? process.resourcesPath
        : join(app.getAppPath(), 'resources'),
      appPath: app.getAppPath(),
      userDataPath: controller.getUserDataDir(),
      env: process.env,
    })
    this.lastStatus = this.defaultStatus(paths)

    const supervisor = new SensorSupervisor({
      paths,
      parentPid: process.pid,
      preferredPort: DEFAULT_SENSOR_PORT,
      maxPort: SENSOR_PORT_SCAN_RANGE.end,
      getServerUrl: () => controller.getServerUrl(),
      getTransport: () => controller.getTransport(),
      getTlsPolicy: () => controller.getSensorTlsPolicy(),
      onStatus: (status) => {
        this.handleStatus(status)
      },
      logger: {
        info: (message, fields) => logger.info(message, fields),
        warn: (message, fields) => logger.warn(message, fields),
        error: (message, fields) => logger.error(message, fields),
      },
      fakeSensorUrl: process.env.AXEUH_FAKE_SENSOR_URL,
      fakeSensorToken: process.env.AXEUH_FAKE_SENSOR_TOKEN,
      fakeSensorInstanceId: process.env.AXEUH_FAKE_SENSOR_INSTANCE_ID,
    })
    this.supervisor = supervisor
    this.exposeQaBridge(supervisor)

    const logStream = new LogStreamService({
      channel: IPC.LOG_EVENT,
      paths: {
        desktop: join(controller.getUserDataDir(), LOG_DIRECTORY_NAME, LOG_FILENAME),
        sensor: paths.logPath,
      },
    })
    this.logStream = logStream

    controller.setNetworkSyncHook(async () => {
      this.resetAuthInjection()
      await supervisor.applyNetworkConfig(controller.getTransport())
    })
    controller.setStartupDelegate({
      awaitSpaAccess: () => this.waitForSpaAuthentication(supervisor),
    })
    this.installUnauthorizedGuard(controller, supervisor)

    registerIpcHandlers({
      controller,
      supervisor,
      paths,
      logStream,
      getLastStatus: () => this.lastStatus ?? this.defaultStatus(paths),
      setLastStatus: (status) => {
        this.lastStatus = status
      },
      broadcastStatus: (status) => {
        this.handleStatus(status)
      },
      onServerChanged: () => {
        this.resetAuthInjection()
        this.attachTokenSync()
      },
      resetAuthState: () => {
        this.resetAuthInjection()
      },
    })

    controller.registerShutdownHook(() => supervisor.stop())
    controller.registerShutdownHook(() => logStream.stop())
    await controller.start()
    this.attachTokenSync()
    this.startTokenPoller()

    void supervisor.start().catch((error: unknown) => {
      logger.error('PC 采集端启动失败', { error: describeError(error) })
    })

    this.createTrayIfPossible(controller, supervisor)
  }

  private async waitForSpaAuthentication(
    supervisor: SensorSupervisor,
  ): Promise<SpaAccessResult> {
    if (process.env.AXEUH_DISABLE_TOKEN_SYNC === '1') return { ok: true }
    if (process.env.AXEUH_SKIP_STARTUP_AUTH_GUARD === '1') return { ok: true }

    try {
      await supervisor.start()
    } catch (error) {
      logger.warn('启动 PC 采集端失败', { error: describeError(error) })
    }

    const result = await waitForStartupAuth({
      getAuthToken: () => supervisor.getAuthToken(),
      getStatus: () => this.lastStatus,
      waitMs: readStartupAuthWaitMs(),
      pollMs: STARTUP_AUTH_POLL_MS,
    })
    if (!result.ok) {
      logger.warn('启动认证未就绪', {
        code: result.code ?? '',
        message: result.message ?? '',
      })
    }
    return result
  }

  private installUnauthorizedGuard(
    controller: AppController,
    supervisor: SensorSupervisor,
  ): void {
    if (this.unauthorizedGuardInstalled) return
    this.unauthorizedGuardInstalled = true

    installAuthFailureGuard(controller.getMainSession(), {
      getOrigin: () => controller.getServerOrigin(),
      log: (message) => logger.warn(message),
      onUnauthorized: async () => {
        if (process.env.AXEUH_DISABLE_TOKEN_SYNC === '1') return
        const now = Date.now()
        if (now - this.lastUnauthorizedAt < UNAUTHORIZED_DEBOUNCE_MS) return
        this.lastUnauthorizedAt = now

        const auth = await supervisor.getAuthToken()
        const origin = controller.getServerOrigin()
        if (
          auth !== null &&
          auth.token.length > 0 &&
          (auth.token !== this.lastInjectedToken || origin !== this.lastInjectedOrigin)
        ) {
          await this.syncAuthToken(true)
          if (
            this.lastInjectedToken === auth.token &&
            this.lastInjectedOrigin === origin
          ) {
            return
          }
        }
        if (controller.isSettingsVisible()) return
        logger.warn('SPA 收到 401 且令牌无法恢复登录，打开本地设置')
        await controller.openControl('settings')
      },
    })
  }

  private defaultStatus(paths: SensorPaths): SensorStatus {
    return {
      state: 'stopped',
      enabled: false,
      running: false,
      port: DEFAULT_SENSOR_PORT,
      panelUrl: '',
      logPath: paths.logPath,
    }
  }

  private handleStatus(status: SensorStatus): void {
    this.lastStatus = status
    if (status.loggedIn === true) {
      void this.syncAuthToken()
    }
    this.attachTokenSync()
    const controller = this.controller
    if (controller === null) return
    const settings = controller.getSettingsWebContents()
    if (settings === null || settings.isDestroyed()) return
    settings.send(IPC.STATUS_CHANGED, status)
  }

  private exposeQaBridge(supervisor: SensorSupervisor): void {
    if (process.env.AXEUH_QA !== '1') return
    const bridge = globalThis.__AXEUH_QA__
    if (bridge === undefined) return
    bridge.supervisor = supervisor
    bridge.syncAuthToken = () => this.syncAuthToken(true)
  }

  private attachTokenSync(): void {
    const controller = this.controller
    if (controller === null) return
    const window = controller.getMainWindow()
    if (window === null || window.isDestroyed()) return
    const contents = window.webContents
    if (contents.isDestroyed()) return
    if (this.tokenHookAttached.has(contents)) return
    this.tokenHookAttached.add(contents)
    contents.on('did-finish-load', () => {
      void this.syncAuthToken(true)
    })
  }

  private startTokenPoller(): void {
    if (this.tokenPollTimer !== null) return
    if (process.env.AXEUH_DISABLE_TOKEN_SYNC === '1') return
    this.tokenPollTimer = setInterval(() => {
      void this.syncAuthToken(true)
    }, readTokenPollIntervalMs())
    this.tokenPollTimer.unref?.()
  }

  private stopTokenPoller(): void {
    if (this.tokenPollTimer === null) return
    clearInterval(this.tokenPollTimer)
    this.tokenPollTimer = null
  }

  private resetAuthInjection(): void {
    this.authResetGeneration += 1
    this.lastInjectedToken = null
    this.lastInjectedOrigin = null
    this.lastTokenSyncAt = 0
  }

  private isTokenSyncThrottleDisabled(): boolean {
    if (process.env.AXEUH_QA === '1') return true
    return (process.env.AXEUH_TOKEN_POLL_MS?.trim() ?? '').length > 0
  }

  private syncAuthToken(force = false): Promise<void> {
    if (process.env.AXEUH_DISABLE_TOKEN_SYNC === '1') return Promise.resolve()
    if (this.pendingTokenSync !== null) return this.pendingTokenSync

    const now = Date.now()
    if (
      !force &&
      !this.isTokenSyncThrottleDisabled() &&
      now - this.lastTokenSyncAt < TOKEN_STATUS_THROTTLE_MS
    ) {
      return Promise.resolve()
    }
    this.lastTokenSyncAt = now

    this.pendingTokenSync = this.performAuthTokenSync()
      .catch((error: unknown) => {
        logger.warn('同步 SPA 后端 Token 失败', { error: describeError(error) })
      })
      .finally(() => {
        this.pendingTokenSync = null
      })
    return this.pendingTokenSync
  }

  private async performAuthTokenSync(): Promise<void> {
    const controller = this.controller
    const supervisor = this.supervisor
    if (controller === null || supervisor === null) return

    const window = controller.getMainWindow()
    if (window === null || window.isDestroyed()) return
    const contents = window.webContents
    if (contents.isDestroyed()) return
    const currentUrl = contents.getURL()
    if (currentUrl.length === 0 || currentUrl === 'about:blank') return

    const generation = this.authResetGeneration
    const auth = await supervisor.getAuthToken()
    if (auth === null || auth.token.length === 0) return
    if (generation !== this.authResetGeneration) return
    const origin = controller.getServerOrigin()
    if (auth.token === this.lastInjectedToken && origin === this.lastInjectedOrigin) return

    await contents.executeJavaScript(buildTokenInjectionScript(auth.token), true)
    if (generation !== this.authResetGeneration) return
    this.lastInjectedToken = auth.token
    this.lastInjectedOrigin = origin
    logger.info('已向 SPA 注入后端 Token', { expiresIn: auth.expiresIn ?? -1 })
  }

  private createTrayIfPossible(
    controller: AppController,
    supervisor: SensorSupervisor,
  ): void {
    const iconPath = app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(app.getAppPath(), 'resources', 'icon.png')

    const tray = createAppTray({
      iconPath,
      controller,
      supervisor,
      openSensorPanel: async () => {
        await supervisor.start()
        const status = await supervisor.getStatus()
        this.lastStatus = status
        if (status.state === 'runtime-missing' || status.state === 'conflict') {
          throw new Error(status.lastError ?? 'PC 采集端不可用')
        }
        openSensorWindow({
          baseUrl: supervisor.getBaseUrl(),
          parent: controller.getMainWindow() ?? undefined,
        })
      },
      getStatus: () => this.lastStatus ?? {
        state: 'stopped',
        enabled: false,
        running: false,
        port: DEFAULT_SENSOR_PORT,
      },
      log: (message, fields) => logger.info(message, fields),
    })

    this.tray = tray
    if (tray === null || this.closeHandlerInstalled) return
    this.closeHandlerInstalled = true

    app.on('browser-window-created', (_event, window) => {
      this.installCloseToTray(window)
    })

    const main = controller.getMainWindow()
    if (main !== null) this.installCloseToTray(main)
  }

  private installCloseToTray(window: BrowserWindow): void {
    if (this.closeGuarded.has(window)) return
    this.closeGuarded.add(window)

    window.on('close', (event) => {
      const controller = this.controller
      if (this.tray === null || controller === null) return
      if (controller.isQuitting()) return
      if (!controller.getConfig().window.minimizeToTray) return
      if (window !== controller.getMainWindow()) return

      event.preventDefault()
      window.hide()
    })
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise !== null) return this.shutdownPromise

    this.shutdownPromise = (async () => {
      this.stopTokenPoller()
      const supervisor = this.supervisor
      if (supervisor !== null) {
        try {
          await supervisor.stop()
        } catch (error) {
          logger.error('停止 PC 采集端失败', { error: describeError(error) })
        }
      }
      const controller = this.controller
      if (controller !== null) {
        await controller.shutdown()
      }
    })()

    return this.shutdownPromise
  }

  focus(): void {
    this.controller?.focus()
  }
}
