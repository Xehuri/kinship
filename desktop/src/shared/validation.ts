import { UrlValidationError, isLoopbackHost, normalizeServerUrl } from '../main/lib/url'
import type { UrlErrorCode } from '../main/lib/url'
import { DEFAULT_SENSOR_PORT } from './constants'
import { MAX_NETWORK_LAYERS, NETWORK_LAYER_TYPES, NETWORK_TLS_MODES } from './network'
import type {
  EndpointCandidate,
  NetworkConfig,
  NetworkLayer,
  NetworkLayerTlsMode,
  NetworkLayerType,
  SensorConfigPatch,
  TransportConfig,
  TransportMode,
  WindowPreferences,
} from './types'

const HTTP_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:'])
const TRANSPORT_MODES: ReadonlySet<string> = new Set(['auto', 'frp'])
const LAYER_TYPES: ReadonlySet<string> = new Set(NETWORK_LAYER_TYPES)
const TLS_MODES: ReadonlySet<string> = new Set(NETWORK_TLS_MODES)
const MAX_ENDPOINT_NAME_LENGTH = 64
const MAX_NETWORK_LAYER_NAME_LENGTH = 64
const MAX_NETWORK_LAYER_ID_LENGTH = 64
const MAX_ENDPOINT_PRIORITY = 10000
const DEFAULT_ENDPOINT_PRIORITY = 50
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/

const SERVER_URL_MESSAGES: Readonly<Record<UrlErrorCode, string>> = {
  EMPTY_URL: '请输入服务器地址',
  UNSUPPORTED_SCHEME: '仅支持 http:// 或 https:// 地址',
  URL_HAS_CREDENTIALS: '服务器地址不能包含用户名或密码',
  URL_HAS_PATH: '服务器地址只能包含协议、主机和端口，不能带路径',
  INVALID_HOST: '服务器地址格式不正确',
  URL_INVALID: '服务器地址格式不正确',
}

export type ServerUrlValidationResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly code: UrlErrorCode; readonly message: string }

export type SensorConfigValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string }

export type TransportValidationResult =
  | { readonly ok: true; readonly transport: TransportConfig }
  | { readonly ok: false; readonly message: string }

export function validateServerUrlInput(input: string): ServerUrlValidationResult {
  try {
    return { ok: true, url: normalizeServerUrl(input) }
  } catch (error) {
    if (error instanceof UrlValidationError) {
      return { ok: false, code: error.code, message: SERVER_URL_MESSAGES[error.code] }
    }
    throw error
  }
}

function readTransportMode(value: unknown): TransportMode | null {
  if (value === undefined) return 'auto'
  return typeof value === 'string' && TRANSPORT_MODES.has(value)
    ? (value as TransportMode)
    : null
}

function readCandidatePriority(value: unknown, label: string): number | string {
  if (value === undefined) return DEFAULT_ENDPOINT_PRIORITY
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return `端点 ${label} 的优先级必须是整数`
  }
  if (value < 0 || value > MAX_ENDPOINT_PRIORITY) {
    return `端点 ${label} 的优先级需在 0-${String(MAX_ENDPOINT_PRIORITY)} 之间`
  }
  return value
}

function normalizeCandidate(
  value: unknown,
  index: number,
  seenNames: Set<string>,
): EndpointCandidate | string {
  if (!isRecord(value)) return `第 ${String(index + 1)} 个端点格式不正确`

  const rawName = value.name
  const name = typeof rawName === 'string' ? rawName.trim() : ''
  if (name.length === 0 || name.length > MAX_ENDPOINT_NAME_LENGTH) {
    return `第 ${String(index + 1)} 个端点的名称需为 1-${String(MAX_ENDPOINT_NAME_LENGTH)} 个字符`
  }
  if (seenNames.has(name)) return `端点名称重复：${name}`

  const rawUrl = value.url
  const urlInput = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  if (urlInput.length === 0) return `端点 ${name} 的地址为空`
  const validation = validateServerUrlInput(urlInput)
  if (!validation.ok) return `端点 ${name}：${validation.message}`
  if (validation.url.startsWith('http:')) {
    const host = new URL(validation.url).hostname
    if (!isLoopbackHost(host)) return `端点 ${name} 必须使用 https（仅 localhost 允许 http）`
  }

  const priority = readCandidatePriority(value.priority, name)
  if (typeof priority === 'string') return priority

  seenNames.add(name)
  return { name, url: validation.url, priority }
}

