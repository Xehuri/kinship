// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import SetupView from '../../src/renderer/src/views/SetupView.vue'
import type { NetworkApplyResult, NetworkConfig } from '../../src/shared/types'
import {
  TEST_SERVER_URL,
  createTestRouter,
  installDesktopApi,
  makeBootstrap,
  makeNetworkApplyResult,
  makeNetworkLayer,
  makeNetworkState,
  makeSensorConfig,
  removeDesktopApi,
} from './test-helpers'

interface SetupApiMock {
  getBootstrap: ReturnType<typeof vi.fn>
  getNetworkLayers: ReturnType<typeof vi.fn>
  saveNetworkLayers: ReturnType<typeof vi.fn>
  probeNetwork: ReturnType<typeof vi.fn>
  selectNetworkLayer: ReturnType<typeof vi.fn>
  saveSensorConfig: ReturnType<typeof vi.fn>
  inspectCertificate: ReturnType<typeof vi.fn>
  trustCertificate: ReturnType<typeof vi.fn>
  openSensorPanel: ReturnType<typeof vi.fn>
  restartSensor: ReturnType<typeof vi.fn>
  showMain: ReturnType<typeof vi.fn>
}

function healthyResult(network: NetworkConfig): NetworkApplyResult {
  const state = makeNetworkState(network.layers)
  return makeNetworkApplyResult({ ...state, config: network })
}

function makeApi(bootstrap = makeBootstrap()): SetupApiMock {
  return {
    getBootstrap: vi.fn().mockResolvedValue({ ok: true, data: bootstrap }),
    getNetworkLayers: vi.fn().mockResolvedValue({
      ok: true,
      data: makeNetworkState(bootstrap.config.network.layers),
    }),
    saveNetworkLayers: vi
      .fn()
      .mockImplementation(async (network: NetworkConfig) => ({
        ok: true,
        data: healthyResult(network),
      })),
    probeNetwork: vi.fn().mockResolvedValue({
      ok: true,
      data: makeNetworkApplyResult(),
    }),
    selectNetworkLayer: vi.fn().mockResolvedValue({
      ok: true,
      data: makeNetworkApplyResult(),
    }),
    saveSensorConfig: vi.fn().mockImplementation(async (patch: Record<string, unknown>) => ({
      ok: true,
      data: { ...makeSensorConfig(), ...patch },
    })),
    inspectCertificate: vi.fn(),
    trustCertificate: vi.fn(),
    openSensorPanel: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    restartSensor: vi.fn().mockResolvedValue({ ok: true, data: makeBootstrap().sensorStatus }),
    showMain: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  }
}

async function mountSetup(api: SetupApiMock | Record<string, unknown>): Promise<VueWrapper> {
  installDesktopApi(api)
  const router = createTestRouter()
  await router.push('/setup')
  await router.isReady()
  const wrapper = mount(SetupView, {
    global: { plugins: [router] },
  })
  await flushPromises()
  return wrapper
}

async function fillFirstAddress(wrapper: VueWrapper, address = TEST_SERVER_URL): Promise<void> {
  await wrapper.find('[data-test="network-layer-address-0"]').setValue(address)
}

function savedLayers(api: SetupApiMock): NetworkConfig {
  const call = api.saveNetworkLayers.mock.calls.at(-1)?.[0] as NetworkConfig | undefined
  if (call === undefined) throw new Error('saveNetworkLayers was not called')
  return call
}

afterEach(() => {
  removeDesktopApi()
  sessionStorage.clear()
})

