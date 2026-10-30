// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import ErrorView from '../../src/renderer/src/views/ErrorView.vue'
import { ERROR_CONTEXT_STORAGE_KEY } from '../../src/renderer/src/lib/error-context'
import {
  createTestRouter,
  installDesktopApi,
  makeTestResult,
  removeDesktopApi,
} from './test-helpers'

interface ErrorApiMock {
  retryServer: ReturnType<typeof vi.fn>
  trustCertificate: ReturnType<typeof vi.fn>
  openAppSettings: ReturnType<typeof vi.fn>
  quit: ReturnType<typeof vi.fn>
  openLogs: ReturnType<typeof vi.fn>
}

function makeErrorApi(): ErrorApiMock {
  return {
    retryServer: vi.fn().mockResolvedValue({ ok: true, data: makeTestResult() }),
    trustCertificate: vi.fn().mockResolvedValue({
      ok: true,
      data: {
        host: 'server.example',
        port: 8768,
        subject: 'CN=server.example',
        issuer: 'CN=server.example',
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: '2027-01-01T00:00:00.000Z',
        fingerprint256: 'AA:BB:CC',
        selfSigned: true,
      },
    }),
    openAppSettings: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    quit: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    openLogs: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
  }
}

async function mountError(
  api: ErrorApiMock,
  query: Record<string, string>,
  stored?: Record<string, unknown>,
): Promise<VueWrapper> {
  installDesktopApi(api)
  sessionStorage.clear()
  if (stored) {
    sessionStorage.setItem(ERROR_CONTEXT_STORAGE_KEY, JSON.stringify(stored))
  }

  const router = createTestRouter()
  await router.push({ path: '/error', query })
  await router.isReady()
  const wrapper = mount(ErrorView, {
    global: { plugins: [router] },
  })
  await flushPromises()
  return wrapper
}

afterEach(() => {
  removeDesktopApi()
  sessionStorage.clear()
})

describe('ErrorView', () => {
  it.each([
    ['UNREACHABLE', '无法连接服务器'],
    ['CERT_UNTRUSTED', '证书不受信任'],
    ['CERT_INVALID', '证书无效'],
    ['SENSOR_CONFLICT', 'PC 采集端端口冲突'],
    ['RUNTIME_MISSING', '缺少 PC 采集端运行时'],
    ['UNKNOWN', '桌面端启动失败'],
  ])('renders the %s error state', async (code, title) => {
    const wrapper = await mountError(makeErrorApi(), { code })
    expect(wrapper.text()).toContain(title)
    expect(wrapper.find('[data-test="tech-details"]').exists()).toBe(true)
  })

  it('calls retryServer and shows recovery', async () => {
    const api = makeErrorApi()
    const wrapper = await mountError(api, { code: 'UNREACHABLE', message: '连接超时' })

    await wrapper.find('[data-test="retry"]').trigger('click')
    await flushPromises()

    expect(api.retryServer).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-test="recovered"]').exists()).toBe(true)
  })

  it('confirms and trusts an untrusted certificate, then retries', async () => {
    const api = makeErrorApi()
    const wrapper = await mountError(
      api,
      {
        code: 'CERT_UNTRUSTED',
        host: 'server.example',
        port: '8768',
        subject: 'CN=server.example',
        issuer: 'CN=server.example',
        fingerprint: 'AA:BB:CC',
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: '2027-01-01T00:00:00.000Z',
      },
      { caPem: '-----BEGIN CERTIFICATE-----\nPEM\n-----END CERTIFICATE-----' },
    )

    await wrapper.find('[data-test="trust-retry"]').trigger('click')
    expect(wrapper.find('[data-test="trust-confirm"]').exists()).toBe(true)

    await wrapper.find('[data-test="confirm-trust"]').trigger('click')
    await flushPromises()

    expect(api.trustCertificate).toHaveBeenCalledWith({
      host: 'server.example',
      port: 8768,
      caPem: '-----BEGIN CERTIFICATE-----\nPEM\n-----END CERTIFICATE-----',
    })
    expect(api.retryServer).toHaveBeenCalled()
  })

  it('offers no bypass for an invalid certificate', async () => {
    const wrapper = await mountError(makeErrorApi(), {
      code: 'CERT_INVALID',
      host: 'server.example',
      port: '8768',
      fingerprint: 'AA:BB:CC',
    })

    expect(wrapper.find('[data-test="trust-retry"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('信任并重试')
    expect(wrapper.text()).not.toContain('仍然继续')
    expect(wrapper.text()).toContain('已阻止自动绕过')
  })
})
