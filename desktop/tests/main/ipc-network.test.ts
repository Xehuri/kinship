// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../src/shared/ipc'
import type { AppController } from '../../src/main/app-controller'
import type { LogStreamService } from '../../src/main/lib/log-stream'
import type { SensorPaths } from '../../src/main/lib/sensor-paths'
import type { SensorSupervisor } from '../../src/main/lib/sensor-supervisor'
import type {
  NetworkApplyResult,
  NetworkConfig,
  NetworkStateView,
  TransportConfig,
  WindowPreferences,
} from '../../src/shared/types'

const electronHarness = vi.hoisted(() => {
  type Handler = (
    event: { readonly sender: { readonly id: number } },
    ...args: unknown[]
  ) => Promise<unknown>

  const handlers = new Map<string, Handler>()
  return {
    handlers,
    ipcMain: {
      removeHandler(channel: string): void {
        handlers.delete(channel)
      },
      handle(channel: string, handler: Handler): void {
        handlers.set(channel, handler)
      },
    },
    shell: { openPath: vi.fn(async () => '') },
    app: { getPath: () => '/tmp/axeuh-ipc-network' },
    BrowserWindow: class {},
  }
})

vi.mock('electron', () => electronHarness)

const { registerIpcHandlers } = await import('../../src/main/ipc/handlers')

const TRANSPORT: TransportConfig = {
  mode: 'frp',
  endpointCandidates: [
    { name: 'ipv6', url: 'https://ipv6.example:8443', priority: 10 },
    { name: 'frp', url: 'https://frp.example:8443', priority: 90 },
  ],
  currentEndpoint: 'frp',
}