export function validateTransportConfig(value: unknown): TransportValidationResult {
  if (!isRecord(value)) return { ok: false, message: '网络配置格式不正确' }

  const mode = readTransportMode(value.mode)
  if (mode === null) return { ok: false, message: '传输模式只能是 auto 或 frp' }

  const rawCandidates = value.endpointCandidates
  if (rawCandidates !== undefined && !Array.isArray(rawCandidates)) {
    return { ok: false, message: '端点候选必须是数组' }
  }

  const candidates: EndpointCandidate[] = []
  const seenNames = new Set<string>()
  for (const [index, item] of (rawCandidates ?? []).entries()) {
    const candidate = normalizeCandidate(item, index, seenNames)
    if (typeof candidate === 'string') return { ok: false, message: candidate }
    candidates.push(candidate)
  }

  const rawCurrent = value.currentEndpoint
  if (rawCurrent !== undefined && rawCurrent !== null && typeof rawCurrent !== 'string') {
    return { ok: false, message: '当前端点格式不正确' }
  }
  const currentName = typeof rawCurrent === 'string' ? rawCurrent.trim() : ''
  if (currentName.length > 0 && seenNames.has(currentName)) {
    return {
      ok: true,
      transport: { mode, endpointCandidates: candidates, currentEndpoint: currentName },
    }
  }
  return { ok: true, transport: { mode, endpointCandidates: candidates } }
}

export function resolveTransportServerUrl(
  transport: TransportConfig,
  fallbackUrl: string,
): string {
  const selected = transport.currentEndpoint
  if (selected !== undefined) {
    const candidate = transport.endpointCandidates.find((entry) => entry.name === selected)
    if (candidate !== undefined) return candidate.url
  }
  return fallbackUrl.trim()
}

export type NetworkValidationCode =
  | 'P2P_NOT_AVAILABLE'
  | 'INVALID_NETWORK'
  | 'INVALID_LAYER'

export type NetworkValidationResult =
  | { readonly ok: true; readonly network: NetworkConfig }
  | { readonly ok: false; readonly code: NetworkValidationCode; readonly message: string }

export interface NetworkValidationOptions {
  readonly allowP2P?: boolean
}

function normalizeSharedFingerprint(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.replace(/[\s:]/g, '').toLowerCase()
  return FINGERPRINT_PATTERN.test(normalized) ? normalized : ''
}

function readLayerType(value: unknown): NetworkLayerType | null {
  return typeof value === 'string' && LAYER_TYPES.has(value)
    ? (value as NetworkLayerType)
    : null
}

function readTlsMode(value: unknown): NetworkLayerTlsMode | null {
  if (value === undefined) return 'system'
  return typeof value === 'string' && TLS_MODES.has(value)
    ? (value as NetworkLayerTlsMode)
    : null
}

function invalidLayer(message: string): NetworkValidationResult {
  return { ok: false, code: 'INVALID_LAYER', message }
}

