import type {
  DesktopConfig,
  NetworkConfig,
  NetworkLayer,
  TransportConfig,
} from '../../shared/types'
import {
  applyNetworkToConfig,
  hostOfAddress,
  isSelectableLayer,
  isValidFingerprint,
  networkWithServer,
  networkWithTransport,
} from '../../shared/network'
import { validateNetworkConfig, validateTransportConfig } from '../../shared/validation'
import { FileMissingError, JsonParseError, readJsonFile, writeJsonAtomic } from './atomic-json'
import { UrlValidationError, normalizeServerUrl } from './url'

export type ConfigErrorCode = 'CONFIG_CORRUPT' | 'CONFIG_UNSUPPORTED' | 'CONFIG_INVALID'

export class ConfigStoreError extends Error {
  readonly code: ConfigErrorCode
  readonly path: string

  constructor(code: ConfigErrorCode, path: string, message: string) {
    super(message)
    this.name = 'ConfigStoreError'
    this.code = code
    this.path = path
  }
}

export class ConfigCorruptError extends ConfigStoreError {
  constructor(path: string, reason: string) {
    super('CONFIG_CORRUPT', path, `配置文件损坏：${reason}`)
    this.name = 'ConfigCorruptError'
  }
}

export class ConfigUnsupportedError extends ConfigStoreError {
  constructor(path: string, schemaVersion: unknown) {
    super('CONFIG_UNSUPPORTED', path, `不支持的配置版本：${String(schemaVersion)}`)
    this.name = 'ConfigUnsupportedError'
  }
}

export class ConfigInvalidError extends ConfigStoreError {
  constructor(path: string, reason: string) {
    super('CONFIG_INVALID', path, `配置内容无效：${reason}`)
    this.name = 'ConfigInvalidError'
  }
}

export const DEFAULT_TRANSPORT_CONFIG: TransportConfig = {
  mode: 'auto',
  endpointCandidates: [],
}

export const DEFAULT_NETWORK_CONFIG: NetworkConfig = {
  layers: [],
}

export const DEFAULT_CONFIG: DesktopConfig = {
  schemaVersion: 3,
  server: {
    url: '',
    allowUntrustedCa: false,
  },
  transport: {
    mode: 'auto',
    endpointCandidates: [],
  },
  network: {
    layers: [],
  },
  window: {
    minimizeToTray: true,
    openAtLogin: false,
  },
}

export interface ConfigPatch {
  readonly server?: Partial<DesktopConfig['server']>
  readonly transport?: Partial<TransportConfig>
  readonly network?: NetworkConfig
  readonly window?: Partial<DesktopConfig['window']>
}

export interface ConfigStore {
  readonly path: string
  load(): DesktopConfig
  save(config: DesktopConfig): DesktopConfig
  update(patch: ConfigPatch): DesktopConfig
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizeTlsPin(
  value: unknown,
): NonNullable<DesktopConfig['server']['tlsPin']> | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.host !== 'string' || typeof value.fingerprint256 !== 'string') return undefined

  const pin: NonNullable<DesktopConfig['server']['tlsPin']> = {
    host: value.host,
    fingerprint256: value.fingerprint256,
  }
  if (typeof value.caPemPath === 'string') pin.caPemPath = value.caPemPath
  return pin
}