describe('network IPC', () => {
  const applyTransportConfig = vi.fn((transport: TransportConfig) => transport)
  const applyNetworkConfig = vi.fn(async () => ({
    enabled: true,
    serverUrl: 'https://frp.example:8443',
    agentId: 'default-agent',
    agentName: '',
    username: '',
    hasStoredPassword: false,
    rememberPassword: false,
    hasBackendToken: false,
    idleThreshold: 300,
    windowEnabled: true,
    idleEnabled: true,
    screenEnabled: true,
    sslVerify: true,
    sslCaFile: '',
  }))

  const network: NetworkConfig = {
    layers: [
      {
        id: 'home',
        type: 'direct',
        name: 'home',
        address: 'https://home.example:8768',
        enabled: true,
        tlsMode: 'system',
      },
    ],
    activeLayerId: 'home',
  }
  const stateView: NetworkStateView = {
    config: network,
    statuses: [
      {
        id: 'home',
        type: 'direct',
        name: 'home',
        address: 'https://home.example:8768',
        enabled: true,
        tlsMode: 'system',
        state: 'healthy',
      },
    ],
    activeLayerId: 'home',
    activeAddress: 'https://home.example:8768',
    activeTlsMode: 'system',
  }
  const applyResult: NetworkApplyResult = { ...stateView, sensorSynced: true }
  const saveNetworkLayers = vi.fn(async () => applyResult)
  const probeNetwork = vi.fn(async () => ({
    statuses: stateView.statuses,
    selectedLayerId: 'home',
  }))
  const selectNetworkLayer = vi.fn(async () => applyResult)
  const saveWindowPreferences = vi.fn(
    (preferences: WindowPreferences) => preferences,
  )
  const logStart = vi.fn()
  const logStop = vi.fn()

  const controller = {
    getSettingsWebContents: () => ({ id: 7 }),
    getTransport: () => TRANSPORT,
    applyTransportConfig,
    getNetworkState: () => stateView,
    saveNetworkLayers,
    probeNetwork,
    getNetworkApplyResult: () => applyResult,
    selectNetworkLayer,
    getWindowPreferences: () => ({ minimizeToTray: true, openAtLogin: false }),
    saveWindowPreferences,
  } as unknown as AppController
  const supervisor = { applyNetworkConfig } as unknown as SensorSupervisor
  const paths = {
    logPath: '/tmp/pc-sensor.log',
    caBundlePath: '/tmp/ca-bundle.pem',
  } as SensorPaths
  const logStream = { start: logStart, stop: logStop } as unknown as LogStreamService

  beforeEach(() => {
    electronHarness.handlers.clear()
    applyTransportConfig.mockClear()
    applyNetworkConfig.mockClear()
    saveNetworkLayers.mockClear()
    probeNetwork.mockClear()
    selectNetworkLayer.mockClear()
    saveWindowPreferences.mockClear()
    logStart.mockClear()
    logStop.mockClear()
    registerIpcHandlers({
      controller,
      supervisor,
      paths,
      logStream,
      getLastStatus: () => ({
        state: 'stopped',
        enabled: false,
        running: false,
        port: 18888,
      }),
      setLastStatus: () => undefined,
    })
  })

  it('registers both network channels', () => {
    expect(electronHarness.handlers.has(IPC.NETWORK_CONFIG_GET)).toBe(true)
    expect(electronHarness.handlers.has(IPC.NETWORK_CONFIG_SAVE)).toBe(true)
  })

  it('returns the saved transport for the settings sender', async () => {
    const handler = electronHarness.handlers.get(IPC.NETWORK_CONFIG_GET)
    expect(handler).toBeDefined()
    const result = await handler?.({ sender: { id: 7 } })
    expect(result).toEqual({ ok: true, data: TRANSPORT })
  })

  it('persists transport then synchronizes it to the sensor', async () => {
    const handler = electronHarness.handlers.get(IPC.NETWORK_CONFIG_SAVE)
    const result = await handler?.({ sender: { id: 7 } }, TRANSPORT)

    expect(applyTransportConfig).toHaveBeenCalledWith(TRANSPORT)
    expect(applyNetworkConfig).toHaveBeenCalledWith(TRANSPORT)
    expect(result).toEqual({
      ok: true,
      data: { transport: TRANSPORT, sensorSynced: true },
    })
  })

  it('keeps the desktop save when the sensor sync fails', async () => {
    applyNetworkConfig.mockRejectedValueOnce(new Error('采集端未运行'))
    const handler = electronHarness.handlers.get(IPC.NETWORK_CONFIG_SAVE)
    const result = await handler?.({ sender: { id: 7 } }, TRANSPORT)

    expect(applyTransportConfig).toHaveBeenCalledWith(TRANSPORT)
    expect(result).toEqual({
      ok: true,
      data: {
        transport: TRANSPORT,
        sensorSynced: false,
        sensorError: '采集端未运行',
      },
    })
  })

  it('rejects invalid candidates before touching the config', async () => {
    const handler = electronHarness.handlers.get(IPC.NETWORK_CONFIG_SAVE)
    const result = await handler?.(
      { sender: { id: 7 } },
      { mode: 'auto', endpointCandidates: [{ name: 'bad', url: 'http://example.com' }] },
    )

    expect(result).toEqual({ ok: false, error: '网络配置无效', code: 'INVALID_INPUT' })
    expect(applyTransportConfig).not.toHaveBeenCalled()
  })

  it('rejects a sender other than the settings view', async () => {
    const handler = electronHarness.handlers.get(IPC.NETWORK_CONFIG_GET)
    const result = await handler?.({ sender: { id: 99 } })

    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN' })
  })

  it('registers layer, probe, select and window preference channels', () => {
    for (const channel of [
      IPC.NETWORK_LAYERS_GET,
      IPC.NETWORK_LAYERS_SAVE,
      IPC.NETWORK_PROBE,
      IPC.NETWORK_LAYER_SELECT,
      IPC.WINDOW_PREFS_GET,
      IPC.WINDOW_PREFS_SAVE,
      IPC.LOGS_STREAM_START,
      IPC.LOGS_STREAM_STOP,
    ]) {
      expect(electronHarness.handlers.has(channel)).toBe(true)
    }
  })

  it('returns the network state and rejects P2P before saving', async () => {
    const getter = electronHarness.handlers.get(IPC.NETWORK_LAYERS_GET)
    await expect(getter?.({ sender: { id: 7 } })).resolves.toEqual({
      ok: true,
      data: stateView,
    })

    const saver = electronHarness.handlers.get(IPC.NETWORK_LAYERS_SAVE)
    const result = await saver?.(
      { sender: { id: 7 } },
      {
        layers: [
          {
            id: 'p2p',
            type: 'p2p',
            name: 'p2p',
            address: 'https://p2p.example:9000',
            enabled: true,
            tlsMode: 'system',
          },
        ],
      },
    )
    expect(result).toMatchObject({ ok: false, code: 'P2P_NOT_AVAILABLE' })
    expect(saveNetworkLayers).not.toHaveBeenCalled()
  })

  it('saves layers, probes and selects through the controller', async () => {
    const saver = electronHarness.handlers.get(IPC.NETWORK_LAYERS_SAVE)
    await expect(saver?.({ sender: { id: 7 } }, network)).resolves.toEqual({
      ok: true,
      data: applyResult,
    })
    expect(saveNetworkLayers).toHaveBeenCalledWith(network)

    const probe = electronHarness.handlers.get(IPC.NETWORK_PROBE)
    await expect(probe?.({ sender: { id: 7 } })).resolves.toEqual({
      ok: true,
      data: applyResult,
    })
    expect(probeNetwork).toHaveBeenCalledWith({ reason: 'probe', reloadWindow: true })

    const select = electronHarness.handlers.get(IPC.NETWORK_LAYER_SELECT)
    await expect(select?.({ sender: { id: 7 } }, 'home')).resolves.toEqual({
      ok: true,
      data: applyResult,
    })
    expect(selectNetworkLayer).toHaveBeenCalledWith('home')
  })

  it('validates and saves window preferences', async () => {
    const getter = electronHarness.handlers.get(IPC.WINDOW_PREFS_GET)
    await expect(getter?.({ sender: { id: 7 } })).resolves.toEqual({
      ok: true,
      data: { minimizeToTray: true, openAtLogin: false },
    })

    const saver = electronHarness.handlers.get(IPC.WINDOW_PREFS_SAVE)
    await expect(
      saver?.({ sender: { id: 7 } }, { minimizeToTray: 'yes', openAtLogin: false }),
    ).resolves.toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    await expect(
      saver?.({ sender: { id: 7 } }, { minimizeToTray: false, openAtLogin: true }),
    ).resolves.toEqual({
      ok: true,
      data: { minimizeToTray: false, openAtLogin: true },
    })
    expect(saveWindowPreferences).toHaveBeenCalledWith({
      minimizeToTray: false,
      openAtLogin: true,
    })
  })

  it('starts and stops the log stream with validated sources', async () => {
    const start = electronHarness.handlers.get(IPC.LOGS_STREAM_START)
    const sender = {
      id: 7,
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn(),
    }
    await expect(
      start?.({ sender }, { lines: 50, sources: ['desktop'] }),
    ).resolves.toEqual({ ok: true, data: undefined })
    expect(logStart).toHaveBeenCalledWith(sender, { lines: 50, sources: ['desktop'] })

    await expect(
      start?.({ sender }, { sources: ['nope'] }),
    ).resolves.toMatchObject({ ok: false, code: 'INVALID_INPUT' })

    const stop = electronHarness.handlers.get(IPC.LOGS_STREAM_STOP)
    await expect(stop?.({ sender })).resolves.toEqual({ ok: true, data: undefined })
    expect(logStop).toHaveBeenCalled()
  })
})
