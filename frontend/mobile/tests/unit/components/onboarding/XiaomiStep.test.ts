/// <reference types="vitest/globals" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import type { XiaomiStatus } from '@/api/system'

interface XiaomiMock {
  xiaomi: Ref<XiaomiStatus | null>
  error: Ref<{ message: string } | null>
  loadXiaomi: ReturnType<typeof vi.fn>
  configureXiaomi: ReturnType<typeof vi.fn>
  requestXiaomiQr: ReturnType<typeof vi.fn>
  pollXiaomiQr: ReturnType<typeof vi.fn>
  recordStep: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
}

const mock = vi.hoisted(() => ({}) as XiaomiMock)

vi.mock('@/composables/useOnboarding', async () => {
  const { ref } = await import('vue')
  mock.xiaomi = ref<XiaomiStatus | null>(null)
  mock.error = ref<{ message: string } | null>(null)
  mock.loadXiaomi = vi.fn().mockResolvedValue(null)
  mock.configureXiaomi = vi.fn().mockResolvedValue(null)
  mock.requestXiaomiQr = vi.fn().mockResolvedValue(null)
  mock.pollXiaomiQr = vi.fn().mockResolvedValue(null)
  mock.recordStep = vi.fn().mockResolvedValue({})
  mock.refresh = vi.fn().mockResolvedValue(undefined)
  return {
    useOnboarding: () => ({
      xiaomi: mock.xiaomi,
      error: mock.error,
      loadXiaomi: mock.loadXiaomi,
      configureXiaomi: mock.configureXiaomi,
      requestXiaomiQr: mock.requestXiaomiQr,
      pollXiaomiQr: mock.pollXiaomiQr,
      recordStep: mock.recordStep,
      refresh: mock.refresh,
    }),
  }
})

import XiaomiStep from '@/components/onboarding/steps/XiaomiStep.vue'

enableAutoUnmount(afterEach)

function makeStatus(overrides: Partial<XiaomiStatus> = {}): XiaomiStatus {
  return {
    enabled: false,
    configured: false,
    phase: 'unconfigured',
    userid_masked: '',
    userid_configured: false,
    region: 'cn',
    last_error: '',
    needs_login: false,
    ...overrides,
  }
}

function mountStep(props: { currentPassword?: string } = {}) {
  return mount(XiaomiStep, { props })
}