function normalizeServer(value: unknown, configPath: string): DesktopConfig['server'] {
  if (value === undefined) return { url: '', allowUntrustedCa: false }
  if (!isRecord(value)) throw new ConfigInvalidError(configPath, 'server 字段格式不正确')

  const rawUrl = value.url
  if (rawUrl !== undefined && typeof rawUrl !== 'string') {
    throw new ConfigInvalidError(configPath, 'server.url 字段格式不正确')
  }

  const allowUntrustedCa = value.allowUntrustedCa
  if (allowUntrustedCa !== undefined && typeof allowUntrustedCa !== 'boolean') {
    throw new ConfigInvalidError(configPath, 'server.allowUntrustedCa 字段格式不正确')
  }

  let url = ''
  if (typeof rawUrl === 'string' && rawUrl.trim().length > 0) {
    try {
      url = normalizeServerUrl(rawUrl)
    } catch (error) {
      if (error instanceof UrlValidationError) {
        throw new ConfigInvalidError(configPath, error.message)
      }
      throw error
    }
  }

  const server: DesktopConfig['server'] = { url, allowUntrustedCa: allowUntrustedCa === true }
  const tlsPin = normalizeTlsPin(value.tlsPin)
  if (tlsPin !== undefined) server.tlsPin = tlsPin
  return server
}

function normalizeBounds(value: unknown): DesktopConfig['window']['bounds'] | undefined {
  if (!isRecord(value) || !isFiniteNumber(value.width) || !isFiniteNumber(value.height)) {
    return undefined
  }

  const bounds: NonNullable<DesktopConfig['window']['bounds']> = {
    width: value.width,
    height: value.height,
  }
  if (isFiniteNumber(value.x)) bounds.x = value.x
  if (isFiniteNumber(value.y)) bounds.y = value.y
  return bounds
}

function normalizeWindow(value: unknown, configPath: string): DesktopConfig['window'] {
  if (value === undefined) return { minimizeToTray: true, openAtLogin: false }
  if (!isRecord(value)) throw new ConfigInvalidError(configPath, 'window 字段格式不正确')

  const window: DesktopConfig['window'] = {
    minimizeToTray: typeof value.minimizeToTray === 'boolean' ? value.minimizeToTray : true,
    openAtLogin: typeof value.openAtLogin === 'boolean' ? value.openAtLogin : false,
  }
  if (typeof value.lastHash === 'string' && value.lastHash.length > 0) {
    window.lastHash = value.lastHash
  }
  const bounds = normalizeBounds(value.bounds)
  if (bounds !== undefined) window.bounds = bounds
  return window
}

function normalizeTransport(value: unknown, configPath: string): TransportConfig {
  if (value === undefined) return structuredClone(DEFAULT_TRANSPORT_CONFIG)
  const result = validateTransportConfig(value)
  if (!result.ok) throw new ConfigInvalidError(configPath, result.message)
  return result.transport
}

function legacyLayerTls(
  server: DesktopConfig['server'],
  address: string,
): Pick<NetworkLayer, 'tlsMode' | 'fingerprint256' | 'caPemPath'> {
  const pin = server.tlsPin
  if (pin === undefined || !server.allowUntrustedCa) return { tlsMode: 'system' }
  if (!isValidFingerprint(pin.fingerprint256)) return { tlsMode: 'system' }
  if (pin.host.toLowerCase() !== hostOfAddress(address).toLowerCase()) return { tlsMode: 'system' }
  return {
    tlsMode: 'pinned',
    fingerprint256: pin.fingerprint256,
    ...(pin.caPemPath !== undefined ? { caPemPath: pin.caPemPath } : {}),
  }
}

