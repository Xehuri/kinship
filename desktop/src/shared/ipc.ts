import type {
  Bootstrap,
  CertInfo,
  DesktopConfig,
  IpcResult,
  LogSource,
  LogStreamEvent,
  LogsReadResult,
  NetworkApplyResult,
  NetworkConfig,
  NetworkConfigSaveResult,
  NetworkStateView,
  SensorConfigPatch,
  SensorConfigView,
  SensorLoginTestResult,
  SensorStatus,
  ServerTestResult,
  TransportConfig,
  WindowPreferences,
} from './types'

export const IPC = Object.freeze({
  BOOTSTRAP_GET: 'axeuh:bootstrap:get',
  SERVER_TEST: 'axeuh:server:test',
  SERVER_SAVE: 'axeuh:server:save',
  SERVER_RETRY: 'axeuh:server:retry',
  NETWORK_CONFIG_GET: 'axeuh:network:config:get',
  NETWORK_CONFIG_SAVE: 'axeuh:network:config:save',
  NETWORK_LAYERS_GET: 'axeuh:network:layers:get',
  NETWORK_LAYERS_SAVE: 'axeuh:network:layers:save',
  NETWORK_PROBE: 'axeuh:network:probe',
  NETWORK_LAYER_SELECT: 'axeuh:network:layer:select',
  WINDOW_PREFS_GET: 'axeuh:window:prefs:get',
  WINDOW_PREFS_SAVE: 'axeuh:window:prefs:save',
  CERT_INSPECT: 'axeuh:cert:inspect',
  CERT_TRUST: 'axeuh:cert:trust',
  LOGIN_CLEAR: 'axeuh:login:clear',
  APP_RESET_ALL: 'axeuh:app:reset-all',
  SENSOR_CONFIG_GET: 'axeuh:sensor:config:get',
  SENSOR_CONFIG_SAVE: 'axeuh:sensor:config:save',
  SENSOR_STATUS_GET: 'axeuh:sensor:status:get',
  SENSOR_START: 'axeuh:sensor:start',
  SENSOR_STOP: 'axeuh:sensor:stop',
  SENSOR_RESTART: 'axeuh:sensor:restart',
  SENSOR_TEST_LOGIN: 'axeuh:sensor:test-login',
  SENSOR_PANEL_OPEN: 'axeuh:sensor:panel:open',
  LOGS_OPEN: 'axeuh:logs:open',
  LOGS_READ: 'axeuh:logs:read',
  LOGS_STREAM_START: 'axeuh:logs:stream:start',
  LOGS_STREAM_STOP: 'axeuh:logs:stream:stop',
  LOG_EVENT: 'axeuh:logs:stream:event',
  APP_OPEN_SETTINGS: 'axeuh:app:settings',
  APP_SHOW_MAIN: 'axeuh:app:show-main',
  APP_QUIT: 'axeuh:app:quit',
  STATUS_CHANGED: 'axeuh:status:changed',
} as const)

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

export interface CertificateTarget {
  readonly host: string
  readonly port: number
}

export interface CertificateTrustInput extends CertificateTarget {
  readonly caPem: string
}

export interface DesktopApi {
  getBootstrap(): Promise<IpcResult<Bootstrap>>
  testServer(url: string): Promise<IpcResult<ServerTestResult>>
  saveServer(server: DesktopConfig['server']): Promise<IpcResult<DesktopConfig['server']>>
  retryServer(): Promise<IpcResult<ServerTestResult>>
  getNetworkConfig(): Promise<IpcResult<TransportConfig>>
  saveNetworkConfig(transport: TransportConfig): Promise<IpcResult<NetworkConfigSaveResult>>
  getNetworkLayers?(): Promise<IpcResult<NetworkStateView>>
  saveNetworkLayers?(network: NetworkConfig): Promise<IpcResult<NetworkApplyResult>>
  probeNetwork?(): Promise<IpcResult<NetworkApplyResult>>
  selectNetworkLayer?(layerId: string): Promise<IpcResult<NetworkApplyResult>>
  getWindowPreferences?(): Promise<IpcResult<WindowPreferences>>
  saveWindowPreferences?(
    preferences: WindowPreferences,
  ): Promise<IpcResult<WindowPreferences>>
  inspectCertificate(target: CertificateTarget): Promise<IpcResult<CertInfo>>
  trustCertificate(input: CertificateTrustInput): Promise<IpcResult<CertInfo>>
  clearLogin(): Promise<IpcResult<void>>
  resetAll(): Promise<IpcResult<void>>
  getSensorConfig(): Promise<IpcResult<SensorConfigView>>
  saveSensorConfig(patch: SensorConfigPatch): Promise<IpcResult<SensorConfigView>>
  getSensorStatus(): Promise<IpcResult<SensorStatus>>
  startSensor(): Promise<IpcResult<SensorStatus>>
  stopSensor(): Promise<IpcResult<SensorStatus>>
  restartSensor(): Promise<IpcResult<SensorStatus>>
  testSensorLogin?(): Promise<IpcResult<SensorLoginTestResult>>
  openSensorPanel(): Promise<IpcResult<void>>
  openLogs(): Promise<IpcResult<void>>
  readLogs?(lines?: number): Promise<IpcResult<LogsReadResult>>
  startLogStream?(options?: {
    readonly lines?: number
    readonly sources?: readonly LogSource[]
  }): Promise<IpcResult<void>>
  stopLogStream?(): Promise<IpcResult<void>>
  onLogEvent?(callback: (event: LogStreamEvent) => void): () => void
  openAppSettings(): Promise<IpcResult<void>>
  showMain(): Promise<IpcResult<void>>
  quit(): Promise<IpcResult<void>>
  onStatusChanged(callback: (status: SensorStatus) => void): () => void
}
