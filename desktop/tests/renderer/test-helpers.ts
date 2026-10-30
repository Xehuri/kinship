import { createMemoryHistory, createRouter } from 'vue-router'
import type { Router } from 'vue-router'
import { routes } from '../../src/renderer/src/router'
import type {
  Bootstrap,
  NetworkApplyResult,
  NetworkLayer,
  NetworkStateView,
  SensorConfigView,
  SensorStatus,
  ServerTestResult,
} from '../../src/shared/types'

export const TEST_SERVER_URL = 'https://server.example:8768'
export const TEST_LAYER_ID = 'layer-home'

export function makeNetworkLayer(overrides: Partial<NetworkLayer> = {}): NetworkLayer {
  return {
    id: TEST_LAYER_ID,
    type: 'direct',
    name: '家庭直连',
    address: TEST_SERVER_URL,
    enabled: true,
    tlsMode: 'system',
    ...overrides,
  }
}

export function makeNetworkState(
  layers: readonly NetworkLayer[] = [makeNetworkLayer()],
  overrides: Partial<NetworkStateView> = {},
): NetworkStateView {
  const active = layers.find((layer) => layer.enabled)
  return {
    config: {
      layers: [...layers],
      ...(active !== undefined ? { activeLayerId: active.id } : {}),
    },
    statuses: layers.map((layer) => ({
      id: layer.id,
      type: layer.type,
      name: layer.name,
      address: layer.address,
      enabled: layer.enabled,
      tlsMode: layer.tlsMode,
      state: 'healthy',
      latencyMs: 42,
    })),
    ...(active !== undefined
      ? {
          activeLayerId: active.id,
          activeAddress: active.address,
          activeTlsMode: active.tlsMode,
        }
      : {}),
    ...overrides,
  }
}

export function makeNetworkApplyResult(
  state: NetworkStateView = makeNetworkState(),
  overrides: Partial<NetworkApplyResult> = {},
): NetworkApplyResult {
  return { ...state, sensorSynced: true, ...overrides }
}

export function makeSensorConfig(overrides: Partial<SensorConfigView> = {}): SensorConfigView {
  return {
    enabled: true,
    serverUrl: TEST_SERVER_URL,
    agentId: 'pc-test01',
    agentName: '我的电脑',
    username: 'axeuh',
    hasStoredPassword: false,
    rememberPassword: true,
    hasBackendToken: false,
    idleThreshold: 300,
    windowEnabled: true,
    idleEnabled: true,
    screenEnabled: true,
    sslVerify: true,
    sslCaFile: '',
    ...overrides,
  }
}

export function makeSensorStatus(overrides: Partial<SensorStatus> = {}): SensorStatus {
  return {
    state: 'stopped',
    enabled: true,
    running: false,
    port: 18888,
    ...overrides,
  }
}

export function makeBootstrap(overrides: Partial<Bootstrap> = {}): Bootstrap {
  return {
    appVersion: '1.0.0',
    electronVersion: '45.0.0',
    platform: 'win32',
    firstRun: true,
    config: {
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
    },
    sensorConfig: makeSensorConfig(),
    sensorStatus: makeSensorStatus(),
    ...overrides,
  }
}

export function makeTestResult(overrides: Partial<ServerTestResult> = {}): ServerTestResult {
  return {
    ok: true,
    latencyMs: 42,
    health: true,
    mobile: true,
    ...overrides,
  }
}

export function createTestRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes,
  })
}

export function installDesktopApi(api: Record<string, unknown>): void {
  Object.defineProperty(window, 'axeuh', {
    configurable: true,
    writable: true,
    value: api,
  })
}

export function removeDesktopApi(): void {
  Reflect.deleteProperty(window, 'axeuh')
}