function uniqueName(base: string, seen: Set<string>): string {
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

function migrateLegacyNetwork(
  server: DesktopConfig['server'],
  transport: TransportConfig,
): NetworkConfig {
  const layers: NetworkLayer[] = []
  const seenNames = new Set<string>()
  const seenIds = new Set<string>()
  const candidateType = transport.mode === 'frp' ? 'frp' : 'direct'

  for (const [index, candidate] of transport.endpointCandidates.entries()) {
    const id = `layer-${String(index + 1)}`
    if (seenIds.has(id)) continue
    seenIds.add(id)
    layers.push({
      id,
      type: candidateType,
      name: uniqueName(candidate.name, seenNames),
      address: candidate.url,
      enabled: true,
      ...legacyLayerTls(server, candidate.url),
    })
  }

  let activeName = transport.currentEndpoint
  if (server.url.length > 0) {
    const existing = layers.find((layer) => layer.address === server.url)
    if (existing === undefined) {
      const name = uniqueName('直连', seenNames)
      layers.unshift({
        id: 'server-direct',
        type: candidateType,
        name,
        address: server.url,
        enabled: true,
        ...legacyLayerTls(server, server.url),
      })
      if (activeName === undefined) activeName = name
    } else if (activeName === undefined) {
      activeName = existing.name
    }
  }

  const active =
    layers.find((layer) => layer.name === activeName && isSelectableLayer(layer)) ??
    layers.find(isSelectableLayer)
  const network: NetworkConfig = { layers }
  if (active !== undefined) network.activeLayerId = active.id
  return network
}

function normalizeNetwork(
  value: unknown,
  configPath: string,
  server: DesktopConfig['server'],
  transport: TransportConfig,
): NetworkConfig {
  if (value === undefined) return migrateLegacyNetwork(server, transport)

  const result = validateNetworkConfig(value, { allowP2P: true })
  if (!result.ok) throw new ConfigInvalidError(configPath, result.message)
  if (result.network.layers.length === 0) {
    return server.url.length > 0 || transport.endpointCandidates.length > 0
      ? migrateLegacyNetwork(server, transport)
      : result.network
  }

  if (result.network.activeLayerId === undefined) {
    const match = result.network.layers.find(
      (layer) => isSelectableLayer(layer) && layer.address === server.url,
    )
    if (match !== undefined) return { ...result.network, activeLayerId: match.id }
  }
  return result.network
}

function normalizeConfig(value: unknown, configPath: string): DesktopConfig {
  if (!isRecord(value)) {
    throw new ConfigCorruptError(configPath, '根节点不是对象')
  }
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3) {
    throw new ConfigUnsupportedError(configPath, value.schemaVersion)
  }

  const server = normalizeServer(value.server, configPath)
  const transport = normalizeTransport(value.transport, configPath)
  const network = normalizeNetwork(value.network, configPath, server, transport)
  const base: DesktopConfig = {
    schemaVersion: 3,
    server,
    transport,
    network,
    window: normalizeWindow(value.window, configPath),
  }
  return applyNetworkToConfig(base)
}

export function createConfigStore(configPath: string): ConfigStore {
  const load = (): DesktopConfig => {
    let raw: unknown
    try {
      raw = readJsonFile<unknown>(configPath)
    } catch (error) {
      if (error instanceof FileMissingError) return structuredClone(DEFAULT_CONFIG)
      if (error instanceof JsonParseError) throw new ConfigCorruptError(configPath, error.message)
      throw error
    }

    const normalized = normalizeConfig(raw, configPath)
    if (isRecord(raw) && raw.schemaVersion !== 3) {
      try {
        writeJsonAtomic(configPath, normalized, { backup: true })
      } catch {
        // Migration write-back is best effort; the next save retries it.
      }
    }
    return normalized
  }

  const persist = (config: DesktopConfig): DesktopConfig => {
    const normalized = normalizeConfig(config, configPath)
    writeJsonAtomic(configPath, normalized, { backup: true })
    return normalized
  }

  return {
    path: configPath,
    load,
    save(config): DesktopConfig {
      return persist(config)
    },
    update(patch): DesktopConfig {
      const current = load()
      let network = patch.network ?? current.network
      if (patch.network === undefined && patch.server !== undefined) {
        network = networkWithServer(network, { ...current.server, ...patch.server })
      }
      if (patch.network === undefined && patch.transport !== undefined) {
        network = networkWithTransport(
          network,
          { ...current.transport, ...patch.transport },
          current.server,
        )
      }
      return persist({
        schemaVersion: 3,
        server: { ...current.server, ...patch.server },
        transport: { ...current.transport, ...patch.transport },
        network,
        window: { ...current.window, ...patch.window },
      })
    },
  }
}
