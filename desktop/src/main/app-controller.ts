import { join } from 'node:path'
import { app, session, type BrowserWindow, type Session, type WebContents } from 'electron'
import { DESKTOP_CONFIG_FILENAME } from '../shared/constants'
import {
  buildNetworkStateView,
  isSelectableLayer,
  selectableLayers,
  untestedStatuses,
} from '../shared/network'
import type {
  CertInfo,
  DesktopConfig,
  NetworkApplyResult,
  NetworkConfig,
  NetworkLayerStatus,
  NetworkStateView,
  TransportConfig,
  WindowPreferences,
} from '../shared/types'
import { DesktopConfigManager } from './app-config'
import { classifyCertificate, trustPolicyAcceptsLeaf } from './ipc/server-tools'
import { logger } from './lib/logger'
import { NetworkFailoverTracker } from './lib/network-failover'
import { NetworkRouter, type NetworkProbeOptions, type NetworkProbeOutcome } from './lib/network-router'
import type { SensorTlsPolicy } from './lib/sensor-config'
import type { SensorSupervisor } from './lib/sensor-supervisor'
import { fetchCertificateChain, type TrustPolicy } from './lib/tls'
import { registerBundleProtocol } from './shell/app-protocol'
import type { ControlRoute } from './shell/control-url'
import { installMainSessionPolicies } from './shell/session-policy'
import { ShutdownHooks } from './shell/shutdown'
import { DesktopWindowManager } from './windows/window-manager'

export const MAIN_WINDOW_PARTITION = 'persist:axeuh'
export const CONTROL_WINDOW_PARTITION = 'persist:axeuh-control'

const SHUTDOWN_TIMEOUT_MS = 8_000
const CERT_ERROR_TIMEOUT_MS = 8_000

function readStartRoute(): ControlRoute | null {
  const value = process.env.AXEUH_START_ROUTE?.trim() ?? ''
  if (value === 'setup' || value === 'settings' || value === 'error') return value
  return null
}

interface HostPort {
  readonly host: string
  readonly port: number
}

interface StartupCertificateIssue {
  readonly code: 'CERT_INVALID' | 'CERT_UNTRUSTED'
  readonly message: string
  readonly host: string
  readonly port: number
  readonly leaf: CertInfo
  readonly chainPem: string
}

export type NetworkChangeReason =
  | 'startup'
  | 'probe'
  | 'save'
  | 'select'
  | 'fallback'

export interface SpaAccessResult {
  readonly ok: boolean
  readonly code?: string
  readonly message?: string
}

export interface AppControllerStartupDelegate {
  awaitSpaAccess?(): Promise<SpaAccessResult>
}

export interface NetworkProbeRequest extends NetworkProbeOptions {
  readonly reason?: NetworkChangeReason
  readonly reloadWindow?: boolean
}

export interface AxeuhQaBridge {
  readonly controller: AppController
  supervisor?: SensorSupervisor
  syncAuthToken?: () => Promise<void>
}

declare global {
  var __AXEUH_QA__: AxeuhQaBridge | undefined
}

function resolveHostPort(url: string): HostPort | null {
  try {
    const parsed = new URL(url)
    const fallback = parsed.protocol === 'https:' ? 443 : 80
    const port = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : fallback
    const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '')
    if (host.length === 0) return null
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    return { host, port }
  } catch {
    return null
  }
}

export class AppController {
  private readonly configManager: DesktopConfigManager
  private readonly windows: DesktopWindowManager
  private readonly shutdownHooks = new ShutdownHooks()
  private readonly router: NetworkRouter
  private mainSession: Session | null = null
  private startPromise: Promise<void> | null = null
  private started = false
  private quitting = false
  private networkStatuses: NetworkLayerStatus[] = []
  private networkSyncHook: (() => Promise<void>) | null = null
  private networkSyncError: string | undefined
  private startupDelegate: AppControllerStartupDelegate | null = null
  private readonly failover = new NetworkFailoverTracker()

