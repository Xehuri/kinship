import { randomBytes, randomUUID } from 'node:crypto'
import type {
  NetworkLayerTlsMode,
  SensorConfigPatch,
  SensorConfigView,
  SensorState,
  SensorStatus,
  TransportConfig,
} from '../../shared/types'
import { resolveTransportServerUrl } from '../../shared/validation'
import { FileMissingError, JsonParseError, readJsonFile, writeJsonAtomic } from './atomic-json'
import type { SensorHealthBody } from './sensor-probe'

export interface SensorAgentConfig {
  server_host: string
  server_port: number
  agent_token: string
  instance_id: string
}

export interface SensorCollectionConfig {
  enabled?: boolean
  server_url?: string
  username?: string
  backend_token?: string
  remember_password?: boolean
  idle_threshold?: number
  window_enabled?: boolean
  idle_enabled?: boolean
  screen_enabled?: boolean
  ssl_verify?: boolean
  ssl_ca_file?: string
  agent_id?: string
  agent_name?: string
  password_enc?: string
  [key: string]: unknown
}

export interface EnsureAgentConfigOptions {
  readonly preferredPort: number
  readonly instanceId?: string
  readonly token?: string
}

export interface SensorTlsPolicy {
  readonly mode: NetworkLayerTlsMode
  readonly caPemPath?: string
}

export interface SensorCollectionBuildContext {
  readonly serverUrl: string
  readonly sslCaFile: string
  readonly sslVerify?: boolean
}

export interface SensorCollectionBuildResult {
  readonly collectionConfig: SensorCollectionConfig
  readonly apiPatch: Record<string, unknown>
}

export interface SensorNetworkConfigContext {
  readonly transport: TransportConfig
  readonly fallbackServerUrl: string
  readonly sslCaFile?: string
  readonly sslVerify?: boolean
}

export interface SensorStatusLocalState {
  readonly state: SensorState
  readonly port: number
  readonly enabled: boolean
  readonly panelUrl?: string
  readonly logPath?: string
  readonly instanceId?: string
  readonly pid?: number
  readonly lastError?: string
}

const MIN_AGENT_TOKEN_LENGTH = 32
const MASK = '******'

export const DEFAULT_AGENT_CONFIG: SensorAgentConfig = {
  server_host: '127.0.0.1',
  server_port: 18888,
  agent_token: '',
  instance_id: '',
}