function normalizeNetworkLayer(
  value: unknown,
  index: number,
  options: NetworkValidationOptions,
): NetworkLayer | NetworkValidationResult {
  if (!isRecord(value)) return invalidLayer(`第 ${String(index + 1)} 个网络层格式不正确`)

  const rawId = typeof value['id'] === 'string' ? value['id'].trim() : ''
  if (rawId.length === 0 || rawId.length > MAX_NETWORK_LAYER_ID_LENGTH) {
    return invalidLayer(`第 ${String(index + 1)} 个网络层的 ID 需为 1-64 个字符`)
  }

  const type = readLayerType(value['type'])
  if (type === null) return invalidLayer(`网络层 ${rawId} 的类型必须是 direct、frp 或 p2p`)
  if (type === 'p2p' && options.allowP2P !== true) {
    return {
      ok: false,
      code: 'P2P_NOT_AVAILABLE',
      message: 'P2P 传输尚未接入，后续统一做',
    }
  }

  const rawName = typeof value['name'] === 'string' ? value['name'].trim() : ''
  if (rawName.length === 0 || rawName.length > MAX_NETWORK_LAYER_NAME_LENGTH) {
    return invalidLayer(`网络层 ${rawId} 的名称需为 1-64 个字符`)
  }

  const rawAddress = typeof value['address'] === 'string' ? value['address'].trim() : ''
  if (rawAddress.length === 0) return invalidLayer(`网络层 ${rawName} 的地址为空`)
  const addressValidation = validateServerUrlInput(rawAddress)
  if (!addressValidation.ok) {
    return invalidLayer(`网络层 ${rawName}：${addressValidation.message}`)
  }
  if (addressValidation.url.startsWith('http:')) {
    const host = new URL(addressValidation.url).hostname
    if (!isLoopbackHost(host)) {
      return invalidLayer(`网络层 ${rawName} 必须使用 https（仅 localhost 允许 http）`)
    }
  }

  const rawEnabled = value['enabled']
  if (rawEnabled !== undefined && typeof rawEnabled !== 'boolean') {
    return invalidLayer(`网络层 ${rawName} 的启用状态必须是布尔值`)
  }
  const enabled = type === 'p2p' ? false : (rawEnabled ?? true)

  const tlsMode = readTlsMode(value['tlsMode'])
  if (tlsMode === null) {
    return invalidLayer(`网络层 ${rawName} 的 TLS 模式必须是 system、pinned 或 insecure`)
  }

  const layer: NetworkLayer = {
    id: rawId,
    type,
    name: rawName,
    address: addressValidation.url,
    enabled,
    tlsMode,
  }

  if (tlsMode === 'pinned') {
    const fingerprint = normalizeSharedFingerprint(value['fingerprint256'])
    if (fingerprint.length === 0) {
      return invalidLayer(`网络层 ${rawName} 使用固定证书时必须提供 SHA-256 指纹`)
    }
    layer.fingerprint256 = fingerprint
    if (typeof value['caPemPath'] === 'string' && value['caPemPath'].trim().length > 0) {
      layer.caPemPath = value['caPemPath'].trim()
    }
  }

  return layer
}

export function validateNetworkConfig(
  value: unknown,
  options: NetworkValidationOptions = {},
): NetworkValidationResult {
  if (!isRecord(value)) {
    return { ok: false, code: 'INVALID_NETWORK', message: '网络配置格式不正确' }
  }

  const rawLayers = value['layers']
  if (!Array.isArray(rawLayers)) {
    return { ok: false, code: 'INVALID_NETWORK', message: '网络层列表必须是数组' }
  }
  if (rawLayers.length > MAX_NETWORK_LAYERS) {
    return {
      ok: false,
      code: 'INVALID_NETWORK',
      message: `网络层最多 ${String(MAX_NETWORK_LAYERS)} 个`,
    }
  }

  const layers: NetworkLayer[] = []
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()
  for (const [index, item] of rawLayers.entries()) {
    const layer = normalizeNetworkLayer(item, index, options)
    if (!('ok' in layer)) {
      if (seenIds.has(layer.id)) {
        return invalidLayer(`网络层 ID 重复：${layer.id}`)
      }
      if (seenNames.has(layer.name)) {
        return invalidLayer(`网络层名称重复：${layer.name}`)
      }
      seenIds.add(layer.id)
      seenNames.add(layer.name)
      layers.push(layer)
      continue
    }
    return layer
  }

  const rawActive = value['activeLayerId']
  if (rawActive !== undefined && rawActive !== null && typeof rawActive !== 'string') {
    return { ok: false, code: 'INVALID_NETWORK', message: '当前网络层格式不正确' }
  }

  const network: NetworkConfig = { layers }
  const activeId = typeof rawActive === 'string' ? rawActive.trim() : ''
  const activeLayer = layers.find(
    (layer) => layer.id === activeId && layer.enabled && layer.type !== 'p2p',
  )
  if (activeLayer !== undefined) network.activeLayerId = activeLayer.id
  return { ok: true, network }
}

export type WindowPreferencesValidationResult =
  | { readonly ok: true; readonly preferences: WindowPreferences }
  | { readonly ok: false; readonly message: string }

