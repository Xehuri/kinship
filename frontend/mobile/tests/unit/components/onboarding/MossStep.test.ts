/// <reference types="vitest/globals" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import type { MossConfig } from '@/api/system'

interface MossMock {
  config: Ref<MossConfig | null>
  error: Ref<{ message: string } | null>
  loadMossConfig: ReturnType<typeof vi.fn>
  configureMoss: ReturnType<typeof vi.fn>
  recordStep: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
}

const mock = vi.hoisted(() => ({}) as MossMock)

vi.mock('@/composables/useOnboarding', async () => {
  const { ref } = await import('vue')
  mock.config = ref<MossConfig | null>(null)
  mock.error = ref<{ message: string } | null>(null)
  mock.loadMossConfig = vi.fn().mockResolvedValue(null)
  mock.configureMoss = vi.fn().mockResolvedValue(null)
  mock.recordStep = vi.fn().mockResolvedValue({})
  mock.refresh = vi.fn().mockResolvedValue(undefined)
  return {
    useOnboarding: () => ({
      mossConfig: mock.config,
      error: mock.error,
      loadMossConfig: mock.loadMossConfig,
      configureMoss: mock.configureMoss,
      recordStep: mock.recordStep,
      refresh: mock.refresh,
    }),
  }
})

import MossStep from '@/components/onboarding/steps/MossStep.vue'

enableAutoUnmount(afterEach)

const REMOVED_SELECTORS = [
  '[data-onboarding-moss-choice]',
  '[data-onboarding-moss-choice-value]',
  '[data-onboarding-moss-managed-note]',
  '[data-onboarding-moss-validate]',
  '[data-onboarding-moss-apply]',
  '[data-onboarding-moss-skip]',
  '[data-onboarding-moss-validation]',
  '[data-onboarding-moss-result]',
  '[data-onboarding-moss-summary]',
  '[data-onboarding-moss-commands]',
  '[data-onboarding-moss-command]',
  '[data-onboarding-moss-warnings]',
]

function makeConfig(overrides: Partial<MossConfig> = {}): MossConfig {
  return {
    enabled: true,
    base_url: 'http://127.0.0.1:8100/v1',
    model: 'moss-audio-4b',
    ...overrides,
  }
}

function mountStep(props: { currentPassword?: string } = {}) {
  return mount(MossStep, { props })
}

