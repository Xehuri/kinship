/// <reference types="vitest/globals" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import type { QqStatus } from '@/api/system'

interface QqMock {
  qq: Ref<QqStatus | null>
  error: Ref<{ message: string } | null>
  loadQq: ReturnType<typeof vi.fn>
  validateQq: ReturnType<typeof vi.fn>
  configureQq: ReturnType<typeof vi.fn>
  recordStep: ReturnType<typeof vi.fn>
}

const mock = vi.hoisted(() => ({}) as QqMock)

vi.mock('@/composables/useOnboarding', async () => {
  const { ref } = await import('vue')
  mock.qq = ref<QqStatus | null>(null)
  mock.error = ref<{ message: string } | null>(null)
  mock.loadQq = vi.fn().mockResolvedValue(null)
  mock.validateQq = vi.fn().mockResolvedValue(null)
  mock.configureQq = vi.fn().mockResolvedValue(null)
  mock.recordStep = vi.fn().mockResolvedValue({})
  return {
    useOnboarding: () => ({
      qq: mock.qq,
      error: mock.error,
      loadQq: mock.loadQq,
      validateQq: mock.validateQq,
      configureQq: mock.configureQq,
      recordStep: mock.recordStep,
    }),
  }
})

import QQStep from '@/components/onboarding/steps/QQStep.vue'

enableAutoUnmount(afterEach)

function makeStatus(overrides: Partial<QqStatus> = {}): QqStatus {
  return {
    enabled: false,
    self_qq: '',
    ws_url: '',
    ws_token_configured: false,
    mcp_token_configured: false,
    valid: true,
    errors: [],
    ...overrides,
  }
}

function mountStep(props: { currentPassword?: string } = {}) {
  return mount(QQStep, { props })
}

function storageDump(): string {
  const parts: string[] = []
  for (const storage of [localStorage, sessionStorage]) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key) parts.push(key, storage.getItem(key) ?? '')
    }
  }
  return parts.join('|')
}