  constructor() {
    this.configManager = new DesktopConfigManager(
      join(app.getPath('userData'), DESKTOP_CONFIG_FILENAME),
    )
    this.router = new NetworkRouter({
      getNetwork: () => this.configManager.getNetwork(),
      log: {
        info: (message, fields) => logger.info(message, fields),
        warn: (message, fields) => logger.warn(message, fields),
      },
    })
    this.windows = new DesktopWindowManager({
      config: this.configManager,
      mainPartition: MAIN_WINDOW_PARTITION,
      controlPartition: CONTROL_WINDOW_PARTITION,
      preloadPath: join(__dirname, '../preload/preload.js'),
      onMainLoadFailed: (code, message, url) =>
        this.notifyMainLoadFailed(code, message, url),
      onMainReady: () => {
        this.failover.reset()
      },
    })

    if (process.env.AXEUH_QA === '1') {
      globalThis.__AXEUH_QA__ = { controller: this }
    }
  }

  async start(): Promise<void> {
    if (this.startPromise !== null) return this.startPromise
    this.started = true
    this.startPromise = this.bootstrap()
    return this.startPromise
  }

  private async bootstrap(): Promise<void> {
    const bundleRoot = join(app.getAppPath(), 'dist', 'renderer')
    const controlSession = session.fromPartition(CONTROL_WINDOW_PARTITION)
    registerBundleProtocol({
      bundleRoot,
      log: (message) => logger.info(message),
      sessions: [this.getMainSession(), controlSession],
    })

    this.shutdownHooks.register(() => {
      this.windows.saveWindowState()
    })

    const configError = this.configManager.load()

    installMainSessionPolicies({
      session: this.getMainSession(),
      getTrustPolicy: () => this.getTrustPolicy(),
      getAllowedOrigin: () => this.getServerOrigin(),
      getParentWindow: () => this.windows.getMainWindow(),
    })

    if (configError !== null) {
      await this.openControl('error', {
        code: configError.code,
        message: configError.message,
      })
      return
    }

    this.configManager.applyServerUrlOverride(process.env.AXEUH_SERVER_URL ?? '')
    this.applyLoginItemPreference()

    const startRoute = readStartRoute()
    const layers = selectableLayers(this.configManager.getNetwork())
    if (layers.length === 0 && this.getServerUrl().length === 0) {
      await this.openControl(startRoute ?? 'setup')
      return
    }

    if (startRoute === null && layers.length > 0) {
      const outcome = await this.probeNetwork({ reason: 'startup' })
      if (outcome.selectedLayerId === undefined) {
        const failedUrl = `${layers[0].address.replace(/\/+$/, '')}/mobile/`
        await this.windows.notifyMainLoadFailed(
          'UNREACHABLE',
          outcome.error ?? '无法连接服务器：所有网络层均不可用',
          failedUrl,
        )
        return
      }
    }

    if (startRoute === null) {
      const access = (await this.startupDelegate?.awaitSpaAccess?.()) ?? { ok: true }
      if (!access.ok) {
        logger.warn('启动认证未就绪，打开本地设置而不加载远程 SPA', {
          code: access.code ?? '',
          message: access.message ?? '',
        })
        await this.openControl('settings')
        return
      }
    }

    const certificateIssue = startRoute === null ? await this.checkStartupCertificate() : null
    if (certificateIssue !== null) {
      await this.windows.notifyMainLoadFailed(
        certificateIssue.code,
        certificateIssue.message,
        this.mainUrlForErrorPage(),
        this.certificateQuery(
          certificateIssue.host,
          certificateIssue.port,
          certificateIssue.leaf,
          certificateIssue.chainPem,
        ),
      )
    } else {
      this.createMainWindowIfNeeded()
    }

    if (startRoute !== null) {
      await this.openControl(startRoute)
    }
  }

  getConfig(): DesktopConfig {
    return this.configManager.getConfig()
  }

  getServerUrl(): string {
    return this.configManager.getServerUrl()
  }

  getTransport(): TransportConfig {
    return this.configManager.getTransport()
  }

  getNetworkState(): NetworkStateView {
    const network = this.configManager.getNetwork()
    const statuses = network.layers.map(
      (layer) =>
        this.networkStatuses.find(
          (status) =>
            status.id === layer.id &&
            status.address === layer.address &&
            status.tlsMode === layer.tlsMode,
        ) ?? {
          id: layer.id,
          type: layer.type,
          name: layer.name,
          address: layer.address,
          enabled: layer.enabled,
          tlsMode: layer.tlsMode,
          state: 'untested' as const,
        },
    )
    return buildNetworkStateView(network, statuses)
  }

  getNetworkConfig(): NetworkConfig {
    return this.configManager.getNetwork()
  }

