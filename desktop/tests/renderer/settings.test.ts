// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import SettingsView from '../../src/renderer/src/views/SettingsView.vue'
import type {
  LogStreamEvent,
  NetworkApplyResult,
  NetworkConfig,
  WindowPreferences,
} from '../../src/shared/types'
import {
  TEST_LAYER_ID,
  TEST_SERVER_URL,
  createTestRouter,
  installDesktopApi,
  makeBootstrap,
  makeNetworkApplyResult,
  makeNetworkLayer,
  makeNetworkState,
  makeSensorConfig,
  makeSensorStatus,
  removeDesktopApi,
} from './test-helpers'

interface SettingsApiMock {
  getBootstrap: ReturnType<typeof vi.fn>
  getNetworkLayers: ReturnType<typeof vi.fn>
  saveNetworkLayers: ReturnType<typeof vi.fn>
  probeNetwork: ReturnType<typeof vi.fn>
  selectNetworkLayer: ReturnType<typeof vi.fn>
  getWindowPreferences: ReturnType<typeof vi.fn>
  saveWindowPreferences: ReturnType<typeof vi.fn>
  getSensorStatus: ReturnType<typeof vi.fn>
  onStatusChanged: ReturnType<typeof vi.fn>
  saveSensorConfig: ReturnType<typeof vi.fn>
  openSensorPanel: ReturnType<typeof vi.fn>
  restartSensor: ReturnType<typeof vi.fn>
  testSensorLogin: ReturnType<typeof vi.fn>
  openLogs: ReturnType<typeof vi.fn>
  readLogs: ReturnType<typeof vi.fn>
  startLogStream: ReturnType<typeof vi.fn>
  stopLogStream: ReturnType<typeof vi.fn>
  onLogEvent: ReturnType<typeof vi.fn>
  inspectCertificate: ReturnType<typeof vi.fn>
  trustCertificate: ReturnType<typeof vi.fn>
  clearLogin: ReturnType<typeof vi.fn>
  resetAll: ReturnType<typeof vi.fn>
  showMain: ReturnType<typeof vi.fn>
}

function networkResult(network: NetworkConfig): NetworkApplyResult {
  const state = makeNetworkState(network.layers)
  return makeNetworkApplyResult({ ...state, config: network })
}

function makeSettingsApi(): SettingsApiMock {
  const layer = makeNetworkLayer()
  const sensorConfig = makeSensorConfig({ hasStoredPassword: true, username: 'axeuh' })
  const bootstrap = makeBootstrap({
    firstRun: false,
    config: {
      schemaVersion: 3,
      server: { url: TEST_SERVER_URL, allowUntrustedCa: false },
      transport: { mode: 'auto', endpointCandidates: [] },
      network: { layers: [layer], activeLayerId: TEST_LAYER_ID },
      window: { minimizeToTray: true, openAtLogin: false },
    },
    sensorConfig,
    sensorStatus: makeSensorStatus(),
  })

  return {
    getBootstrap: vi.fn().mockResolvedValue({ ok: true, data: bootstrap }),
    getNetworkLayers: vi.fn().mockResolvedValue({
      ok: true,
      data: makeNetworkState([layer]),
    }),
    saveNetworkLayers: vi.fn().mockImplementation(async (network: NetworkConfig) => ({
      ok: true,
      data: networkResult(network),
    })),
    probeNetwork: vi.fn().mockResolvedValue({
      ok: true,
      data: makeNetworkApplyResult(),
    }),
    selectNetworkLayer: vi.fn().mockResolvedValue({
      ok: true,
      data: makeNetworkApplyResult(),
    }),
    getWindowPreferences: vi.fn().mockResolvedValue({
      ok: true,
      data: { minimizeToTray: true, openAtLogin: false },
    }),
    saveWindowPreferences: vi.fn().mockImplementation(async (prefs: WindowPreferences) => ({
      ok: true,
      data: prefs,
    })),
    getSensorStatus: vi.fn().mockResolvedValue({
      ok: true,
      data: makeSensorStatus({
        state: 'running',
        running: true,
        loggedIn: true,
        queueSize: 3,
      }),
    }),
    onStatusChanged: vi.fn(() => vi.fn()),
    saveSensorConfig: vi.fn().mockImplementation(async (patch: Record<string, unknown>) => ({
      ok: true,
      data: { ...sensorConfig, ...patch },
    })),
    openSensorPanel: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    restartSensor: vi.fn().mockResolvedValue({ ok: true, data: makeSensorStatus() }),
    testSensorLogin: vi.fn().mockResolvedValue({
      ok: true,
      data: {
        success: true,
        loggedIn: true,
        message: '登录成功',
        status: makeSensorStatus({ state: 'running', running: true, loggedIn: true }),
      },
    }),
    openLogs: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    readLogs: vi.fn().mockResolvedValue({
      ok: true,
      data: {
        desktop: { path: '/logs/desktop.log', lines: ['desktop fallback line'] },
        sensor: { path: '/logs/sensor.log', lines: ['sensor fallback line'] },
      },
    }),
    startLogStream: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    stopLogStream: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    onLogEvent: vi.fn(() => vi.fn()),
    inspectCertificate: vi.fn().mockResolvedValue({ ok: true, data: { error: 'not used' } }),
    trustCertificate: vi.fn().mockResolvedValue({ ok: true, data: { error: 'not used' } }),
    clearLogin: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    resetAll: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    showMain: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  }
}