describe('QQStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mock.qq.value = makeStatus()
    mock.error.value = null
    mock.loadQq.mockReset().mockResolvedValue(makeStatus())
    mock.validateQq.mockReset().mockResolvedValue(null)
    mock.configureQq.mockReset().mockResolvedValue(null)
    mock.recordStep.mockReset().mockResolvedValue({})
    localStorage.clear()
    sessionStorage.clear()
  })

  it('loads the status, hydrates the fields and shows the finish note', async () => {
    mock.qq.value = makeStatus({
      enabled: true,
      self_qq: '123456789',
      ws_url: 'ws://127.0.0.1:3001',
      ws_token_configured: true,
      mcp_token_configured: true,
    })
    const wrapper = mountStep({ currentPassword: 'pw-secret' })
    await flushPromises()

    expect(
      wrapper.get('[data-skip-consequence-step="qq"]').text(),
    ).toContain('跳过会怎样')
    expect(wrapper.get('[data-onboarding-step-why]').text()).toContain('为什么需要')
    expect(wrapper.get('[data-onboarding-step-why]').text()).toContain('收发 QQ 消息')
    expect(wrapper.get('[data-onboarding-step-why-detected]').text()).toContain('已启用')
    expect(mock.loadQq).toHaveBeenCalledTimes(1)
    expect(
      (wrapper.get('[data-onboarding-qq-toggle]').element as HTMLInputElement)
        .checked,
    ).toBe(true)
    expect(
      (wrapper.get('[data-onboarding-qq-self]').element as HTMLInputElement)
        .value,
    ).toBe('123456789')
    expect(
      (wrapper.get('[data-onboarding-qq-ws-url]').element as HTMLInputElement)
        .value,
    ).toBe('ws://127.0.0.1:3001')
    expect(wrapper.text()).toContain('WS Token（已配置，留空保持不变）')
    expect(wrapper.text()).toContain('已配置，留空保持不变。')
    expect(wrapper.text()).toContain('MCP token 由服务端自动生成')
    expect(wrapper.text()).toContain('完成引导（finish）后启动')
    expect(wrapper.text()).not.toMatch(/第\s*\d+\s*步/)
    expect(wrapper.html()).not.toContain('pw-secret')
  })

  it('saves the disabled state, records the step and emits next', async () => {
    mock.qq.value = makeStatus({
      enabled: true,
      self_qq: '123456789',
      ws_url: 'ws://127.0.0.1:3001',
      ws_token_configured: true,
    })
    mock.configureQq.mockResolvedValue(makeStatus({ enabled: false }))
    const wrapper = mountStep({ currentPassword: 'pw-secret' })
    await flushPromises()

    await wrapper.get('[data-onboarding-qq-toggle]').setValue(false)
    await wrapper.get('[data-onboarding-qq-save]').trigger('click')
    await flushPromises()

    expect(mock.validateQq).not.toHaveBeenCalled()
    expect(mock.configureQq).toHaveBeenCalledWith({
      enabled: false,
      self_qq: '123456789',
      ws_url: 'ws://127.0.0.1:3001',
      current_password: 'pw-secret',
    })
    expect(mock.recordStep).toHaveBeenCalledWith('qq', 'completed', {
      enabled: false,
    })
    expect(wrapper.emitted('next')).toHaveLength(1)
  })

  it('shows field errors and blocks the write when validation fails', async () => {
    mock.qq.value = makeStatus({
      enabled: true,
      self_qq: '123456789',
      ws_url: 'ws://127.0.0.1:3001',
    })
    mock.validateQq.mockResolvedValue({
      valid: false,
      errors: [
        { field: 'self_qq', message: 'self_qq 必须为纯数字' },
        { field: 'ws_url', message: 'ws_url 必须以 ws:// 或 wss:// 开头' },
      ],
    })
    const wrapper = mountStep({ currentPassword: 'pw-secret' })
    await flushPromises()

    await wrapper.get('[data-onboarding-qq-save]').trigger('click')
    await flushPromises()

    expect(mock.validateQq).toHaveBeenCalledTimes(1)
    expect(mock.configureQq).not.toHaveBeenCalled()
    expect(mock.recordStep).not.toHaveBeenCalled()
    expect(wrapper.emitted('next')).toBeUndefined()
    expect(
      wrapper.get('[data-onboarding-qq-field="self_qq"]').text(),
    ).toContain('self_qq 必须为纯数字')
    expect(
      wrapper.get('[data-onboarding-qq-field="ws_url"]').text(),
    ).toContain('ws_url 必须以 ws:// 或 wss:// 开头')
  })

  it('validates then writes a valid configuration, records and emits next', async () => {
    mock.qq.value = makeStatus({
      enabled: true,
      self_qq: '123456789',
      ws_url: 'ws://127.0.0.1:3001',
    })
    mock.validateQq.mockResolvedValue({ valid: true, errors: [] })
    mock.configureQq.mockResolvedValue({
      ...makeStatus({
        enabled: true,
        self_qq: '123456789',
        ws_url: 'ws://127.0.0.1:3001',
        ws_token_configured: true,
      }),
      starts_after_finish: true,
    })
    const wrapper = mountStep({ currentPassword: 'pw-secret' })
    await flushPromises()

    await wrapper.get('[data-onboarding-qq-ws-token]').setValue('tok-abc')
    await wrapper.get('[data-onboarding-qq-save]').trigger('click')
    await flushPromises()

    const expected = {
      enabled: true,
      self_qq: '123456789',
      ws_url: 'ws://127.0.0.1:3001',
      ws_token: 'tok-abc',
      current_password: 'pw-secret',
    }
    expect(mock.validateQq).toHaveBeenCalledWith(expected)
    expect(mock.configureQq).toHaveBeenCalledWith(expected)
    expect(mock.validateQq.mock.invocationCallOrder[0]).toBeLessThan(
      mock.configureQq.mock.invocationCallOrder[0],
    )
    expect(mock.recordStep).toHaveBeenCalledWith('qq', 'completed', {
      enabled: true,
    })
    expect(wrapper.emitted('next')).toHaveLength(1)
  })

  it('keeps the existing token when the field is left blank', async () => {
    mock.qq.value = makeStatus({
      enabled: true,
      self_qq: '123456789',
      ws_url: 'ws://127.0.0.1:3001',
      ws_token_configured: true,
    })
    mock.validateQq.mockResolvedValue({ valid: true, errors: [] })
    mock.configureQq.mockResolvedValue({
      ...makeStatus({
        enabled: true,
        self_qq: '123456789',
        ws_url: 'ws://127.0.0.1:3001',
        ws_token_configured: true,
      }),
      starts_after_finish: true,
    })
    const wrapper = mountStep({ currentPassword: 'pw-secret' })
    await flushPromises()

    expect(
      wrapper.get('[data-onboarding-qq-ws-token]').attributes('placeholder'),
    ).toBe('留空保持不变')

    await wrapper.get('[data-onboarding-qq-save]').trigger('click')
    await flushPromises()

    const validated = mock.validateQq.mock.calls[0][0] as Record<string, unknown>
    const written = mock.configureQq.mock.calls[0][0] as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(validated, 'ws_token')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(written, 'ws_token')).toBe(false)
  })

  it('never renders or persists the WS token', async () => {
    mock.qq.value = makeStatus({
      enabled: true,
      self_qq: '123456789',
      ws_url: 'ws://127.0.0.1:3001',
    })
    mock.validateQq.mockResolvedValue({ valid: true, errors: [] })
    mock.configureQq.mockResolvedValue({
      ...makeStatus({
        enabled: true,
        self_qq: '123456789',
        ws_url: 'ws://127.0.0.1:3001',
        ws_token_configured: true,
      }),
      starts_after_finish: true,
    })
    const wrapper = mountStep({ currentPassword: 'pw-secret' })
    await flushPromises()

    const token = 'super-secret-ws-token'
    await wrapper.get('[data-onboarding-qq-ws-token]').setValue(token)

    expect(wrapper.text()).not.toContain(token)
    expect(wrapper.html()).not.toContain(token)
    expect(storageDump()).not.toContain(token)

    await wrapper.get('[data-onboarding-qq-save]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain(token)
    expect(
      JSON.stringify(mock.recordStep.mock.calls),
    ).not.toContain(token)
    expect(storageDump()).not.toContain(token)
    expect(wrapper.emitted('next')).toHaveLength(1)
  })
})
