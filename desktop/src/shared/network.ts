import type {
  DesktopConfig,
  EndpointCandidate,
  NetworkConfig,
  NetworkLayer,
  NetworkLayerStatus,
  NetworkLayerTlsMode,
  NetworkStateView,
  TransportConfig,
  WindowPreferences,
} from './types'

export const NETWORK_LAYER_TYPES = ['direct', 'frp', 'p2p'] as const
export const NETWORK_TLS_MODES = ['system', 'pinned', 'insecure'] as const
export const MAX_NETWORK_LAYERS = 16

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/i

export function isValidFingerprint(value: string): boolean {
  return FINGERPRINT_PATTERN.test(value.replace(/[\s:]/g, ''))
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function hostOfAddress(address: string): string {
  try {
    return new URL(address).hostname.replace(/^\[/, '').replace(/\]$/, '')
  } catch {
    return ''
  }
}

export function isSelectableLayer(layer: NetworkLayer): boolean {
  return layer.enabled && layer.type !== 'p2p'
}

export function selectableLayers(network: NetworkConfig): NetworkLayer[] {
  return network.layers.filter(isSelectableLayer)
}

export function activeNetworkLayer(network: NetworkConfig): NetworkLayer | undefined {
  if (network.activeLayerId === undefined) return undefined
  return selectableLayers(network).find((layer) => layer.id === network.activeLayerId)
}

export function buildServerFromNetwork(network: NetworkConfig): DesktopConfig['server'] {
  const layer = activeNetworkLayer(network)
  if (layer === undefined) return { url: '', allowUntrustedCa: false }

  const server: DesktopConfig['server'] = {
    url: layer.address,
    allowUntrustedCa: layer.tlsMode === 'pinned',
  }
  if (layer.tlsMode === 'pinned' && layer.fingerprint256 !== undefined) {
    const pin: NonNullable<DesktopConfig['server']['tlsPin']> = {
      host: hostOfAddress(layer.address),
      fingerprint256: layer.fingerprint256,
    }
    if (layer.caPemPath !== undefined) pin.caPemPath = layer.caPemPath
    server.tlsPin = pin
  }
  return server
}

export function buildTransportFromNetwork(network: NetworkConfig): TransportConfig {
  const layers = selectableLayers(network)
  const singleLegacyServer = layers.length === 1 && layers[0]?.id === 'server-direct'
  const candidates: EndpointCandidate[] = singleLegacyServer
    ? []
    : layers.map((layer, index) => ({
        name: layer.name,
        url: layer.address,
        priority: index + 1,
      }))
  const active = activeNetworkLayer(network)
  const transport: TransportConfig = {
    mode: active?.type === 'frp' ? 'frp' : 'auto',
    endpointCandidates: candidates,
  }
  if (active !== undefined && candidates.length > 0) transport.currentEndpoint = active.name
  return transport
}

export function applyNetworkToConfig(config: DesktopConfig): DesktopConfig {
  return {
    ...config,
    server: buildServerFromNetwork(config.network),
    transport: buildTransportFromNetwork(config.network),
  }
}

export function buildNetworkStateView(
  network: NetworkConfig,
  statuses: readonly NetworkLayerStatus[],
): NetworkStateView {
  const active = activeNetworkLayer(network)
  const view: NetworkStateView = {
    config: structuredClone(network),
    statuses: statuses.map((status) => ({ ...status })),
  }
  if (active !== undefined) {
    view.activeLayerId = active.id
    view.activeAddress = active.address
    view.activeTlsMode = active.tlsMode
  }
  return view
}

export function untestedStatuses(network: NetworkConfig): NetworkLayerStatus[] {
  return network.layers.map((layer) => ({
    id: layer.id,
    type: layer.type,
    name: layer.name,
    address: layer.address,
    enabled: layer.enabled,
    tlsMode: layer.tlsMode,
    state: 'untested' as const,
  }))
}

export function windowPreferencesOf(config: DesktopConfig): WindowPreferences {
  return {
    minimizeToTray: config.window.minimizeToTray,
    openAtLogin: config.window.openAtLogin,
  }
}

function uniqueValue(base: string, seen: Set<string>): string {
  if (!seen.has(base)) {
    seen.add(base)
    return base
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${String(index)}`
    if (!seen.has(candidate)) {
      seen.add(candidate)
      return candidate
    }
  }
}

function tlsFieldsForServer(server: DesktopConfig['server']): {
  tlsMode: NetworkLayerTlsMode
  fingerprint256?: string
  caPemPath?: string
} {
  if (
    server.tlsPin !== undefined &&
    server.allowUntrustedCa &&
    isValidFingerprint(server.tlsPin.fingerprint256)
  ) {
    return {
      tlsMode: 'pinned',
      fingerprint256: server.tlsPin.fingerprint256,
      ...(server.tlsPin.caPemPath !== undefined ? { caPemPath: server.tlsPin.caPemPath } : {}),
    }
  }
  return { tlsMode: 'system' }
}

export function networkWithServer(
  network: NetworkConfig,
  server: DesktopConfig['server'],
): NetworkConfig {
  const url = server.url.trim()
  if (url.length === 0) return { layers: [] }

  const layers = network.layers.map((layer) => ({ ...layer }))
  const active = layers.find(
    (layer) => layer.id === network.activeLayerId && isSelectableLayer(layer),
  )
  const target = active ?? layers.find((layer) => layer.address === url)
  const tls = tlsFieldsForServer(server)

  if (target !== undefined) {
    target.address = url
    target.tlsMode = tls.tlsMode
    delete target.fingerprint256
    delete target.caPemPath
    if (tls.fingerprint256 !== undefined) target.fingerprint256 = tls.fingerprint256
    if (tls.caPemPath !== undefined) target.caPemPath = tls.caPemPath
    return { layers, activeLayerId: target.id }
  }

  const seenIds = new Set(layers.map((layer) => layer.id))
  const seenNames = new Set(layers.map((layer) => layer.name))
  const id = uniqueValue('server-direct', seenIds)
  const name = uniqueValue(hostOfAddress(url) || '直连', seenNames)
  const layer: NetworkLayer = {
    id,
    type: 'direct',
    name,
    address: url,
    enabled: true,
    ...tls,
  }
  layers.unshift(layer)
  return { layers, activeLayerId: id }
}

export function networkWithTransport(
  network: NetworkConfig,
  transport: TransportConfig,
  fallbackServer: DesktopConfig['server'],
): NetworkConfig {
  if (transport.endpointCandidates.length === 0) {
    return networkWithServer({ layers: [] }, fallbackServer)
  }

  const existingByAddress = new Map(network.layers.map((layer) => [layer.address, layer]))
  const seenIds = new Set<string>()
  const layers: NetworkLayer[] = transport.endpointCandidates.map((candidate, index) => {
    const existing = existingByAddress.get(candidate.url)
    if (existing !== undefined) {
      seenIds.add(existing.id)
      return {
        ...existing,
        name: candidate.name,
        enabled: true,
      }
    }
    const id = uniqueValue(`layer-${String(index + 1)}`, seenIds)
    return {
      id,
      type: transport.mode === 'frp' ? 'frp' : 'direct',
      name: candidate.name,
      address: candidate.url,
      enabled: true,
      tlsMode: 'system',
    }
  })

  const active = layers.find((layer) => layer.name === transport.currentEndpoint)
  const selected = active ?? layers.find(isSelectableLayer)
  return selected === undefined ? { layers } : { layers, activeLayerId: selected.id }
}
