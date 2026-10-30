import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  CertificateTarget,
  CertificateTrustInput,
  DesktopApi,
} from '../shared/ipc'
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
} from '../shared/types'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  const result: IpcResult<T> = await ipcRenderer.invoke(channel, ...args)
  return result
}

const api: DesktopApi = {
  getBootstrap(): Promise<IpcResult<Bootstrap>> {
    return invoke<Bootstrap>(IPC.BOOTSTRAP_GET)
  },
  testServer(url: string): Promise<IpcResult<ServerTestResult>> {
    return invoke<ServerTestResult>(IPC.SERVER_TEST, url)
  },
  saveServer(
    server: DesktopConfig['server'],
  ): Promise<IpcResult<DesktopConfig['server']>> {
    return invoke<DesktopConfig['server']>(IPC.SERVER_SAVE, server)
  },
  retryServer(): Promise<IpcResult<ServerTestResult>> {
    return invoke<ServerTestResult>(IPC.SERVER_RETRY)
  },
  getNetworkConfig(): Promise<IpcResult<TransportConfig>> {
    return invoke<TransportConfig>(IPC.NETWORK_CONFIG_GET)
  },
  saveNetworkConfig(
    transport: TransportConfig,
  ): Promise<IpcResult<NetworkConfigSaveResult>> {
    return invoke<NetworkConfigSaveResult>(IPC.NETWORK_CONFIG_SAVE, transport)
  },
  getNetworkLayers(): Promise<IpcResult<NetworkStateView>> {
    return invoke<NetworkStateView>(IPC.NETWORK_LAYERS_GET)
  },
  saveNetworkLayers(network: NetworkConfig): Promise<IpcResult<NetworkApplyResult>> {
    return invoke<NetworkApplyResult>(IPC.NETWORK_LAYERS_SAVE, network)
  },
  probeNetwork(): Promise<IpcResult<NetworkApplyResult>> {
    return invoke<NetworkApplyResult>(IPC.NETWORK_PROBE)
  },
  selectNetworkLayer(layerId: string): Promise<IpcResult<NetworkApplyResult>> {
    return invoke<NetworkApplyResult>(IPC.NETWORK_LAYER_SELECT, layerId)
  },
  getWindowPreferences(): Promise<IpcResult<WindowPreferences>> {
    return invoke<WindowPreferences>(IPC.WINDOW_PREFS_GET)
  },
  saveWindowPreferences(
    preferences: WindowPreferences,
  ): Promise<IpcResult<WindowPreferences>> {
    return invoke<WindowPreferences>(IPC.WINDOW_PREFS_SAVE, preferences)
  },
  inspectCertificate(target: CertificateTarget): Promise<IpcResult<CertInfo>> {
    return invoke<CertInfo>(IPC.CERT_INSPECT, target)
  },
  trustCertificate(input: CertificateTrustInput): Promise<IpcResult<CertInfo>> {
    return invoke<CertInfo>(IPC.CERT_TRUST, input)
  },
  clearLogin(): Promise<IpcResult<void>> {
    return invoke<void>(IPC.LOGIN_CLEAR)
  },
  resetAll(): Promise<IpcResult<void>> {
    return invoke<void>(IPC.APP_RESET_ALL)
  },
  getSensorConfig(): Promise<IpcResult<SensorConfigView>> {
    return invoke<SensorConfigView>(IPC.SENSOR_CONFIG_GET)
  },
  saveSensorConfig(patch: SensorConfigPatch): Promise<IpcResult<SensorConfigView>> {
    return invoke<SensorConfigView>(IPC.SENSOR_CONFIG_SAVE, patch)
  },
  getSensorStatus(): Promise<IpcResult<SensorStatus>> {
    return invoke<SensorStatus>(IPC.SENSOR_STATUS_GET)
  },
  startSensor(): Promise<IpcResult<SensorStatus>> {
    return invoke<SensorStatus>(IPC.SENSOR_START)
  },
  stopSensor(): Promise<IpcResult<SensorStatus>> {
    return invoke<SensorStatus>(IPC.SENSOR_STOP)
  },
  restartSensor(): Promise<IpcResult<SensorStatus>> {
    return invoke<SensorStatus>(IPC.SENSOR_RESTART)
  },
  testSensorLogin(): Promise<IpcResult<SensorLoginTestResult>> {
    return invoke<SensorLoginTestResult>(IPC.SENSOR_TEST_LOGIN)
  },
  openSensorPanel(): Promise<IpcResult<void>> {
    return invoke<void>(IPC.SENSOR_PANEL_OPEN)
  },
  openLogs(): Promise<IpcResult<void>> {
    return invoke<void>(IPC.LOGS_OPEN)
  },
  readLogs(lines?: number): Promise<IpcResult<LogsReadResult>> {
    return lines === undefined
      ? invoke<LogsReadResult>(IPC.LOGS_READ)
      : invoke<LogsReadResult>(IPC.LOGS_READ, lines)
  },
  startLogStream(options?: {
    readonly lines?: number
    readonly sources?: readonly LogSource[]
  }): Promise<IpcResult<void>> {
    return invoke<void>(IPC.LOGS_STREAM_START, options ?? {})
  },
  stopLogStream(): Promise<IpcResult<void>> {
    return invoke<void>(IPC.LOGS_STREAM_STOP)
  },
  onLogEvent(callback: (event: LogStreamEvent) => void): () => void {
    const listener = (_event: IpcRendererEvent, payload: LogStreamEvent): void => {
      callback(payload)
    }
    ipcRenderer.on(IPC.LOG_EVENT, listener)
    return () => {
      ipcRenderer.removeListener(IPC.LOG_EVENT, listener)
    }
  },
  openAppSettings(): Promise<IpcResult<void>> {
    return invoke<void>(IPC.APP_OPEN_SETTINGS)
  },
  showMain(): Promise<IpcResult<void>> {
    return invoke<void>(IPC.APP_SHOW_MAIN)
  },
  quit(): Promise<IpcResult<void>> {
    return invoke<void>(IPC.APP_QUIT)
  },
  onStatusChanged(callback: (status: SensorStatus) => void): () => void {
    const listener = (_event: IpcRendererEvent, status: SensorStatus): void => {
      callback(status)
    }
    ipcRenderer.on(IPC.STATUS_CHANGED, listener)
    return () => {
      ipcRenderer.removeListener(IPC.STATUS_CHANGED, listener)
    }
  },
}

contextBridge.exposeInMainWorld('axeuh', api)