export const DEFAULT_COLLECTION_CONFIG: SensorCollectionConfig = {
  enabled: false,
  server_url: '',
  username: '',
  backend_token: '',
  remember_password: false,
  idle_threshold: 300,
  window_enabled: true,
  idle_enabled: true,
  screen_enabled: true,
  ssl_verify: true,
  ssl_ca_file: '',
  agent_id: 'default-agent',
  agent_name: '',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizePort(value: unknown, fallback: number): number {
  const port = readFiniteNumber(value, fallback)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback
}

function readAgentRecord(path: string): Record<string, unknown> {
  const raw = readJsonFile<unknown>(path)
  if (!isRecord(raw)) {
    throw new JsonParseError(path, '根节点不是对象')
  }
  return raw
}

function normalizeAgentRecord(raw: Record<string, unknown>): SensorAgentConfig {
  return {
    server_host: readString(raw['server_host'], DEFAULT_AGENT_CONFIG.server_host),
    server_port: normalizePort(raw['server_port'], DEFAULT_AGENT_CONFIG.server_port),
    agent_token: readString(raw['agent_token']),
    instance_id: readString(raw['instance_id']),
  }
}

function generateAgentToken(): string {
  return randomBytes(32).toString('base64url')
}

function isMissingOrCorrupt(error: unknown): boolean {
  return error instanceof FileMissingError || error instanceof JsonParseError
}

export function readAgentConfig(path: string): SensorAgentConfig {
  return normalizeAgentRecord(readAgentRecord(path))
}

export function writeAgentConfig(path: string, config: SensorAgentConfig): void {
  writeJsonAtomic(path, config)
}

export function readCollectionConfig(path: string): SensorCollectionConfig {
  const raw = readJsonFile<unknown>(path)
  if (!isRecord(raw)) {
    throw new JsonParseError(path, '根节点不是对象')
  }

  const config: SensorCollectionConfig = { ...DEFAULT_COLLECTION_CONFIG }
  for (const [key, value] of Object.entries(raw)) {
    config[key] = value
  }
  return config
}

export function writeCollectionConfig(path: string, config: SensorCollectionConfig): void {
  writeJsonAtomic(path, config)
}

export function ensureAgentConfig(
  path: string,
  options: EnsureAgentConfigOptions,
): SensorAgentConfig {
  let raw: Record<string, unknown> | undefined
  try {
    raw = readAgentRecord(path)
  } catch (error) {
    if (!isMissingOrCorrupt(error)) throw error
  }

  const existing = raw === undefined ? undefined : normalizeAgentRecord(raw)
  const existingToken = existing?.agent_token ?? ''
  const generatedToken =
    existingToken.length >= MIN_AGENT_TOKEN_LENGTH
      ? existingToken
      : options.token !== undefined && options.token.trim().length > 0
        ? options.token.trim()
        : generateAgentToken()

  const existingInstance = existing?.instance_id ?? ''
  const generatedInstance =
    existingInstance.length > 0
      ? existingInstance
      : options.instanceId !== undefined && options.instanceId.trim().length > 0
        ? options.instanceId.trim()
        : randomUUID()

  const next: SensorAgentConfig = {
    server_host: '127.0.0.1',
    server_port: normalizePort(options.preferredPort, DEFAULT_AGENT_CONFIG.server_port),
    agent_token: generatedToken,
    instance_id: generatedInstance,
  }

  const preserved: Record<string, unknown> = raw === undefined ? {} : { ...raw }
  const changed =
    raw === undefined ||
    raw['server_host'] !== next.server_host ||
    raw['server_port'] !== next.server_port ||
    raw['agent_token'] !== next.agent_token ||
    raw['instance_id'] !== next.instance_id

  if (changed) {
    writeJsonAtomic(path, {
      ...preserved,
      server_host: next.server_host,
      server_port: next.server_port,
      agent_token: next.agent_token,
      instance_id: next.instance_id,
    })
  }

  return next
}

function cloneCollection(existing: SensorCollectionConfig | undefined): SensorCollectionConfig {
  const collection: SensorCollectionConfig = { ...DEFAULT_COLLECTION_CONFIG }
  if (existing === undefined) return collection
  for (const [key, value] of Object.entries(existing)) {
    collection[key] = value
  }
  return collection
}

export function buildSensorCollectionConfig(
  existing: SensorCollectionConfig | undefined,
  patch: SensorConfigPatch,
  context: SensorCollectionBuildContext,
): SensorCollectionBuildResult {
  const collection = cloneCollection(existing)
  const caFile = context.sslCaFile.trim()

  collection.enabled = patch.enabled ?? readBoolean(collection.enabled, false)
  collection.server_url = context.serverUrl
  collection.username = patch.username ?? readString(collection.username)
  collection.remember_password =
    patch.rememberPassword ?? readBoolean(collection.remember_password, false)
  collection.idle_threshold = patch.idleThreshold ?? readFiniteNumber(collection.idle_threshold, 300)
  collection.window_enabled = patch.windowEnabled ?? readBoolean(collection.window_enabled, true)
  collection.idle_enabled = patch.idleEnabled ?? readBoolean(collection.idle_enabled, true)
  collection.screen_enabled = patch.screenEnabled ?? readBoolean(collection.screen_enabled, true)
  collection.agent_id = patch.agentId ?? readString(collection.agent_id, 'default-agent')
  collection.agent_name = patch.agentName ?? readString(collection.agent_name)
  collection.ssl_ca_file = caFile
  collection.ssl_verify =
    context.sslVerify ??
    (caFile.length > 0 ? true : (patch.sslVerify ?? readBoolean(collection.ssl_verify, true)))

  const backendToken = patch.backendToken
  const backendTokenChanged =
    typeof backendToken === 'string' && backendToken.length > 0 && backendToken !== MASK
  if (backendTokenChanged) {
    collection.backend_token = backendToken
  } else if (typeof collection.backend_token !== 'string') {
    collection.backend_token = ''
  }

  delete collection['password']
  delete collection.password_enc

  const apiPatch: Record<string, unknown> = {
    enabled: collection.enabled,
    server_url: collection.server_url,
  }

  if (patch.username !== undefined) apiPatch['username'] = patch.username
  if (patch.rememberPassword !== undefined) {
    apiPatch['remember_password'] = patch.rememberPassword
  }
  if (patch.idleThreshold !== undefined) apiPatch['idle_threshold'] = patch.idleThreshold
  if (patch.windowEnabled !== undefined) apiPatch['window_enabled'] = patch.windowEnabled
  if (patch.idleEnabled !== undefined) apiPatch['idle_enabled'] = patch.idleEnabled
  if (patch.screenEnabled !== undefined) apiPatch['screen_enabled'] = patch.screenEnabled
  if (patch.agentId !== undefined) apiPatch['agent_id'] = patch.agentId
  if (patch.agentName !== undefined) apiPatch['agent_name'] = patch.agentName
  if (patch.sslCaFile !== undefined) apiPatch['ssl_ca_file'] = caFile
  if (patch.sslVerify !== undefined || patch.sslCaFile !== undefined) {
    apiPatch['ssl_verify'] = collection.ssl_verify
  }
  if (context.sslVerify !== undefined) {
    apiPatch['ssl_ca_file'] = caFile
    apiPatch['ssl_verify'] = collection.ssl_verify
  } else if (caFile.length > 0) {
    apiPatch['ssl_ca_file'] = caFile
    apiPatch['ssl_verify'] = true
  }
  if (backendTokenChanged) apiPatch['backend_token'] = backendToken

  const password = patch.password
  if (typeof password === 'string' && password.length > 0 && password !== MASK) {
    apiPatch['password'] = password
  }

  return { collectionConfig: collection, apiPatch }
}

export function buildSensorNetworkConfig(
  existing: SensorCollectionConfig | undefined,
  context: SensorNetworkConfigContext,
): SensorCollectionConfig {
  const collection = cloneCollection(existing)
  collection.endpoint_candidates = context.transport.endpointCandidates.map((candidate) => ({
    name: candidate.name,
    url: candidate.url,
    priority: candidate.priority,
  }))
  const fallback = context.fallbackServerUrl.trim() || readString(collection.server_url).trim()
  collection.server_url = resolveTransportServerUrl(context.transport, fallback)
  if (context.sslCaFile !== undefined) collection.ssl_ca_file = context.sslCaFile
  if (context.sslVerify !== undefined) collection.ssl_verify = context.sslVerify
  return collection
}

export function buildSensorConfigView(
  _agent: SensorAgentConfig,
  collection: SensorCollectionConfig,
): SensorConfigView {
  return {
    enabled: readBoolean(collection.enabled, false),
    serverUrl: readString(collection.server_url),
    agentId: readString(collection.agent_id, 'default-agent') || 'default-agent',
    agentName: readString(collection.agent_name),
    username: readString(collection.username),
    hasStoredPassword: Boolean(collection.password_enc),
    rememberPassword: readBoolean(collection.remember_password, false),
    hasBackendToken: Boolean(collection.backend_token),
    idleThreshold: readFiniteNumber(collection.idle_threshold, 300),
    windowEnabled: readBoolean(collection.window_enabled, true),
    idleEnabled: readBoolean(collection.idle_enabled, true),
    screenEnabled: readBoolean(collection.screen_enabled, true),
    sslVerify: collection.ssl_verify !== false,
    sslCaFile: readString(collection.ssl_ca_file),
  }
}

function readLastEventAt(status: Record<string, unknown> | undefined): string | undefined {
  const events = status?.['last_events']
  if (!Array.isArray(events) || events.length === 0) return undefined
  const last = events[events.length - 1]
  if (!isRecord(last)) return undefined
  const iso = readString(last['t_iso'])
  if (iso.length > 0) return iso
  const time = readString(last['t'])
  return time.length > 0 ? time : undefined
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function buildSensorStatus(
  local: SensorStatusLocalState,
  health?: SensorHealthBody | null,
  status?: Record<string, unknown> | null,
): SensorStatus {
  const processRunning =
    local.state === 'running' || local.state === 'external' || local.state === 'starting'
  const remoteRunning = status?.['running']
  const running = processRunning || remoteRunning === true

  const result: SensorStatus = {
    state: local.state,
    enabled:
      typeof status?.['enabled'] === 'boolean'
        ? status['enabled']
        : local.enabled,
    running,
    port: local.port,
  }

  if (typeof status?.['logged_in'] === 'boolean') result.loggedIn = status['logged_in']
  if (local.instanceId !== undefined) result.instanceId = local.instanceId
  const remoteInstance = readOptionalString(status?.['instance_id'])
  if (remoteInstance !== undefined) result.instanceId = remoteInstance

  const agentId = health?.agent_id ?? readOptionalString(status?.['agent_id'])
  if (agentId !== undefined && agentId.length > 0) result.agentId = agentId
  const agentName = health?.agent_name ?? readOptionalString(status?.['agent_name'])
  if (agentName !== undefined && agentName.length > 0) result.agentName = agentName

  const pid =
    readOptionalNumber(status?.['pid']) ??
    (health !== undefined && health !== null ? health.pid : undefined)
  if (pid !== undefined && pid > 0) result.pid = pid
  if (local.pid !== undefined && result.pid === undefined) result.pid = local.pid

  const queueSize = readOptionalNumber(status?.['queue_size'])
  if (queueSize !== undefined) result.queueSize = queueSize

  const authError = readOptionalString(status?.['auth_error'])
  if (authError !== undefined) result.authError = authError

  const lastEventAt = readLastEventAt(status ?? undefined)
  if (lastEventAt !== undefined) result.lastEventAt = lastEventAt

  if (local.lastError !== undefined) result.lastError = local.lastError
  if (local.panelUrl !== undefined) result.panelUrl = local.panelUrl
  if (local.logPath !== undefined) result.logPath = local.logPath

  return result
}
