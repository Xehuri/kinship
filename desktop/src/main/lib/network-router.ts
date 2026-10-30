import type {
  NetworkConfig,
  NetworkLayer,
  NetworkLayerStatus,
  NetworkLayerType,
} from '../../shared/types'
import { isSelectableLayer } from '../../shared/network'
import { createTransportAdapters, type TransportAdapter } from './network-transport'

export interface NetworkRouterLogger {
  info(message: string, fields?: Readonly<Record<string, string | number | boolean>>): void
  warn(message: string, fields?: Readonly<Record<string, string | number | boolean>>): void
}

export interface NetworkRouterOptions {
  readonly getNetwork: () => NetworkConfig
  readonly adapters?: Readonly<Record<NetworkLayerType, TransportAdapter>>
  readonly timeoutMs?: number
  readonly now?: () => Date
  readonly log?: NetworkRouterLogger
}

export interface NetworkProbeOptions {
  readonly startAfterLayerId?: string
  readonly excludeLayerIds?: readonly string[]
  readonly onlyLayerIds?: readonly string[]
}

export interface NetworkProbeOutcome {
  readonly statuses: NetworkLayerStatus[]
  readonly selectedLayerId?: string
  readonly error?: string
  readonly code?: string
}

const P2P_UNAVAILABLE_MESSAGE = 'P2P 传输尚未接入，后续统一做'

function baseStatus(layer: NetworkLayer): NetworkLayerStatus {
  const status: NetworkLayerStatus = {
    id: layer.id,
    type: layer.type,
    name: layer.name,
    address: layer.address,
    enabled: layer.enabled,
    tlsMode: layer.tlsMode,
    state: layer.enabled ? 'untested' : 'skipped',
  }
  if (!layer.enabled) status.code = 'DISABLED'
  if (layer.type === 'p2p') {
    status.state = 'skipped'
    status.code = 'P2P_NOT_AVAILABLE'
    status.error = P2P_UNAVAILABLE_MESSAGE
  }
  return status
}

function failureSummary(statuses: readonly NetworkLayerStatus[]): string {
  const failures = statuses.filter((status) => status.state === 'unhealthy')
  if (failures.length === 0) return '所有网络层均不可用'
  const details = failures
    .map((status) => `${status.name}: ${status.error ?? '连接失败'}`)
    .join('；')
  return `无法连接服务器：所有网络层均不可用（${details}）`
}

export class NetworkRouter {
  private readonly adapters: Readonly<Record<NetworkLayerType, TransportAdapter>>
  private readonly now: () => Date
  private readonly log: NetworkRouterLogger | undefined

  constructor(private readonly options: NetworkRouterOptions) {
    this.adapters = options.adapters ?? createTransportAdapters()
    this.now = options.now ?? (() => new Date())
    this.log = options.log
  }

  async probe(options: NetworkProbeOptions = {}): Promise<NetworkProbeOutcome> {
    const network = this.options.getNetwork()
    const statuses = new Map<string, NetworkLayerStatus>()
    for (const layer of network.layers) statuses.set(layer.id, baseStatus(layer))

    let candidates = network.layers.filter(isSelectableLayer)
    if (options.onlyLayerIds !== undefined) {
      const only = new Set(options.onlyLayerIds)
      candidates = candidates.filter((layer) => only.has(layer.id))
    }
    if (options.startAfterLayerId !== undefined) {
      const index = network.layers.findIndex(
        (layer) => layer.id === options.startAfterLayerId,
      )
      const after = new Set(
        network.layers.slice(index + 1).map((layer) => layer.id),
      )
      candidates = candidates.filter((layer) => after.has(layer.id))
    }
    if (options.excludeLayerIds !== undefined) {
      const excluded = new Set(options.excludeLayerIds)
      candidates = candidates.filter((layer) => !excluded.has(layer.id))
    }

    if (candidates.length === 0) {
      const code =
        options.startAfterLayerId !== undefined || options.excludeLayerIds !== undefined
          ? 'NO_FALLBACK_LAYER'
          : 'NO_NETWORK_LAYERS'
      return {
        statuses: network.layers.map((layer) => statuses.get(layer.id) as NetworkLayerStatus),
        error: code === 'NO_FALLBACK_LAYER' ? '没有更多可尝试的网络层' : '尚未配置可用的网络层',
        code,
      }
    }

    let selectedLayerId: string | undefined
    for (const layer of candidates) {
      const status = statuses.get(layer.id) as NetworkLayerStatus
      if (layer.type === 'p2p') {
        status.state = 'skipped'
        status.code = 'P2P_NOT_AVAILABLE'
        status.error = P2P_UNAVAILABLE_MESSAGE
        continue
      }

      const adapter = this.adapters[layer.type]
      const result = await adapter.probe(layer, { timeoutMs: this.options.timeoutMs })
      status.checkedAt = this.now().toISOString()
      status.latencyMs = result.latencyMs
      if (result.ok) {
        status.state = 'healthy'
        selectedLayerId = layer.id
        this.log?.info('网络层健康检查通过', {
          layer: layer.name,
          latencyMs: result.latencyMs,
        })
        break
      }
      status.state = 'unhealthy'
      if (result.error !== undefined) status.error = result.error
      if (result.code !== undefined) status.code = result.code
      this.log?.warn('网络层健康检查失败', {
        layer: layer.name,
        code: result.code ?? '',
        error: result.error ?? '',
      })
    }

    for (const layer of candidates) {
      const status = statuses.get(layer.id) as NetworkLayerStatus
      if (status.state === 'untested') {
        status.state = 'skipped'
        status.code = 'NOT_PROBED'
      }
    }

    const ordered = network.layers.map(
      (layer) => statuses.get(layer.id) as NetworkLayerStatus,
    )
    if (selectedLayerId !== undefined) return { statuses: ordered, selectedLayerId }

    return {
      statuses: ordered,
      error: failureSummary(ordered),
      code: 'NO_HEALTHY_LAYER',
    }
  }
}