  getWindowPreferences(): WindowPreferences {
    return this.configManager.getWindowPreferences()
  }

  saveWindowPreferences(preferences: WindowPreferences): WindowPreferences {
    const saved = this.configManager.saveWindowPreferences(preferences)
    this.applyLoginItemPreference()
    return saved
  }

  applyLoginItemPreference(): void {
    this.configManager.applyLoginItemPreference()
  }

  setStartupDelegate(delegate: AppControllerStartupDelegate): void {
    this.startupDelegate = delegate
  }

  setNetworkSyncHook(hook: () => Promise<void>): void {
    this.networkSyncHook = hook
  }

  async probeNetwork(request: NetworkProbeRequest = {}): Promise<NetworkProbeOutcome> {
    const previous = this.configManager.getActiveLayer()
    const outcome = await this.router.probe(request)
    this.networkStatuses = outcome.statuses

    if (outcome.selectedLayerId !== undefined) {
      this.configManager.setActiveLayer(outcome.selectedLayerId)
      const selected = this.configManager.getActiveLayer()
      if (previous?.id !== selected?.id) {
        logger.info('已选择网络层', {
          reason: request.reason ?? 'probe',
          layer: selected?.name ?? '',
          url: selected?.address ?? '',
        })
      }
      await this.syncActiveNetwork()
      if (request.reloadWindow === true) this.reloadMainForNetworkChange()
    }

    return outcome
  }

  async saveNetworkLayers(network: NetworkConfig): Promise<NetworkApplyResult> {
    const previousActive = this.configManager.getConfig().network.activeLayerId
    const saved = this.configManager.saveNetwork(network)
    this.networkStatuses = untestedStatuses(saved)
    this.networkSyncError = undefined

    if (!saved.layers.some(isSelectableLayer)) {
      return {
        ...this.getNetworkState(),
        sensorSynced: true,
        error: '尚未配置可用的网络层',
        code: 'NO_NETWORK_LAYERS',
      }
    }

    const outcome = await this.probeNetwork({ reason: 'save', reloadWindow: true })
    if (outcome.selectedLayerId === undefined) {
      if (
        previousActive !== undefined &&
        saved.layers.some((layer) => layer.id === previousActive && isSelectableLayer(layer))
      ) {
        this.configManager.setActiveLayer(previousActive)
      }
      return {
        ...this.getNetworkState(),
        sensorSynced: this.networkSyncError === undefined,
        ...(this.networkSyncError !== undefined
          ? { sensorError: this.networkSyncError }
          : {}),
        error: outcome.error ?? '所有网络层均不可用',
        code: outcome.code ?? 'NO_HEALTHY_LAYER',
      }
    }
    return this.getNetworkApplyResult()
  }

  async selectNetworkLayer(layerId: string): Promise<NetworkApplyResult> {
    this.networkSyncError = undefined
    const layer = selectableLayers(this.configManager.getNetwork()).find(
      (entry) => entry.id === layerId,
    )
    if (layer === undefined) {
      return {
        ...this.getNetworkState(),
        sensorSynced: true,
        error: '网络层不存在或不可用',
        code: 'LAYER_UNAVAILABLE',
      }
    }

    const outcome = await this.router.probe({ onlyLayerIds: [layerId] })
    this.networkStatuses = outcome.statuses
    if (outcome.selectedLayerId === undefined) {
      const status = outcome.statuses.find((entry) => entry.id === layerId)
      return {
        ...this.getNetworkState(),
        sensorSynced: true,
        error: status?.error ?? outcome.error ?? '网络层不可用',
        code: status?.code ?? outcome.code ?? 'NO_HEALTHY_LAYER',
      }
    }

    this.configManager.setActiveLayer(layerId)
    await this.syncActiveNetwork()
    this.reloadMainForNetworkChange()
    return this.getNetworkApplyResult()
  }

  private async syncActiveNetwork(): Promise<void> {
    this.networkSyncError = undefined
    if (this.networkSyncHook === null) return
    try {
      await this.networkSyncHook()
    } catch (error) {
      this.networkSyncError = error instanceof Error ? error.message : '未知错误'
      logger.warn('同步 PC 采集端网络配置失败', { error: this.networkSyncError })
    }
  }

