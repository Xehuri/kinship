/// <reference types="vitest/globals" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import type { ClientCatalog, ClientEntry, OtaTicket } from '@/api/system'

const apiMock = vi.hoisted(() => ({
  getClientCatalog: vi.fn(),
  createOtaTicket: vi.fn(),
}))

const ticketMock = vi.hoisted(() => ({
  fetchWsTicket: vi.fn(),
}))

interface OnboardingMock {
  error: Ref<{ message: string } | null>
  recordStep: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
}

const onboardingMock = vi.hoisted(() => ({}) as OnboardingMock)

vi.mock('@/api/system', () => ({
  getClientCatalog: apiMock.getClientCatalog,
  createOtaTicket: apiMock.createOtaTicket,
}))

vi.mock('@/api/ticket', () => ({
  fetchWsTicket: ticketMock.fetchWsTicket,
}))

vi.mock('@/composables/useOnboarding', async () => {
  const { ref } = await import('vue')
  onboardingMock.error = ref<{ message: string } | null>(null)
  onboardingMock.recordStep = vi.fn().mockResolvedValue({})
  onboardingMock.refresh = vi.fn().mockResolvedValue(undefined)
  return {
    useOnboarding: () => ({
      error: onboardingMock.error,
      recordStep: onboardingMock.recordStep,
      refresh: onboardingMock.refresh,
    }),
  }
})

import ClientsStep from '@/components/onboarding/steps/ClientsStep.vue'

enableAutoUnmount(afterEach)

const ANDROID_SHA = 'a'.repeat(64)
const DESKTOP_SHA = 'b'.repeat(64)

function makeEntry(kind: 'android' | 'desktop', overrides: Partial<ClientEntry> = {}): ClientEntry {
  const filename = kind === 'android' ? 'Kinship-1.4.2-debug.apk' : 'Kinship-Desktop-Setup-1.0.0-x64.exe'
  return {
    kind,
    available: true,
    action: 'download',
    source: 'local',
    url: kind === 'android' ? '/api/ota/download' : '/api/clients/desktop/download',
    page_url: 'https://github.com/Xehuri/kinship/releases/tag/onboarding-v1.0.0',
    filename: kind === 'android' ? 'app-debug.apk' : 'Kinship-Desktop-Setup-1.0.0-x64.exe',
    download_filename:
      kind === 'android' ? 'Kinship-1.4.2-debug.apk' : 'Kinship-Desktop-Setup-1.0.0-x64.exe',
    expected_filename: filename,
    size: kind === 'android' ? 88_600_000 : 112_000_000,
    sha256: kind === 'android' ? ANDROID_SHA : DESKTOP_SHA,
    version: kind === 'android' ? '1.4.2' : '1.0.0',
    variant: kind === 'android' ? 'debug' : 'release',
    debug: kind === 'android' ? true : false,
    label: kind === 'android' ? 'debug build' : 'release build',
    fallback_reason: null,
    ...overrides,
  }
}

function makeCatalog(overrides: Partial<ClientCatalog> = {}): ClientCatalog {
  return {
    android: makeEntry('android'),
    desktop: makeEntry('desktop'),
    connection: {
      host: 'health.example.test',
      https: { enabled: true, port: 8768 },
      http: { enabled: true, port: 8769 },
    },
    ...overrides,
  }
}

function makeTicket(ticket: string): OtaTicket {
  return {
    ticket,
    url: `/api/ota/download?ticket=${ticket}`,
    expires_at: 1,
    expires_in: 60,
    filename: 'Kinship-1.4.2-debug.apk',
    source_filename: 'app-debug.apk',
    sha256: ANDROID_SHA,
    size: 88_600_000,
  }
}

async function mountStep(catalog: ClientCatalog = makeCatalog()) {
  apiMock.getClientCatalog.mockResolvedValue(catalog)
  const wrapper = mount(ClientsStep)
  await flushPromises()
  return wrapper
}