describe('SetupView', () => {
  it('blocks progression when the network layer address is empty', async () => {
    const api = makeApi()
    const wrapper = await mountSetup(api)

    await wrapper.find('[data-test="next-step"]').trigger('click')
    await flushPromises()

    expect(api.saveNetworkLayers).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('请输入服务器地址')
    expect(wrapper.find('[data-test="setup-network-step"]').exists()).toBe(true)
  })

  it('saves network layers before the sensor and uses the active address', async () => {
    const api = makeApi()
    const wrapper = await mountSetup(api)

    await fillFirstAddress(wrapper)
    await wrapper.find('[data-test="next-step"]').trigger('click')
    await flushPromises()

    const network = savedLayers(api)
    expect(network.layers[0]).toMatchObject({
      type: 'direct',
      address: TEST_SERVER_URL,
      enabled: true,
      tlsMode: 'system',
    })
    expect(wrapper.text()).toContain('配置 PC 采集端')
    expect(
      (wrapper.find('#scf-server-url').element as HTMLInputElement).value,
    ).toBe(TEST_SERVER_URL)

    await wrapper.find('[data-test="finish-setup"]').trigger('click')
    await flushPromises()

    expect(api.saveSensorConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        serverUrl: TEST_SERVER_URL,
        agentName: '我的电脑',
        idleThreshold: 300,
        sslVerify: true,
      }),
    )
    expect(wrapper.find('[data-test="setup-success"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="enter-main"]').exists()).toBe(true)
  })

  it('keeps step one and shows statuses when no layer is healthy', async () => {
    const api = makeApi()
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
            latencyMs: 12,
            error: '连接超时',
            code: 'TIMEOUT',
          })),
          error: '无法连接服务器：所有网络层均不可用（家庭直连: 连接超时）',
          code: 'NO_HEALTHY_LAYER',
          sensorSynced: true,
        },
      }
    })
    const wrapper = await mountSetup(api)

    await fillFirstAddress(wrapper)
    await wrapper.find('[data-test="next-step"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="setup-network-step"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="network-layer-status-0"]').text()).toContain('不可用')
    expect(wrapper.find('[data-test="network-error"]').text()).toContain('所有网络层均不可用')
    expect(api.saveSensorConfig).not.toHaveBeenCalled()
  })

  it('adds an FRP layer and saves layers in reordered order', async () => {
    const api = makeApi()
    const wrapper = await mountSetup(api)

    await fillFirstAddress(wrapper)
    await wrapper.find('[data-test="network-add-frp"]').trigger('click')
    await wrapper.find('[data-test="network-layer-address-1"]').setValue('https://frp.example:8443')
    await wrapper.find('[data-test="network-layer-up-1"]').trigger('click')
    await wrapper.find('[data-test="next-step"]').trigger('click')
    await flushPromises()

    const network = savedLayers(api)
    expect(network.layers.map((layer) => layer.type)).toEqual(['frp', 'direct'])
    expect(network.layers[0]?.address).toBe('https://frp.example:8443')
  })

  it('requires an explicit acknowledgement for insecure TLS on that layer only', async () => {
    const api = makeApi()
    const wrapper = await mountSetup(api)

    await fillFirstAddress(wrapper)
    await wrapper.find('[data-test="network-layer-tls-0"]').setValue('insecure')
    await wrapper.find('[data-test="next-step"]').trigger('click')
    await flushPromises()

    expect(api.saveNetworkLayers).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('请先确认跳过证书校验的风险')

    await wrapper.find('[data-test="network-layer-insecure-ack-0"]').setValue(true)
    await wrapper.find('[data-test="next-step"]').trigger('click')
    await flushPromises()

    expect(savedLayers(api).layers[0]?.tlsMode).toBe('insecure')
  })

  it('inspects and trusts a certificate, then saves the normalized fingerprint', async () => {
    const api = makeApi()
    const fingerprint = 'A'.repeat(64)
    const cert = {
      host: 'server.example',
      port: 8768,
      subject: 'CN=server.example',
      issuer: 'CN=Axeuh Local CA',
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2027-01-01T00:00:00.000Z',
      fingerprint256: fingerprint,
      selfSigned: true,
      caPem: 'PEM',
    }
    api.inspectCertificate.mockResolvedValue({ ok: true, data: cert })
    api.trustCertificate.mockResolvedValue({ ok: true, data: cert })
    const wrapper = await mountSetup(api)

    await fillFirstAddress(wrapper)
    await wrapper.find('[data-test="network-layer-tls-0"]').setValue('pinned')
    await wrapper.find('[data-test="network-layer-inspect-0"]').trigger('click')
    await flushPromises()

    expect(api.inspectCertificate).toHaveBeenCalledWith({ host: 'server.example', port: 8768 })
    await wrapper.find('[data-test="network-layer-trust-0"]').trigger('click')
    await flushPromises()

    expect(api.trustCertificate).toHaveBeenCalledWith({
      host: 'server.example',
      port: 8768,
      caPem: 'PEM',
    })
    expect(
      (wrapper.find('[data-test="network-layer-fingerprint-0"]').element as HTMLInputElement).value,
    ).toBe('a'.repeat(64))

    await wrapper.find('[data-test="next-step"]').trigger('click')
    await flushPromises()
    expect(savedLayers(api).layers[0]).toMatchObject({
      tlsMode: 'pinned',
      fingerprint256: 'a'.repeat(64),
    })
  })

  it('never saves P2P and keeps the add option disabled', async () => {
    const api = makeApi()
    const wrapper = await mountSetup(api)

    expect(wrapper.find('[data-test="network-add-p2p"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-test="network-p2p-placeholder"]').text()).toContain('P2P（未接入，后续统一做）')

    await fillFirstAddress(wrapper)
    await wrapper.find('[data-test="next-step"]').trigger('click')
    await flushPromises()

    expect(savedLayers(api).layers.some((layer) => layer.type === 'p2p')).toBe(false)
  })

  it('treats a missing sensor runtime as a non-blocking warning', async () => {
    const api = makeApi()
    api.saveSensorConfig.mockResolvedValue({
      ok: false,
      code: 'RUNTIME_MISSING',
      error: 'missing runtime',
    })
    const wrapper = await mountSetup(api)

    await fillFirstAddress(wrapper)
    await wrapper.find('[data-test="next-step"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-test="finish-setup"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="setup-success"]').exists()).toBe(true)
    const warning = wrapper.find('[data-test="runtime-warning"]')
    expect(warning.exists()).toBe(true)
    expect(warning.text()).toContain('missing runtime')
    expect(wrapper.text()).not.toContain('保存失败')
  })

  it('shows the main window through the desktop API instead of a DOM event', async () => {
    const api = makeApi()
    const wrapper = await mountSetup(api)

    await fillFirstAddress(wrapper)
    await wrapper.find('[data-test="next-step"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-test="finish-setup"]').trigger('click')
    await flushPromises()

    const legacyEventListener = vi.fn()
    window.addEventListener('axeuh:enter-main', legacyEventListener)
    await wrapper.find('[data-test="enter-main"]').trigger('click')
    await flushPromises()
    window.removeEventListener('axeuh:enter-main', legacyEventListener)

    expect(api.showMain).toHaveBeenCalledTimes(1)
    expect(legacyEventListener).not.toHaveBeenCalled()
  })

  it('degrades gracefully when the desktop API is unavailable', async () => {
    removeDesktopApi()
    const router = createTestRouter()
    await router.push('/setup')
    await router.isReady()
    const wrapper = mount(SetupView, { global: { plugins: [router] } })
    await flushPromises()

    expect(wrapper.text()).toContain('无法读取已有配置')
    expect(wrapper.text()).toContain('桌面 API 不可用')

    await fillFirstAddress(wrapper)
    await wrapper.find('[data-test="next-step"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="setup-network-step"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="network-error"]').text()).toContain('桌面 API 不可用')
  })
})
