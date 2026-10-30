import { rmSync } from 'node:fs'
import type {
  DesktopConfig,
  NetworkConfig,
  NetworkLayer,
  NetworkLayerStatus,
  NetworkStateView,
  TransportConfig,
  WindowPreferences,
} from '../shared/types'
import {
  activeNetworkLayer,
  buildNetworkStateView,
  hostOfAddress,
  networkWithServer,
  networkWithTransport,
  untestedStatuses,
  windowPreferencesOf,
} from '../shared/network'
import {
  ConfigStoreError,
  DEFAULT_CONFIG,
  createConfigStore,
  type ConfigStore,
} from './lib/config-store'
import { applyLoginItemSetting } from './lib/login-item'
import { logger } from './lib/logger'
import type { SensorTlsPolicy } from './lib/sensor-config'
import type { TrustPolicy } from './lib/tls'
import { UrlValidationError, normalizeServerUrl } from './lib/url'
import type { WindowBounds } from './lib/window-state'
import { originOf } from './shell/navigation'

export class DesktopConfigManager {
  private readonly store: ConfigStore
  private config: DesktopConfig = structuredClone(DEFAULT_CONFIG)

  constructor(readonly path: string) {
    this.store = createConfigStore(path)
  }

  load(): ConfigStoreError | null {
    try {
      this.config = this.store.load()
      return null
    } catch (error) {
      if (!(error instanceof ConfigStoreError)) throw error
      logger.error('桌面配置加载失败', { code: error.code, error: error.message })
      return error
    }
  }

  reset(): void {
    let failure: unknown
    for (const target of [this.path, `${this.path}.bak`]) {
      try {
        rmSync(target, { force: true })
      } catch (error) {
        failure ??= error
      }
    }
    this.config = structuredClone(DEFAULT_CONFIG)
    if (failure !== undefined) throw failure
  }

  getConfig(): DesktopConfig {
    return structuredClone(this.config)
  }

  getServerUrl(): string {
    return this.config.server.url
  }

  getTransport(): TransportConfig {
    return structuredClone(this.config.transport)
  }

  getNetwork(): NetworkConfig {
    return structuredClone(this.config.network)
  }

  getActiveLayer(): NetworkLayer | undefined {
    return activeNetworkLayer(this.config.network)
  }

  getNetworkStateView(statuses?: readonly NetworkLayerStatus[]): NetworkStateView {
    return buildNetworkStateView(
      this.config.network,
      statuses ?? untestedStatuses(this.config.network),
    )
  }

  getServerOrigin(): string | null {
    return originOf(this.config.server.url)
  }

  getBounds(): DesktopConfig['window']['bounds'] | undefined {
    return this.config.window.bounds
  }

  getLastHash(): string | undefined {
    return this.config.window.lastHash
  }

  getWindowPreferences(): WindowPreferences {
    return windowPreferencesOf(this.config)
  }

  getTrustPolicy(): TrustPolicy {
    const layer = this.getActiveLayer()
    if (layer === undefined) return { host: '', allowUntrustedCa: false }

    const host = hostOfAddress(layer.address)
    if (layer.tlsMode === 'insecure') {
      return { host, allowUntrustedCa: false, insecure: true }
    }
    if (layer.tlsMode === 'pinned' && layer.fingerprint256 !== undefined) {
      return {
        host,
        allowUntrustedCa: true,
        pin: { host, fingerprint256: layer.fingerprint256 },
      }
    }
    return { host, allowUntrustedCa: false }
  }

  getSensorTlsPolicy(): SensorTlsPolicy {
    const layer = this.getActiveLayer()
    if (layer === undefined) return { mode: 'system' }
    return {
      mode: layer.tlsMode,
      ...(layer.caPemPath !== undefined ? { caPemPath: layer.caPemPath } : {}),
    }
  }

  normalizeServer(server: DesktopConfig['server']): DesktopConfig['server'] {
    return {
      ...server,
      url: server.url.trim().length > 0 ? normalizeServerUrl(server.url) : '',
    }
  }

  saveServer(server: DesktopConfig['server']): DesktopConfig['server'] {
    const empty = server.url.trim().length === 0
    const next: DesktopConfig = {
      ...this.config,
      server,
      network: empty ? { layers: [] } : networkWithServer(this.config.network, server),
      ...(empty
        ? { transport: { mode: 'auto' as const, endpointCandidates: [] } }
        : {}),
    }
    this.config = this.store.save(next)
    return structuredClone(this.config.server)
  }

  saveTransport(transport: TransportConfig): TransportConfig {
    const next: DesktopConfig = {
      ...this.config,
      network: networkWithTransport(this.config.network, transport, this.config.server),
    }
    this.config = this.store.save(next)
    return structuredClone(this.config.transport)
  }

  saveNetwork(network: NetworkConfig): NetworkConfig {
    const next: DesktopConfig =
      network.layers.length === 0
        ? {
            ...this.config,
            network,
            server: { url: '', allowUntrustedCa: false },
            transport: { mode: 'auto', endpointCandidates: [] },
          }
        : { ...this.config, network }
    this.config = this.store.save(next)
    return structuredClone(this.config.network)
  }

  setActiveLayer(layerId: string | undefined): NetworkConfig {
    const network = this.getNetwork()
    if (layerId === undefined) delete network.activeLayerId
    else network.activeLayerId = layerId
    return this.saveNetwork(network)
  }

  saveWindowPreferences(preferences: WindowPreferences): WindowPreferences {
    this.config = this.store.save({
      ...this.config,
      window: {
        ...this.config.window,
        minimizeToTray: preferences.minimizeToTray,
        openAtLogin: preferences.openAtLogin,
      },
    })
    return windowPreferencesOf(this.config)
  }

  applyLoginItemPreference(): void {
    const result = applyLoginItemSetting(this.config.window.openAtLogin)
    if (result.error !== undefined) {
      logger.warn('应用开机自启动设置失败', { error: result.error })
    }
  }

  applyServerUrlOverride(raw: string): void {
    if (this.config.server.url.length > 0 || this.config.network.layers.length > 0) return
    const trimmed = raw.trim()
    if (trimmed.length === 0) return

    try {
      const url = normalizeServerUrl(trimmed)
      this.saveServer({ ...this.config.server, url })
      logger.info('已应用 AXEUH_SERVER_URL', { url })
    } catch (error) {
      if (error instanceof UrlValidationError) {
        logger.warn('AXEUH_SERVER_URL 无效', { code: error.code })
        return
      }
      throw error
    }
  }

  saveBounds(bounds: WindowBounds): void {
    this.config = {
      ...this.config,
      window: { ...this.config.window, bounds },
    }
    this.persist('保存窗口位置失败')
  }

  saveLastHash(hash: string): void {
    this.config = {
      ...this.config,
      window: { ...this.config.window, lastHash: hash },
    }
    this.persist('保存窗口导航状态失败')
  }

  private persist(failureMessage: string): void {
    try {
      this.config = this.store.save(this.config)
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error'
      logger.error(failureMessage, { error: reason })
    }
  }
}