describe('ClientsStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMock.getClientCatalog.mockReset().mockResolvedValue(makeCatalog())
    apiMock.createOtaTicket.mockReset().mockResolvedValue(makeTicket('ticket-1'))
    ticketMock.fetchWsTicket.mockReset().mockResolvedValue('ws-ticket')
    onboardingMock.error.value = null
    onboardingMock.recordStep.mockReset().mockResolvedValue({})
    onboardingMock.refresh.mockReset().mockResolvedValue(undefined)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    localStorage.clear()
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders Android and Windows artifact details with the debug label', async () => {
    const wrapper = await mountStep()

    expect(wrapper.get('[data-onboarding-step-why]').text()).toContain('为什么需要')
    expect(wrapper.get('[data-onboarding-step-why]').text()).toContain('日常使用的入口')
    expect(wrapper.get('[data-onboarding-step-why-detected]').text()).toContain(
      'health.example.test',
    )

    const android = wrapper.get('[data-client-card="android"]')
    expect(android.get('[data-client-version="android"]').text()).toBe('1.4.2')
    expect(android.get('[data-client-label="android"]').text()).toBe('debug build')
    expect(android.get('[data-client-filename="android"]').text()).toBe('Kinship-1.4.2-debug.apk')
    expect(android.get('[data-client-debug="android"]').text()).toBe('Debug 构建')
    expect(android.get('[data-client-size="android"]').text()).toContain('84.5 MB')
    expect(android.get('[data-client-sha="android"]').text()).toBe(ANDROID_SHA)

    const desktop = wrapper.get('[data-client-card="desktop"]')
    expect(desktop.get('[data-client-version="desktop"]').text()).toBe('1.0.0')
    expect(desktop.get('[data-client-label="desktop"]').text()).toBe('release build')
    expect(desktop.get('[data-client-filename="desktop"]').text()).toBe(
      'Kinship-Desktop-Setup-1.0.0-x64.exe',
    )
    expect(desktop.get('[data-client-size="desktop"]').text()).toContain('106.8 MB')
    expect(desktop.get('[data-client-sha="desktop"]').text()).toBe(DESKTOP_SHA)
  })

  it('shows connection addresses for HTTPS and HTTP', async () => {
    const wrapper = await mountStep()
    const connection = wrapper.get('[data-client-connection]')
    expect(connection.text()).toContain('https://health.example.test:8768')
    expect(connection.text()).toContain('http://health.example.test:8769')
  })

  it('shows an explanatory state and release page link instead of a dead unavailable state', async () => {
    const pageUrl = 'https://github.com/Xehuri/kinship/releases'
    const wrapper = await mountStep(
      makeCatalog({
        android: makeEntry('android', {
          available: false,
          action: 'none',
          source: 'none',
          url: null,
          page_url: pageUrl,
          filename: null,
          download_filename: null,
          expected_filename: null,
          size: null,
          sha256: null,
          version: null,
          variant: null,
          debug: null,
          label: null,
          fallback_reason: 'local_missing,configured_missing,manifest_unavailable',
        }),
        desktop: makeEntry('desktop', {
          available: false,
          action: 'none',
          source: 'none',
          url: null,
          page_url: null,
          filename: null,
          download_filename: null,
          expected_filename: null,
          size: null,
          sha256: null,
          version: null,
          variant: null,
          debug: null,
          label: null,
          fallback_reason: 'local_missing,configured_missing,manifest_unavailable,github_page_unavailable',
        }),
      }),
    )

    const androidState = wrapper.get('[data-client-unavailable="android"]')
    expect(androidState.text()).not.toContain('暂不可用')
    expect(androidState.text()).toContain('GitHub Releases')
    const androidPage = wrapper.get('[data-client-page="android"]')
    expect(androidPage.attributes('href')).toBe(pageUrl)
    expect(androidPage.attributes('target')).toBe('_blank')
    expect(androidPage.attributes('rel')).toBe('noopener noreferrer')

    const desktopState = wrapper.get('[data-client-unavailable="desktop"]')
    expect(desktopState.text()).not.toContain('暂不可用')
    expect(desktopState.text()).toContain('未找到可下载的安装包')
    expect(wrapper.find('[data-client-page="desktop"]').exists()).toBe(false)

    expect(wrapper.find('[data-client-download="android"]').exists()).toBe(false)
    expect(wrapper.find('[data-client-download="desktop"]').exists()).toBe(false)
  })

  it('uses one-time ticket URLs for Android and desktop downloads without a Bearer token', async () => {
    apiMock.createOtaTicket
      .mockReset()
      .mockResolvedValueOnce(makeTicket('ticket-android'))
      .mockResolvedValueOnce(makeTicket('ticket-desktop'))
    const wrapper = await mountStep()

    await wrapper.get('[data-client-download="android"]').trigger('click')
    await flushPromises()
    const androidLink = wrapper.get('[data-client-last-download="android"]')
    expect(androidLink.attributes('href')).toBe('/api/ota/download?ticket=ticket-android')
    expect(androidLink.attributes('download')).toBe('Kinship-1.4.2-debug.apk')
    expect(androidLink.attributes('href')).not.toContain('Bearer')
    expect(androidLink.attributes('href')).not.toContain('token=')

    await wrapper.get('[data-client-download="desktop"]').trigger('click')
    await flushPromises()
    const desktopLink = wrapper.get('[data-client-last-download="desktop"]')
    expect(desktopLink.attributes('href')).toBe(
      '/api/clients/desktop/download?ticket=ticket-desktop',
    )
    expect(desktopLink.attributes('download')).toBe('Kinship-Desktop-Setup-1.0.0-x64.exe')
    expect(desktopLink.attributes('href')).not.toContain('Bearer')
    expect(apiMock.createOtaTicket).toHaveBeenCalledTimes(2)
  })

  it('falls back to a ws ticket for the desktop download when the OTA ticket is unavailable', async () => {
    apiMock.createOtaTicket.mockRejectedValue(new Error('更新文件不存在'))
    ticketMock.fetchWsTicket.mockResolvedValue('ws-ticket-123')
    const wrapper = await mountStep()

    await wrapper.get('[data-client-download="desktop"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-client-last-download="desktop"]').attributes('href')).toBe(
      '/api/clients/desktop/download?ticket=ws-ticket-123',
    )
    expect(ticketMock.fetchWsTicket).toHaveBeenCalledTimes(1)
  })

  it('links directly to configured release URLs without requesting a ticket', async () => {
    const configuredUrl =
      'https://github.com/Xehuri/kinship/releases/download/android-v1.4.2/Kinship-1.4.2.apk'
    const wrapper = await mountStep(
      makeCatalog({
        android: makeEntry('android', {
          source: 'configured',
          action: 'download',
          url: configuredUrl,
          filename: 'Kinship-1.4.2.apk',
          download_filename: 'Kinship-1.4.2.apk',
          expected_filename: 'Kinship-1.4.2.apk',
          fallback_reason: 'local_missing',
        }),
      }),
    )

    expect(wrapper.get('[data-client-filename="android"]').text()).toBe('Kinship-1.4.2.apk')
    await wrapper.get('[data-client-download="android"]').trigger('click')
    await flushPromises()

    const link = wrapper.get('[data-client-last-download="android"]')
    expect(link.attributes('href')).toBe(configuredUrl)
    expect(link.attributes('download')).toBe('Kinship-1.4.2.apk')
    expect(apiMock.createOtaTicket).not.toHaveBeenCalled()
  })

  it('uses the manifest filename for manifest-backed downloads without a ticket', async () => {
    const manifestUrl =
      'https://github.com/Xehuri/kinship/releases/download/onboarding-v1.0.0/Kinship-1.4.2-debug.apk'
    const wrapper = await mountStep(
      makeCatalog({
        android: makeEntry('android', {
          source: 'manifest',
          action: 'download',
          url: manifestUrl,
          filename: 'Kinship-1.4.2-debug.apk',
          download_filename: 'Kinship-1.4.2-debug.apk',
          expected_filename: 'Kinship-1.4.2-debug.apk',
          fallback_reason: 'local_missing,configured_missing',
        }),
      }),
    )

    expect(wrapper.get('[data-client-filename="android"]').text()).toBe('Kinship-1.4.2-debug.apk')
    await wrapper.get('[data-client-download="android"]').trigger('click')
    await flushPromises()

    const link = wrapper.get('[data-client-last-download="android"]')
    expect(link.attributes('href')).toBe(manifestUrl)
    expect(link.attributes('download')).toBe('Kinship-1.4.2-debug.apk')
    expect(apiMock.createOtaTicket).not.toHaveBeenCalled()
  })

  it('opens the GitHub release page for external actions without calling the download endpoint', async () => {
    const pageUrl = 'https://github.com/Xehuri/kinship/releases/tag/onboarding-v1.0.0'
    const wrapper = await mountStep(
      makeCatalog({
        android: makeEntry('android', {
          action: 'external',
          source: 'github',
          url: pageUrl,
          page_url: pageUrl,
          filename: null,
          download_filename: null,
          expected_filename: null,
          size: null,
          sha256: null,
          version: null,
          variant: null,
          debug: null,
          label: 'GitHub release page',
          fallback_reason: 'local_missing,configured_missing,manifest_unavailable',
        }),
      }),
    )

    const link = wrapper.get('[data-client-external="android"]')
    expect(link.attributes('href')).toBe(pageUrl)
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toBe('noopener noreferrer')
    expect(link.text()).toContain('前往 GitHub Releases')
    expect(wrapper.get('[data-client-filename="android"]').text()).toBe('—')
    expect(wrapper.find('[data-client-download="android"]').exists()).toBe(false)

    await link.trigger('click')
    await flushPromises()

    expect(apiMock.createOtaTicket).not.toHaveBeenCalled()
    expect(ticketMock.fetchWsTicket).not.toHaveBeenCalled()
  })

  it('records the clients step and emits next', async () => {
    const wrapper = await mountStep()

    await wrapper.get('[data-onboarding-clients-continue]').trigger('click')
    await flushPromises()

    expect(onboardingMock.recordStep).toHaveBeenCalledWith(
      'clients',
      'completed',
      expect.objectContaining({
        android_available: true,
        desktop_available: true,
        host: 'health.example.test',
      }),
    )
    expect(onboardingMock.refresh).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('next')).toHaveLength(1)
  })

  it('contains no PC sensor copy', async () => {
    const wrapper = await mountStep()
    const text = wrapper.text()
    expect(text).not.toContain('PC 采集器')
    expect(text).not.toContain('PC Sensor')
    expect(text).not.toContain('PCSensor')
  })

  it('shows a retry state when the catalog request fails', async () => {
    apiMock.getClientCatalog.mockRejectedValue(new Error('目录读取失败'))
    const wrapper = mount(ClientsStep)
    await flushPromises()

    expect(wrapper.get('[data-client-error]').text()).toContain('目录读取失败')
    apiMock.getClientCatalog.mockResolvedValue(makeCatalog())
    await wrapper.get('[data-client-retry]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-client-card="android"]').exists()).toBe(true)
  })
})