export function validateWindowPreferences(value: unknown): WindowPreferencesValidationResult {
  if (!isRecord(value)) return { ok: false, message: '窗口设置格式不正确' }
  if (typeof value['minimizeToTray'] !== 'boolean') {
    return { ok: false, message: 'minimizeToTray 必须是布尔值' }
  }
  if (typeof value['openAtLogin'] !== 'boolean') {
    return { ok: false, message: 'openAtLogin 必须是布尔值' }
  }
  return {
    ok: true,
    preferences: {
      minimizeToTray: value['minimizeToTray'],
      openAtLogin: value['openAtLogin'],
    },
  }
}

export function validateSensorConfigPatch(
  patch: SensorConfigPatch,
): SensorConfigValidationResult {
  if (patch.idleThreshold !== undefined) {
    const threshold = patch.idleThreshold
    if (!Number.isInteger(threshold) || threshold < 30 || threshold > 3600) {
      return { ok: false, message: '无人判定阈值需在 30-3600 秒之间' }
    }
  }

  if (patch.agentId !== undefined) {
    const length = patch.agentId.trim().length
    if (length < 1 || length > 64) {
      return { ok: false, message: '设备 ID 需为 1-64 个字符' }
    }
  }

  if (patch.agentName !== undefined && patch.agentName.trim().length > 64) {
    return { ok: false, message: '设备名称不能超过 64 个字符' }
  }

  if (patch.password !== undefined && (patch.password.length < 1 || patch.password.length > 256)) {
    return { ok: false, message: '密码需为 1-256 个字符' }
  }

  if (
    patch.backendToken !== undefined &&
    (patch.backendToken.length < 1 || patch.backendToken.length > 512)
  ) {
    return { ok: false, message: '后端令牌需为 1-512 个字符' }
  }

  return { ok: true }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0) return false
  try {
    return HTTP_PROTOCOLS.has(new URL(trimmed).protocol)
  } catch (error) {
    if (error instanceof TypeError) return false
    throw error
  }
}

export function normalizePort(value: unknown, fallback: number = DEFAULT_SENSOR_PORT): number {
  const candidate =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65535) return fallback
  return candidate
}

export function normalizeSensorPatch(value: unknown): SensorConfigPatch {
  if (!isRecord(value)) return {}

  const patch: SensorConfigPatch = {}
  if (typeof value.enabled === 'boolean') patch.enabled = value.enabled
  if (typeof value.rememberPassword === 'boolean') patch.rememberPassword = value.rememberPassword
  if (typeof value.windowEnabled === 'boolean') patch.windowEnabled = value.windowEnabled
  if (typeof value.idleEnabled === 'boolean') patch.idleEnabled = value.idleEnabled
  if (typeof value.screenEnabled === 'boolean') patch.screenEnabled = value.screenEnabled
  if (typeof value.sslVerify === 'boolean') patch.sslVerify = value.sslVerify

  const serverUrl = value.serverUrl
  if (isHttpUrl(serverUrl)) patch.serverUrl = serverUrl.trim()

  const agentId = value.agentId
  if (typeof agentId === 'string' && agentId.trim().length > 0) patch.agentId = agentId.trim()

  const agentName = value.agentName
  if (typeof agentName === 'string' && agentName.trim().length > 0) {
    patch.agentName = agentName.trim()
  }

  const username = value.username
  if (typeof username === 'string' && username.trim().length > 0) {
    patch.username = username.trim()
  }

  const sslCaFile = value.sslCaFile
  if (typeof sslCaFile === 'string') patch.sslCaFile = sslCaFile.trim()

  const idleThreshold = value.idleThreshold
  if (typeof idleThreshold === 'number' && Number.isFinite(idleThreshold)) {
    const rounded = Math.round(idleThreshold)
    if (rounded > 0) patch.idleThreshold = rounded
  }

  const password = value.password
  if (typeof password === 'string' && password.length > 0) patch.password = password

  const backendToken = value.backendToken
  if (typeof backendToken === 'string' && backendToken.length > 0) {
    patch.backendToken = backendToken
  }

  return patch
}