describe('MossStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mock.config.value = makeConfig()
    mock.error.value = null
    mock.loadMossConfig.mockReset().mockImplementation(async () => mock.config.value)
    mock.configureMoss.mockReset().mockResolvedValue(null)
    mock.recordStep.mockReset().mockResolvedValue({})
    mock.refresh.mockReset().mockResolvedValue(undefined)
  })

  it('loads the saved config into the toggle and the two fields', async () => {
    const wrapper = mountStep()
    await flushPromises()

    expect(
      wrapper.get('[data-skip-consequence-step="moss"]').text(),
    ).toContain('跳过会怎样')
    expect(wrapper.get('[data-onboarding-step-why]').text()).toContain('为什么需要')
    expect(wrapper.get('[data-onboarding-step-why]').text()).toContain('环境声')
    expect(wrapper.get('[data-onboarding-step-why-detected]').text()).toContain(
      '服务地址',
    )
    expect(mock.loadMossConfig).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-onboarding-moss-toggle]').element).toMatchObject({
      checked: true,
    })
    expect(
      (wrapper.get('[data-onboarding-moss-base-url]').element as HTMLInputElement).value,
    ).toBe('http://127.0.0.1:8100/v1')
    expect(
      (wrapper.get('[data-onboarding-moss-model]').element as HTMLInputElement).value,
    ).toBe('moss-audio-4b')
    expect(wrapper.get('[data-onboarding-moss-note]').text()).toContain('外部进程')
    expect(wrapper.text()).not.toContain('第 6 步')
    expect(wrapper.find('input[type="password"]').exists()).toBe(false)
    for (const selector of REMOVED_SELECTORS) {
      expect(wrapper.find(selector).exists(), selector).toBe(false)
    }
  })

  it('saves an enabled config, records the step, refreshes and advances', async () => {
    mock.configureMoss.mockImplementation(async (body: MossConfig) =>
      makeConfig({
        enabled: body.enabled,
        base_url: body.base_url,
        model: body.model,
      }),
    )
    const wrapper = mountStep({ currentPassword: 'pw-123' })
    await flushPromises()

    await wrapper.get('[data-onboarding-moss-save]').trigger('click')
    await flushPromises()

    expect(mock.configureMoss).toHaveBeenCalledTimes(1)
    expect(mock.configureMoss).toHaveBeenCalledWith({
      enabled: true,
      base_url: 'http://127.0.0.1:8100/v1',
      model: 'moss-audio-4b',
      current_password: 'pw-123',
    })
    expect(mock.recordStep).toHaveBeenCalledWith('moss', 'completed', {
      enabled: true,
    })
    expect(mock.refresh).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('next')).toHaveLength(1)
  })

  it('saves edited values from the two fields', async () => {
    mock.configureMoss.mockImplementation(async (body: MossConfig) =>
      makeConfig({
        enabled: body.enabled,
        base_url: body.base_url,
        model: body.model,
      }),
    )
    const wrapper = mountStep({ currentPassword: 'pw-123' })
    await flushPromises()

    await wrapper
      .get('[data-onboarding-moss-base-url]')
      .setValue('https://moss.example.test/v1')
    await wrapper.get('[data-onboarding-moss-model]').setValue('moss-audio-4b-q8')
    await wrapper.get('[data-onboarding-moss-save]').trigger('click')
    await flushPromises()

    expect(mock.configureMoss).toHaveBeenCalledWith(
      expect.objectContaining({
        base_url: 'https://moss.example.test/v1',
        model: 'moss-audio-4b-q8',
      }),
    )
  })

  it('still saves enabled=false and records the completed step', async () => {
    mock.config.value = makeConfig({ enabled: false })
    mock.configureMoss.mockImplementation(async (body: MossConfig) =>
      makeConfig({
        enabled: body.enabled,
        base_url: body.base_url,
        model: body.model,
      }),
    )
    const wrapper = mountStep({ currentPassword: 'pw-123' })
    await flushPromises()

    expect(wrapper.get('[data-onboarding-moss-toggle]').element).toMatchObject({
      checked: false,
    })
    await wrapper.get('[data-onboarding-moss-save]').trigger('click')
    await flushPromises()

    expect(mock.configureMoss).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    )
    expect(mock.recordStep).toHaveBeenCalledWith('moss', 'completed', {
      enabled: false,
    })
    expect(wrapper.emitted('next')).toHaveLength(1)
  })

  it('shows a readable validation error without calling the API', async () => {
    mock.config.value = makeConfig({ base_url: '' })
    const wrapper = mountStep({ currentPassword: 'pw-123' })
    await flushPromises()

    await wrapper.get('[data-onboarding-moss-save]').trigger('click')
    await flushPromises()

    expect(mock.configureMoss).not.toHaveBeenCalled()
    expect(wrapper.get('[data-onboarding-moss-error]').text()).toContain('服务地址')
  })

  it('surfaces an API error and does not record or advance', async () => {
    mock.configureMoss.mockImplementation(async () => {
      mock.error.value = { message: '模型名称不能为空' }
      return null
    })
    const wrapper = mountStep({ currentPassword: 'pw-123' })
    await flushPromises()

    await wrapper.get('[data-onboarding-moss-save]').trigger('click')
    await flushPromises()

    expect(mock.recordStep).not.toHaveBeenCalled()
    expect(mock.refresh).not.toHaveBeenCalled()
    expect(wrapper.emitted('next')).toBeUndefined()
    expect(wrapper.get('[data-onboarding-moss-error]').text()).toContain('模型名称不能为空')
  })

  it('does not advance when recording the step fails', async () => {
    mock.configureMoss.mockImplementation(async () => makeConfig())
    mock.recordStep.mockImplementation(async () => {
      mock.error.value = { message: '进度写入失败' }
      return null
    })
    const wrapper = mountStep({ currentPassword: 'pw-123' })
    await flushPromises()

    await wrapper.get('[data-onboarding-moss-save]').trigger('click')
    await flushPromises()

    expect(mock.refresh).not.toHaveBeenCalled()
    expect(wrapper.emitted('next')).toBeUndefined()
    expect(wrapper.get('[data-onboarding-moss-error]').text()).toContain('进度写入失败')
  })
})
