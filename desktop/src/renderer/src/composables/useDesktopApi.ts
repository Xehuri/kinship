import type { CertificateTarget, CertificateTrustInput, DesktopApi } from '../../../shared/ipc'
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
} from '../../../shared/types'

export const API_UNAVAILABLE_MESSAGE = '桌面 API 不可用'

type OptionalDesktopApi =
  | 'testSensorLogin'
  | 'readLogs'
  | 'getNetworkLayers'
  | 'saveNetworkLayers'
  | 'probeNetwork'
  | 'selectNetworkLayer'
  | 'getWindowPreferences'
  | 'saveWindowPreferences'
  | 'startLogStream'
  | 'stopLogStream'
  | 'onLogEvent'

export type DesktopBridge = Omit<DesktopApi, OptionalDesktopApi> & {
  readonly available: boolean
  testSensorLogin(): Promise<IpcResult<SensorLoginTestResult>>
  readLogs(lines?: number): Promise<IpcResult<LogsReadResult>>
  getNetworkLayers(): Promise<IpcResult<NetworkStateView>>
  saveNetworkLayers(network: NetworkConfig): Promise<IpcResult<NetworkApplyResult>>
  probeNetwork(): Promise<IpcResult<NetworkApplyResult>>
  selectNetworkLayer(layerId: string): Promise<IpcResult<NetworkApplyResult>>
  getWindowPreferences(): Promise<IpcResult<WindowPreferences>>
  saveWindowPreferences(
    preferences: WindowPreferences,
  ): Promise<IpcResult<WindowPreferences>>
  startLogStream(options?: {
    readonly lines?: number
    readonly sources?: readonly LogSource[]
  }): Promise<IpcResult<void>>
  stopLogStream(): Promise<IpcResult<void>>
  onLogEvent(callback: (event: LogStreamEvent) => void): () => void
}

function unavailable<T>(): IpcResult<T> {
  return { ok: false, error: API_UNAVAILABLE_MESSAGE, code: 'API_UNAVAILABLE' }
}

function failed<T>(error: unknown): IpcResult<T> {
  const message =
    error instanceof Error && error.message.trim().length > 0 ? error.message : '桌面 API 调用失败'
  return { ok: false, error: message, code: 'API_ERROR' }
}

function invoke<T>(call: (() => Promise<IpcResult<T>>) | undefined): Promise<IpcResult<T>> {
  if (typeof call !== 'function') return Promise.resolve(unavailable<T>())
  try {
    return Promise.resolve(call()).catch((error: unknown) => failed<T>(error))
  } catch (error) {
    return Promise.resolve(failed<T>(error))
  }
}

function readApi(): DesktopApi | undefined {
  if (typeof window === 'undefined') return undefined
  const candidate: unknown = window.axeuh
  if (typeof candidate !== 'object' || candidate === null) return undefined
  return candidate as DesktopApi
}

/**
 * Safe renderer-side wrapper around the frozen preload contract. The preload is
 * expected to grow incrementally, so missing methods resolve to
 * API_UNAVAILABLE instead of throwing or faking success.
 */
