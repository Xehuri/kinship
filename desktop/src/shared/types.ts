export type TransportMode = 'auto' | 'frp'

export interface EndpointCandidate {
  name: string
  url: string
  priority: number
}

export interface TransportConfig {
  mode: TransportMode
  endpointCandidates: EndpointCandidate[]
  currentEndpoint?: string
}

export type NetworkLayerType = 'direct' | 'frp' | 'p2p'
export type NetworkLayerTlsMode = 'system' | 'pinned' | 'insecure'

/**
 * Unified network layer. Ordered layers are probed top-down; the first healthy
 * layer supplies both the SPA origin and the PC-sensor server URL.
 *
 * P2P is reserved for a later transport iteration. The type exists so the
 * contract can grow without a schema break, but this build rejects every P2P
 * layer at save time with P2P_NOT_AVAILABLE.
 */
export interface NetworkLayer {
  id: string
  type: NetworkLayerType
  name: string
  address: string
  enabled: boolean
  tlsMode: NetworkLayerTlsMode
  fingerprint256?: string
  caPemPath?: string
}

export interface NetworkConfig {
  layers: NetworkLayer[]
  activeLayerId?: string
}

export type NetworkLayerProbeState = 'healthy' | 'unhealthy' | 'skipped' | 'untested'

export interface NetworkLayerStatus {
  id: string
  type: NetworkLayerType
  name: string
  address: string
  enabled: boolean
  tlsMode: NetworkLayerTlsMode
  state: NetworkLayerProbeState
  latencyMs?: number
  checkedAt?: string
  error?: string
  code?: string
}

export interface NetworkStateView {
  config: NetworkConfig
  statuses: NetworkLayerStatus[]
  activeLayerId?: string
  activeAddress?: string
  activeTlsMode?: NetworkLayerTlsMode
}

export interface NetworkApplyResult extends NetworkStateView {
  sensorSynced: boolean
  sensorError?: string
  error?: string
  code?: string
}

export interface WindowPreferences {
  minimizeToTray: boolean
  openAtLogin: boolean
}

export interface DesktopConfig {
  schemaVersion: 3
  /** Derived from the active network layer; never edited directly. */
  server: {
    url: string
    allowUntrustedCa: boolean
    tlsPin?: {
      host: string
      fingerprint256: string
      caPemPath?: string
    }
  }
  /** Derived from the active layer; kept for the sensor fallback contract. */
  transport: TransportConfig
  network: NetworkConfig
  window: {
    minimizeToTray: boolean
    openAtLogin: boolean
    lastHash?: string
    bounds?: {
      x?: number
      y?: number
      width: number
      height: number
    }
  }
}

export interface NetworkConfigSaveResult {
  transport: TransportConfig
  sensorSynced: boolean
  sensorError?: string
}

export interface SensorConfigView {
  enabled: boolean
  serverUrl: string
  agentId: string
  agentName: string
  username: string
  hasStoredPassword: boolean
  rememberPassword: boolean
  hasBackendToken: boolean
  idleThreshold: number
  windowEnabled: boolean
  idleEnabled: boolean
  screenEnabled: boolean
  sslVerify: boolean
  sslCaFile: string
}

export type SensorConfigPatch = Partial<
  Omit<SensorConfigView, 'hasStoredPassword' | 'hasBackendToken'>
> & {
  password?: string
  backendToken?: string
}

export type SensorState =
  | 'unconfigured'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'external'
  | 'conflict'
  | 'runtime-missing'
  | 'crashed'
  | 'stopping'

export interface SensorStatus {
  state: SensorState
  enabled: boolean
  running: boolean
  loggedIn?: boolean
  port: number
  instanceId?: string
  agentId?: string
  agentName?: string
  pid?: number
  queueSize?: number
  lastEventAt?: string
  lastError?: string
  authError?: string
  panelUrl?: string
  logPath?: string
}

export interface SensorLoginTestResult {
  success: boolean
  loggedIn: boolean
  message: string
  authError?: string
  status: SensorStatus
}

export interface LogFileView {
  path: string
  lines: string[]
  error?: string
}

export interface LogsReadResult {
  desktop: LogFileView
  sensor: LogFileView
}

export type LogSource = 'desktop' | 'sensor'

export interface LogStreamEvent {
  source: LogSource
  type: 'snapshot' | 'append' | 'reset'
  path: string
  lines: string[]
  error?: string
  reset?: boolean
}

export interface CertInfo {
  host: string
  port: number
  subject: string
  issuer: string
  validFrom: string
  validTo: string
  fingerprint256: string
  selfSigned: boolean
  error?: string
  /** 服务器完整证书链（PEM），仅 inspect/trust 流程返回。 */
  caPem?: string
}

export interface ServerTestResult {
  ok: boolean
  latencyMs?: number
  health?: boolean
  mobile?: boolean
  error?: string
  code?: string
  cert?: CertInfo
}

export interface Bootstrap {
  appVersion: string
  electronVersion: string
  platform: string
  firstRun: boolean
  config: DesktopConfig
  sensorConfig: SensorConfigView
  sensorStatus: SensorStatus
}

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string }