  getNetworkApplyResult(): NetworkApplyResult {
    return {
      ...this.getNetworkState(),
      sensorSynced: this.networkSyncError === undefined,
      ...(this.networkSyncError !== undefined
        ? { sensorError: this.networkSyncError }
        : {}),
    }
  }

  private reloadMainForNetworkChange(): void {
    if (this.getServerUrl().length === 0) return
    if (this.windows.getMainWindow() !== null) this.reloadMain()
    else this.createMainWindowIfNeeded()
  }

  applyTransportConfig(transport: TransportConfig): TransportConfig {
    this.configManager.saveTransport(transport)
    logger.info('网络配置已保存', {
      mode: transport.mode,
      endpoints: transport.endpointCandidates.length,
      currentEndpoint: transport.currentEndpoint ?? '',
    })
    return structuredClone(transport)
  }

  getServerOrigin(): string | null {
    return this.configManager.getServerOrigin()
  }

  getTrustPolicy(): TrustPolicy {
    return this.configManager.getTrustPolicy()
  }

  getSensorTlsPolicy(): SensorTlsPolicy {
    return this.configManager.getSensorTlsPolicy()
  }

  async applyServerConfig(
    server: DesktopConfig['server'],
  ): Promise<DesktopConfig['server']> {
    const normalized = this.configManager.normalizeServer(server)
    const saved = this.configManager.saveServer(normalized)
    logger.info('服务器配置已保存', {
      url: saved.url,
      allowUntrustedCa: saved.allowUntrustedCa,
      pinned: saved.tlsPin !== undefined,
    })

    if (saved.url.length === 0) {
      await this.openControl('setup')
      return saved
    }

    const certificateIssue = await this.checkStartupCertificate()
    if (certificateIssue !== null) {
      await this.windows.notifyMainLoadFailed(
        certificateIssue.code,
        certificateIssue.message,
        this.mainUrlForErrorPage(),
        this.certificateQuery(
          certificateIssue.host,
          certificateIssue.port,
          certificateIssue.leaf,
          certificateIssue.chainPem,
        ),
      )
    } else if (this.windows.getMainWindow() !== null) {
      this.reloadMain()
    } else {
      this.createMainWindowIfNeeded()
    }

    return saved
  }

  private mainUrlForErrorPage(): string {
    const base = this.getServerUrl().replace(/\/+$/, '')
    return `${base}/mobile/`
  }

  private certificateQuery(
    host: string,
    port: number,
    leaf: CertInfo,
    chainPem: string,
  ): Record<string, string> {
    return {
      host,
      port: String(port),
      subject: leaf.subject,
      issuer: leaf.issuer,
      validFrom: leaf.validFrom,
      validTo: leaf.validTo,
      fingerprint: leaf.fingerprint256,
      caPem: chainPem,
      selfSigned: String(leaf.selfSigned),
    }
  }