describe('XiaomiStep', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    mock.xiaomi.value = makeStatus()
    mock.error.value = null
    mock.loadXiaomi.mockReset().mockResolvedValue(makeStatus())
    mock.configureXiaomi.mockReset().mockResolvedValue(null)
    mock.requestXiaomiQr.mockReset().mockResolvedValue(null)
    mock.pollXiaomiQr.mockReset().mockResolvedValue(null)
    mock.recordStep.mockReset().mockResolvedValue({})
    mock.refresh.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads the status and reflects enabled, phase and masked account', async () => {
    mock.xiaomi.value = makeStatus({
      enabled: true,
      configured: true,
      phase: 'ok',
      userid_masked: 'ax***23',
      userid_configured: true,
    })
    const wrapper = mountStep({ currentPassword: 'pw-secret' })
    await flushPromises()

    expect(
      wrapper.get('[data-skip-consequence-step="xiaomi"]').text(),
    ).toContain('跳过会怎样')
    expect(wrapper.get('[data-onboarding-step-why]').text()).toContain('为什么需要')
    expect(wrapper.get('[data-onboarding-step-why]').text()).toContain(
      '从小米健康云补齐',
    )
    expect(wrapper.get('[data-onboarding-step-why-detected]').text()).toContain('登录状态')
    expect(mock.loadXiaomi).toHaveBeenCalledTimes(1)
    expect(
      (wrapper.get('[data-onboarding-xiaomi-toggle]').element as HTMLInputElement)
        .checked,
    ).toBe(true)
    expect(wrapper.get('[data-onboarding-xiaomi-phase]').text()).toBe('已登录')
    expect(
      wrapper.get('[data-onboarding-xiaomi-phase]').attributes('data-phase'),
    ).toBe('ok')
    expect(wrapper.get('[data-onboarding-xiaomi-account]').text()).toBe('ax***23')
    expect(wrapper.text()).not.toMatch(/第\s*\d+\s*步/)
    expect(wrapper.html()).not.toContain('pw-secret')
  })

  it('saves the disabled state, records the step and emits next', async () => {
    mock.xiaomi.value = makeStatus({
      enabled: true,
      configured: true,
      phase: 'ok',
      userid_masked: 'ax***23',
      userid_configured: true,
    })
    mock.configureXiaomi.mockResolvedValue(makeStatus({ enabled: false }))
    const wrapper = mountStep({ currentPassword: 'pw-secret' })
    await flushPromises()

    await wrapper.get('[data-onboarding-xiaomi-toggle]').setValue(false)
    await wrapper.get('[data-onboarding-xiaomi-save]').trigger('click')
    await flushPromises()

    expect(mock.configureXiaomi).toHaveBeenCalledWith({
      enabled: false,
      current_password: 'pw-secret',
    })
    expect(mock.configureXiaomi.mock.invocationCallOrder[0]).toBeLessThan(
      mock.recordStep.mock.invocationCallOrder[0],
    )
    expect(mock.recordStep).toHaveBeenCalledWith('xiaomi', 'completed', {
      enabled: false,
    })
    expect(mock.refresh).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('next')).toHaveLength(1)
  })

  it('blocks saving when enabled but not configured', async () => {
    mock.xiaomi.value = makeStatus({
      enabled: true,
      configured: false,
      phase: 'unconfigured',
      needs_login: true,
    })
    const wrapper = mountStep({ currentPassword: 'pw-secret' })
    await flushPromises()

    await wrapper.get('[data-onboarding-xiaomi-save]').trigger('click')
    await flushPromises()

    expect(mock.configureXiaomi).not.toHaveBeenCalled()
    expect(mock.recordStep).not.toHaveBeenCalled()
    expect(mock.refresh).not.toHaveBeenCalled()
    expect(wrapper.emitted('next')).toBeUndefined()
    expect(wrapper.get('[data-onboarding-xiaomi-error]').text()).toContain(
      '请先扫码登录，或关闭小米健康云',
    )
  })

  it('requests a QR code, polls until success and saves the configured state', async () => {
    vi.useFakeTimers()
    mock.xiaomi.value = makeStatus({
      enabled: true,
      configured: false,
      phase: 'unconfigured',
      needs_login: true,
    })
    mock.requestXiaomiQr.mockResolvedValue({
      lp: 'lp-1',
      qr_base64: 'Zm9v',
      expires_in: 120,
      login_url: 'https://example.invalid/login',
    })
    mock.pollXiaomiQr
      .mockResolvedValueOnce({ state: 'waiting' })
      .mockResolvedValueOnce({
        state: 'success',
        userid_masked: 'ab***cd',
        configured: true,
      })
    mock.configureXiaomi.mockResolvedValue(
      makeStatus({ enabled: true, configured: true, phase: 'ok' }),
    )
    const wrapper = mountStep({ currentPassword: 'pw-secret' })
    await flushPromises()

    await wrapper.get('[data-onboarding-xiaomi-qr-open]').trigger('click')
    await flushPromises()

    expect(mock.requestXiaomiQr).toHaveBeenCalledWith(undefined, 'pw-secret')
    expect(wrapper.get('[data-onboarding-xiaomi-qr-modal]').exists()).toBe(true)
    expect(
      wrapper.get('[data-onboarding-xiaomi-qr-image]').attributes('src'),
    ).toBe('data:image/png;base64,Zm9v')
    expect(wrapper.html()).not.toContain('pw-secret')

    await vi.advanceTimersByTimeAsync(2000)
    expect(mock.pollXiaomiQr).toHaveBeenCalledTimes(1)
    expect(mock.pollXiaomiQr).toHaveBeenCalledWith(
      'lp-1',
      undefined,
      'pw-secret',
    )
    await flushPromises()
    expect(wrapper.find('[data-onboarding-xiaomi-qr-modal]').exists()).toBe(true)

    await vi.advanceTimersByTimeAsync(2000)
    expect(mock.pollXiaomiQr).toHaveBeenCalledTimes(2)
    await flushPromises()

    expect(wrapper.find('[data-onboarding-xiaomi-qr-modal]').exists()).toBe(false)
    expect(wrapper.get('[data-onboarding-xiaomi-qr-success]').text()).toContain(
      '扫码登录成功',
    )
    expect(wrapper.get('[data-onboarding-xiaomi-account]').text()).toBe('ab***cd')

    await wrapper.get('[data-onboarding-xiaomi-save]').trigger('click')
    await flushPromises()

    expect(mock.configureXiaomi).toHaveBeenCalledWith({
      enabled: true,
      current_password: 'pw-secret',
    })
    expect(mock.recordStep).toHaveBeenCalledWith('xiaomi', 'completed', {
      enabled: true,
      configured: true,
    })
    expect(mock.refresh).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('next')).toHaveLength(1)
    wrapper.unmount()
    vi.useRealTimers()
  })

  it('shows a readable error when configure fails and does not advance', async () => {
    mock.xiaomi.value = makeStatus({
      enabled: true,
      configured: true,
      phase: 'ok',
      userid_masked: 'ax***23',
      userid_configured: true,
    })
    mock.configureXiaomi.mockImplementation(async () => {
      mock.error.value = { message: '当前密码错误，请重新输入。' }
      return null
    })
    const wrapper = mountStep({ currentPassword: 'pw-secret' })
    await flushPromises()

    await wrapper.get('[data-onboarding-xiaomi-save]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-onboarding-xiaomi-error]').text()).toContain(
      '当前密码错误，请重新输入。',
    )
    expect(mock.recordStep).not.toHaveBeenCalled()
    expect(wrapper.emitted('next')).toBeUndefined()
  })
})