async function mountSettings(api: SettingsApiMock): Promise<VueWrapper> {
  installDesktopApi(api)
  const router = createTestRouter()
  await router.push('/settings')
  await router.isReady()
  const wrapper = mount(SettingsView, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

afterEach(() => {
  removeDesktopApi()
  sessionStorage.clear()
})

describe('SettingsView', () => {
  it('renders bootstrap details, the network editor and the live sensor status', async () => {
    const api = makeSettingsApi()
    const wrapper = await mountSettings(api)

    expect(wrapper.text()).toContain('桌面设置')
    expect(wrapper.text()).toContain('运行中')
    expect(wrapper.text()).toContain('已登录')
    expect(wrapper.text()).toContain('待上传队列')
    expect(wrapper.text()).toContain('3 条')
    expect(wrapper.text()).toContain('1.0.0')
    expect(wrapper.text()).toContain('Electron')
    expect(wrapper.find('[data-test="network-editor"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="active-connection"]').text()).toContain('server.example:8768')
    expect(wrapper.text()).not.toContain('配置接口将在后续版本开放')
    expect(wrapper.find('[data-test="nav-server"]').exists()).toBe(false)
  })

  it('saves edited network layers from the editor', async () => {
    const api = makeSettingsApi()
    const wrapper = await mountSettings(api)

    await wrapper.find('[data-test="network-add-frp"]').trigger('click')
    await wrapper.find('[data-test="network-layer-address-1"]').setValue('https://frp.example:8443')
    await wrapper.find('[data-test="network-save"]').trigger('click')
    await flushPromises()

    const network = api.saveNetworkLayers.mock.calls.at(-1)?.[0] as NetworkConfig
    expect(network.layers.map((layer) => layer.type)).toEqual(['direct', 'frp'])
    expect(network.layers[1]?.address).toBe('https://frp.example:8443')
    expect(wrapper.find('[data-test="network-layer-status-1"]').text()).toContain('可用')
  })

  it('re-probes the saved network and selects a layer manually', async () => {
    const api = makeSettingsApi()
    const wrapper = await mountSettings(api)

    await wrapper.find('[data-test="network-probe"]').trigger('click')
    await flushPromises()
    expect(api.probeNetwork).toHaveBeenCalledTimes(1)

    await wrapper.find('[data-test="network-layer-expand-0"]').trigger('click')
    await wrapper.find('[data-test="network-layer-select-0"]').trigger('click')
    await flushPromises()
    expect(api.selectNetworkLayer).toHaveBeenCalledWith(TEST_LAYER_ID)
  })

  it('surfaces a no-healthy-layer error while keeping the editor visible', async () => {
    const api = makeSettingsApi()
    api.saveNetworkLayers.mockImplementation(async (network: NetworkConfig) => {
      const state = makeNetworkState(network.layers)
      return {
        ok: true,
        data: {
          ...state,
          config: network,
          statuses: state.statuses.map((status) => ({
            ...status,
            state: 'unhealthy',
            error: '连接超时',
            code: 'TIMEOUT',
          })),
          error: '无法连接服务器：所有网络层均不可用',
          code: 'NO_HEALTHY_LAYER',
          sensorSynced: true,
        },
      }
    })
    const wrapper = await mountSettings(api)

    await wrapper.find('[data-test="network-save"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="network-error"]').text()).toContain('所有网络层均不可用')
    expect(wrapper.find('[data-test="network-layer-status-0"]').text()).toContain('不可用')
    expect(wrapper.find('[data-test="network-editor"]').exists()).toBe(true)
  })

  it('shows a fallback notice when the network status API is unavailable', async () => {
    const api = makeSettingsApi()
    api.getNetworkLayers.mockResolvedValue({
      ok: false,
      code: 'API_UNAVAILABLE',
      error: '桌面 API 不可用',
    })
    const wrapper = await mountSettings(api)

    expect(wrapper.find('[data-test="network-fallback-warning"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="network-layer-status-0"]').text()).toContain('未检测')
  })

  it('saves startup preferences immediately when toggled', async () => {
    const api = makeSettingsApi()
    const wrapper = await mountSettings(api)

    await wrapper.find('[data-test="startup-minimize-to-tray"]').trigger('click')
    await flushPromises()

    expect(api.saveWindowPreferences).toHaveBeenLastCalledWith({
      minimizeToTray: false,
      openAtLogin: false,
    })

    await wrapper.find('[data-test="startup-open-at-login"]').trigger('click')
    await flushPromises()

    expect(api.saveWindowPreferences).toHaveBeenLastCalledWith({
      minimizeToTray: false,
      openAtLogin: true,
    })
  })

  it('reverts a startup toggle and shows the error when saving fails', async () => {
    const api = makeSettingsApi()
    api.saveWindowPreferences.mockResolvedValue({
      ok: false,
      error: '登录项写入失败',
      code: 'SAVE_FAILED',
    })
    const wrapper = await mountSettings(api)

    await wrapper.find('[data-test="startup-minimize-to-tray"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="startup-error"]').text()).toContain('登录项写入失败')
    expect(
      wrapper.find('[data-test="startup-minimize-to-tray"]').attributes('aria-checked'),
    ).toBe('true')
  })

  it('streams log events into the viewer, appends lines and stops on close', async () => {
    const api = makeSettingsApi()
    const listeners: ((event: LogStreamEvent) => void)[] = []
    api.onLogEvent.mockImplementation((callback: (event: LogStreamEvent) => void) => {
      listeners.push(callback)
      return vi.fn()
    })
    const wrapper = await mountSettings(api)

    await wrapper.find('[data-test="open-logs-settings"]').trigger('click')
    await flushPromises()

    expect(api.startLogStream).toHaveBeenCalledWith({ lines: 300 })
    expect(listeners).toHaveLength(1)

    listeners[0]?.({
      source: 'desktop',
      type: 'snapshot',
      path: '/logs/desktop.log',
      lines: ['desktop line one'],
    })
    listeners[0]?.({
      source: 'sensor',
      type: 'snapshot',
      path: '/logs/sensor.log',
      lines: ['sensor line one'],
    })
    await flushPromises()

    expect(wrapper.find('[data-test="log-path-desktop"]').text()).toContain('desktop.log')
    expect(wrapper.find('[data-test="log-content"]').text()).toContain('desktop line one')

    listeners[0]?.({
      source: 'desktop',
      type: 'append',
      path: '/logs/desktop.log',
      lines: ['desktop line two'],
    })
    await flushPromises()
    expect(wrapper.find('[data-test="log-content"]').text()).toContain('desktop line two')

    await wrapper.find('[data-test="log-tab-sensor"]').trigger('click')
    expect(wrapper.find('[data-test="log-content"]').text()).toContain('sensor line one')

    await wrapper.find('[data-test="log-close"]').trigger('click')
    await flushPromises()
    expect(api.stopLogStream).toHaveBeenCalled()
  })

  it('falls back to reading logs when the stream API is unavailable', async () => {
    const api = makeSettingsApi()
    api.startLogStream.mockResolvedValue({
      ok: false,
      code: 'API_UNAVAILABLE',
      error: '桌面 API 不可用',
    })
    const wrapper = await mountSettings(api)

    await wrapper.find('[data-test="open-logs-settings"]').trigger('click')
    await flushPromises()

    expect(api.readLogs).toHaveBeenCalledWith(300)
    expect(wrapper.find('[data-test="log-content"]').text()).toContain('desktop fallback line')
  })

  it('saves the sensor config with the active network layer address', async () => {
    const api = makeSettingsApi()
    const wrapper = await mountSettings(api)

    await wrapper.find('[data-test="save-all"]').trigger('click')
    await flushPromises()

    expect(api.saveSensorConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: TEST_SERVER_URL,
        agentId: 'pc-test01',
        agentName: '我的电脑',
        idleThreshold: 300,
        sslVerify: true,
      }),
    )
  })

  it('keeps the sensor settings saved when the runtime is missing', async () => {
    const api = makeSettingsApi()
    api.saveSensorConfig.mockResolvedValue({
      ok: false,
      code: 'RUNTIME_MISSING',
      error: 'missing runtime',
    })
    const wrapper = await mountSettings(api)

    await wrapper.find('[data-test="save-all"]').trigger('click')
    await flushPromises()

    const warning = wrapper.find('[data-test="sensor-runtime-warning"]')
    expect(warning.exists()).toBe(true)
    expect(warning.text()).toContain('missing runtime')
  })

  it('switches between credential and token authentication modes', async () => {
    const api = makeSettingsApi()
    const wrapper = await mountSettings(api)

    expect(wrapper.find('[data-test="sensor-username"]').exists()).toBe(true)

    await wrapper.find('[data-test="auth-token"]').trigger('click')
    expect(wrapper.find('[data-test="sensor-token"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="sensor-username"]').exists()).toBe(false)

    await wrapper.find('[data-test="auth-credentials"]').trigger('click')
    expect(wrapper.find('[data-test="sensor-username"]').exists()).toBe(true)
  })

  it('opens the sensor panel through the desktop API', async () => {
    const api = makeSettingsApi()
    const wrapper = await mountSettings(api)

    await wrapper.find('[data-test="open-panel"]').trigger('click')
    await flushPromises()

    expect(api.openSensorPanel).toHaveBeenCalledTimes(1)
  })

  it('surfaces an auth failure in the persistent health strip and status card', async () => {
    const api = makeSettingsApi()
    api.getSensorStatus.mockResolvedValue({
      ok: true,
      data: makeSensorStatus({
        state: 'running',
        running: true,
        loggedIn: false,
        authError: '用户名或密码错误',
        queueSize: 2,
      }),
    })
    const wrapper = await mountSettings(api)

    const strip = wrapper.find('[data-test="health-strip"]')
    expect(strip.exists()).toBe(true)
    expect(strip.attributes('role')).toBe('alert')
    expect(strip.text()).toContain('登录失败')
    expect(strip.text()).toContain('用户名或密码错误')

    const alert = wrapper.find('[data-test="sensor-auth-alert"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain('用户名或密码错误')
  })

  it('runs a login test, renders the success result and refreshes the sensor status', async () => {
    const api = makeSettingsApi()
    const wrapper = await mountSettings(api)
    expect(api.getSensorStatus).toHaveBeenCalledTimes(1)

    await wrapper.find('[data-test="test-login"]').trigger('click')
    await flushPromises()

    expect(api.testSensorLogin).toHaveBeenCalledTimes(1)
    const result = wrapper.find('[data-test="login-test-result"]')
    expect(result.exists()).toBe(true)
    expect(result.attributes('data-state')).toBe('ok')
    expect(result.text()).toContain('登录成功')
    expect(api.getSensorStatus).toHaveBeenCalledTimes(2)
  })

  it('reports a clear error when the desktop API cannot test the login', async () => {
    const api = makeSettingsApi()
    const withoutLoginTest = { ...api } as Partial<SettingsApiMock>
    delete withoutLoginTest.testSensorLogin
    const wrapper = await mountSettings(withoutLoginTest as SettingsApiMock)

    await wrapper.find('[data-test="test-login"]').trigger('click')
    await flushPromises()

    const result = wrapper.find('[data-test="login-test-result"]')
    expect(result.exists()).toBe(true)
    expect(result.text()).toContain('当前桌面端不支持测试登录')
  })

  it('returns to the main window from the persistent rail action', async () => {
    const api = makeSettingsApi()
    const wrapper = await mountSettings(api)

    await wrapper.find('[data-test="back-to-main-rail"]').trigger('click')
    await flushPromises()

    expect(api.showMain).toHaveBeenCalledTimes(1)
  })

  it('opens the reset warning without calling the API', async () => {
    const api = makeSettingsApi()
    const wrapper = await mountSettings(api)

    await wrapper.find('[data-test="reset-all"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="reset-confirm"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="reset-continue"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('此操作不可撤销')
    expect(wrapper.text()).toContain('运行日志会保留')
    expect(api.resetAll).not.toHaveBeenCalled()
  })

  it('requires the exact phrase and calls resetAll once from the final step', async () => {
    const api = makeSettingsApi()
    const wrapper = await mountSettings(api)

    await wrapper.find('[data-test="reset-all"]').trigger('click')
    await wrapper.find('[data-test="reset-continue"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="reset-confirm"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="reset-phrase"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="reset-final"]').attributes('disabled')).toBeDefined()
    expect(api.resetAll).not.toHaveBeenCalled()

    await wrapper.find('[data-test="reset-phrase"]').setValue('重置')
    expect(wrapper.find('[data-test="reset-final"]').attributes('disabled')).toBeUndefined()

    await wrapper.find('[data-test="reset-final"]').trigger('click')
    await flushPromises()

    expect(api.resetAll).toHaveBeenCalledTimes(1)
  })

  it('cancels the reset without calling the API', async () => {
    const api = makeSettingsApi()
    const wrapper = await mountSettings(api)

    await wrapper.find('[data-test="reset-all"]').trigger('click')
    await wrapper.find('[data-test="reset-cancel"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="reset-dialog"]').exists()).toBe(false)
    expect(api.resetAll).not.toHaveBeenCalled()
  })

  it('keeps the reset dialog open and shows the API error on failure', async () => {
    const api = makeSettingsApi()
    api.resetAll.mockResolvedValue({
      ok: false,
      error: '重置失败：配置文件被占用',
      code: 'RESET_FAILED',
    })
    const wrapper = await mountSettings(api)

    await wrapper.find('[data-test="reset-all"]').trigger('click')
    await wrapper.find('[data-test="reset-continue"]').trigger('click')
    await wrapper.find('[data-test="reset-phrase"]').setValue('重置')
    await wrapper.find('[data-test="reset-final"]').trigger('click')
    await flushPromises()

    expect(api.resetAll).toHaveBeenCalledTimes(1)
    const error = wrapper.find('[data-test="reset-error"]')
    expect(error.exists()).toBe(true)
    expect(error.text()).toContain('重置失败：配置文件被占用')
    expect(wrapper.find('[data-test="reset-dialog"]').exists()).toBe(true)
  })
})