  private async checkStartupCertificate(): Promise<StartupCertificateIssue | null> {
    const serverUrl = this.getServerUrl()
    if (!serverUrl.startsWith('https:')) return null
    if (this.configManager.getActiveLayer()?.tlsMode === 'insecure') return null
    const target = resolveHostPort(serverUrl)
    if (target === null) return null

    let chain
    try {
      chain = await fetchCertificateChain({
        host: target.host,
        port: target.port,
        timeoutMs: CERT_ERROR_TIMEOUT_MS,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误'
      logger.debug('启动前证书预检失败，交由主窗口处理', { error: reason, url: serverUrl })
      return null
    }

    const leaf: CertInfo = { ...chain.leaf, caPem: chain.chainPem }
    const invalid = classifyCertificate(target.host, leaf)
    if (invalid !== null) {
      return {
        code: 'CERT_INVALID',
        message: invalid.message,
        host: target.host,
        port: target.port,
        leaf,
        chainPem: chain.chainPem,
      }
    }

    const policy = this.getTrustPolicy()
    if (
      !trustPolicyAcceptsLeaf(policy, target.host, leaf) &&
      (leaf.selfSigned || policy.pin !== undefined)
    ) {
      return {
        code: 'CERT_UNTRUSTED',
        message: '服务器证书不受系统信任',
        host: target.host,
        port: target.port,
        leaf,
        chainPem: chain.chainPem,
      }
    }

    return null
  }

  async openControl(
    route: ControlRoute,
    query?: Readonly<Record<string, string>>,
  ): Promise<void> {
    await this.windows.openControl(route, query)
  }

  showMain(): void {
    this.windows.showMain()
  }

  reloadMain(): void {
    this.windows.reloadMain()
  }

  async clearMainSession(): Promise<void> {
    await this.clearMainSessionStorage(this.getServerOrigin())
    this.reloadMain()
  }

  async resetAll(): Promise<void> {
    const origin = this.getServerOrigin()
    try {
      await this.clearMainSessionStorage(origin)
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误'
      logger.warn('清理主窗口会话数据失败，继续重置桌面配置', { error: reason })
    }
    try {
      this.configManager.reset()
    } finally {
      this.networkStatuses = []
      this.networkSyncError = undefined
      this.failover.reset()
      this.applyLoginItemPreference()
    }
    await this.openControl('setup')
  }

  private async clearMainSessionStorage(origin: string | null): Promise<void> {
    const options: Electron.ClearStorageDataOptions = {
      storages: ['localstorage', 'cookies', 'cachestorage', 'serviceworkers'],
    }
    if (origin !== null) options.origin = origin

    await this.getMainSession().clearStorageData(options)
  }

  getMainWindow(): BrowserWindow | null {
    return this.windows.getMainWindow()
  }

  getSettingsWebContents(): WebContents | null {
    return this.windows.getSettingsWebContents()
  }

  isSettingsVisible(): boolean {
    return this.windows.isSettingsVisible()
  }

  getMainSession(): Session {
    if (this.mainSession === null) {
      this.mainSession = session.fromPartition(MAIN_WINDOW_PARTITION)
    }
    return this.mainSession
  }

  registerShutdownHook(fn: () => Promise<void> | void): void {
    this.shutdownHooks.register(fn)
  }

  shutdown(): Promise<void> {
    this.quitting = true
    return this.shutdownHooks.run(SHUTDOWN_TIMEOUT_MS)
  }

  saveWindowState(): void {
    this.windows.saveWindowState()
  }

  async notifyMainLoadFailed(code: string, message: string, url: string): Promise<void> {
    if (readStartRoute() !== null) {
      logger.info('主窗口加载失败，保留 AXEUH_START_ROUTE 指定的控制页', { code, url })
      return
    }

    if (await this.tryNetworkFallback()) return

    const target = resolveHostPort(url)
    let extra: Record<string, string> = {}
    if (target !== null) {
      extra = { host: target.host, port: String(target.port) }
    }

    if (code === 'CERT_UNTRUSTED' && target !== null) {
      try {
        const chain = await fetchCertificateChain({
          host: target.host,
          port: target.port,
          timeoutMs: CERT_ERROR_TIMEOUT_MS,
        })
        extra = {
          ...extra,
          ...this.certificateQuery(target.host, target.port, chain.leaf, chain.chainPem),
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : '未知错误'
        logger.warn('获取错误页证书详情失败', { error: reason, url })
      }
    }

    await this.windows.notifyMainLoadFailed(code, message, url, extra)
  }

  private async tryNetworkFallback(): Promise<boolean> {
    const active = this.configManager.getActiveLayer()
    const layers = selectableLayers(this.configManager.getNetwork())
    this.failover.recordFailure(active?.id)
    if (!this.failover.canAttempt(layers.length)) return false

    const outcome = await this.probeNetwork({
      reason: 'fallback',
      excludeLayerIds: this.failover.getExclusions(),
    })
    if (outcome.selectedLayerId === undefined) {
      logger.warn('没有可用的备用网络层', {
        checked: this.failover.getExclusions().length,
      })
      return false
    }

    logger.info('主窗口加载失败，已切换到备用网络层', {
      layer: outcome.selectedLayerId,
      url: this.getServerUrl(),
    })
    this.reloadMain()
    return true
  }

  focus(): void {
    if (!this.started || this.quitting) return
    this.windows.focus()
  }

  isQuitting(): boolean {
    return this.quitting
  }

  getUserDataDir(): string {
    return app.getPath('userData')
  }

  getAppVersion(): string {
    return app.getVersion()
  }

  getVersions(): { electron: string; chrome: string; node: string } {
    return {
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node ?? '',
    }
  }

  quit(): void {
    app.quit()
  }

  createMainWindowIfNeeded(): void {
    this.windows.createMainWindowIfNeeded()
  }
}