export function useDesktopApi(): DesktopBridge {
  const api = readApi()

  return {
    available: api !== undefined,
    getBootstrap: (): Promise<IpcResult<Bootstrap>> => invoke(api?.getBootstrap?.bind(api)),
    testServer: (url: string): Promise<IpcResult<ServerTestResult>> =>
      invoke(api?.testServer?.bind(api, url)),
    saveServer: (
      server: DesktopConfig['server'],
    ): Promise<IpcResult<DesktopConfig['server']>> =>
      invoke(api?.saveServer?.bind(api, server)),
    retryServer: (): Promise<IpcResult<ServerTestResult>> =>
      invoke(api?.retryServer?.bind(api)),
    getNetworkConfig: (): Promise<IpcResult<TransportConfig>> =>
      invoke(api?.getNetworkConfig?.bind(api)),
    saveNetworkConfig: (
      transport: TransportConfig,
    ): Promise<IpcResult<NetworkConfigSaveResult>> =>
      invoke(api?.saveNetworkConfig?.bind(api, transport)),
    getNetworkLayers: (): Promise<IpcResult<NetworkStateView>> =>
      invoke(api?.getNetworkLayers?.bind(api)),
    saveNetworkLayers: (network: NetworkConfig): Promise<IpcResult<NetworkApplyResult>> =>
      invoke(api?.saveNetworkLayers?.bind(api, network)),
    probeNetwork: (): Promise<IpcResult<NetworkApplyResult>> =>
      invoke(api?.probeNetwork?.bind(api)),
    selectNetworkLayer: (layerId: string): Promise<IpcResult<NetworkApplyResult>> =>
      invoke(api?.selectNetworkLayer?.bind(api, layerId)),
    getWindowPreferences: (): Promise<IpcResult<WindowPreferences>> =>
      invoke(api?.getWindowPreferences?.bind(api)),
    saveWindowPreferences: (
      preferences: WindowPreferences,
    ): Promise<IpcResult<WindowPreferences>> =>
      invoke(api?.saveWindowPreferences?.bind(api, preferences)),
    inspectCertificate: (target: CertificateTarget): Promise<IpcResult<CertInfo>> =>
      invoke(api?.inspectCertificate?.bind(api, target)),
    trustCertificate: (input: CertificateTrustInput): Promise<IpcResult<CertInfo>> =>
      invoke(api?.trustCertificate?.bind(api, input)),
    clearLogin: (): Promise<IpcResult<void>> => invoke(api?.clearLogin?.bind(api)),
    resetAll: (): Promise<IpcResult<void>> => invoke(api?.resetAll?.bind(api)),
    getSensorConfig: (): Promise<IpcResult<SensorConfigView>> =>
      invoke(api?.getSensorConfig?.bind(api)),
    saveSensorConfig: (patch: SensorConfigPatch): Promise<IpcResult<SensorConfigView>> =>
      invoke(api?.saveSensorConfig?.bind(api, patch)),
    getSensorStatus: (): Promise<IpcResult<SensorStatus>> =>
      invoke(api?.getSensorStatus?.bind(api)),
    startSensor: (): Promise<IpcResult<SensorStatus>> => invoke(api?.startSensor?.bind(api)),
    stopSensor: (): Promise<IpcResult<SensorStatus>> => invoke(api?.stopSensor?.bind(api)),
    restartSensor: (): Promise<IpcResult<SensorStatus>> => invoke(api?.restartSensor?.bind(api)),
    testSensorLogin: (): Promise<IpcResult<SensorLoginTestResult>> =>
      invoke(api?.testSensorLogin?.bind(api)),
    openSensorPanel: (): Promise<IpcResult<void>> => invoke(api?.openSensorPanel?.bind(api)),
    openLogs: (): Promise<IpcResult<void>> => invoke(api?.openLogs?.bind(api)),
    readLogs: (lines?: number): Promise<IpcResult<LogsReadResult>> =>
      invoke(api?.readLogs?.bind(api, lines)),
    startLogStream: (options?: {
      readonly lines?: number
      readonly sources?: readonly LogSource[]
    }): Promise<IpcResult<void>> => invoke(api?.startLogStream?.bind(api, options)),
    stopLogStream: (): Promise<IpcResult<void>> => invoke(api?.stopLogStream?.bind(api)),
    onLogEvent(callback: (event: LogStreamEvent) => void): () => void {
      if (!api || typeof api.onLogEvent !== 'function') return () => undefined
      try {
        return api.onLogEvent(callback)
      } catch {
        return () => undefined
      }
    },
    openAppSettings: (): Promise<IpcResult<void>> => invoke(api?.openAppSettings?.bind(api)),
    showMain: (): Promise<IpcResult<void>> => invoke(api?.showMain?.bind(api)),
    quit: (): Promise<IpcResult<void>> => invoke(api?.quit?.bind(api)),
    onStatusChanged(callback: (status: SensorStatus) => void): () => void {
      if (!api || typeof api.onStatusChanged !== 'function') return () => undefined
      try {
        return api.onStatusChanged(callback)
      } catch {
        return () => undefined
      }
    },
  }
}
