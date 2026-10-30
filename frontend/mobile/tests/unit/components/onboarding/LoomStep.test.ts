/// <reference types="vitest/globals" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import type { LoomSetupResult } from '@/api/system'

interface LoomStatusLike {
  url: string
  main_model: {
    id: string
    provider: string
    contextWindow?: number | null
  } | null
  models: Array<{
    id: string
    provider: string
    contextWindow?: number | null
  }>
  credentials: Array<{ name: string; env_ref: string }>
}

interface LoomMock {
  loom: Ref<LoomStatusLike | null>
  error: Ref<{ message: string } | null>
  loadLoom: ReturnType<typeof vi.fn>
  setupLoom: ReturnType<typeof vi.fn>
  recordStep: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
}

const mock = vi.hoisted(() => ({}) as LoomMock)

vi.mock('@/composables/useOnboarding', async () => {
  const { ref } = await import('vue')
  mock.loom = ref<LoomStatusLike | null>(null)
  mock.error = ref<{ message: string } | null>(null)
  mock.loadLoom = vi.fn().mockResolvedValue(null)
  mock.setupLoom = vi.fn().mockResolvedValue(null)
  mock.recordStep = vi.fn().mockResolvedValue({})
  mock.refresh = vi.fn().mockResolvedValue(undefined)
  return {
    useOnboarding: () => ({
      loom: mock.loom,
      error: mock.error,
      loadLoom: mock.loadLoom,
      setupLoom: mock.setupLoom,
      recordStep: mock.recordStep,
      refresh: mock.refresh,
    }),
  }
})

import LoomStep from '@/components/onboarding/steps/LoomStep.vue'

enableAutoUnmount(afterEach)

const REMOVED_SELECTORS = [
  '[data-onboarding-loom-token]',
  '[data-onboarding-loom-token-input]',
  '[data-onboarding-loom-token-ensure]',
  '[data-onboarding-loom-token-result]',
  '[data-onboarding-loom-token-status]',
  '[data-onboarding-loom-runtime]',
  '[data-onboarding-loom-runtime-result]',
  '[data-onboarding-loom-start]',
  '[data-onboarding-loom-stop]',
  '[data-onboarding-loom-restart]',
  '[data-onboarding-loom-validate]',
  '[data-onboarding-loom-apply]',
  '[data-onboarding-loom-external]',
  '[data-onboarding-loom-external-continue]',
  '[data-onboarding-loom-config-ensure]',
  '[data-onboarding-loom-config-result]',
  '[data-onboarding-loom-manual]',
  '[data-onboarding-loom-manual-command]',
  '[data-onboarding-loom-confirm]',
  '[data-onboarding-loom-url]',
]

function makeStatus(overrides: Partial<LoomStatusLike> = {}): LoomStatusLike {
  return {
    url: 'http://127.0.0.1:5100',
    main_model: {
      id: 'deepseek-flash',
      provider: 'deepseek',
      contextWindow: 128000,
    },
    models: [
      { id: 'deepseek-flash', provider: 'deepseek', contextWindow: 128000 },
    ],
    credentials: [{ name: 'deepseek', env_ref: '${DEEPSEEK_KEY}' }],
    ...overrides,
  }
}

function makeSetupResult(
  overrides: Partial<LoomSetupResult> = {},
): LoomSetupResult {
  return {
    ok: true,
    stage: 'done',
    loom: {
      url: 'http://127.0.0.1:5100',
      port: 5100,
      mode: 'systemd',
      pid: 4321,
      health: {
        status: 'ok',
        version: '1.2.3',
        uptime_ms: 1000,
        started_at: '2026-10-27T00:00:00Z',
      },
      catalog_models: ['deepseek-flash'],
    },
    applied: {
      ai_backend: 'loom',
      config_path: '/srv/ai/.loom/config.yaml',
      api_key_configured: true,
    },
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function mountStep(props: { currentPassword?: string } = {}) {
  return mount(LoomStep, { props })
}

describe('LoomStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mock.loom.value = makeStatus()
    mock.error.value = null
    mock.loadLoom.mockReset().mockImplementation(async () => mock.loom.value)
    mock.setupLoom.mockReset().mockResolvedValue(null)
    mock.recordStep.mockReset().mockResolvedValue({})
    mock.refresh.mockReset().mockResolvedValue(undefined)
  })

  it('loads the existing URL port and exposes the six minimal fields', async () => {
    mock.loom.value = makeStatus({
      url: 'http://127.0.0.1:5200',
      main_model: {
        id: 'deepseek-flash',
        provider: 'deepseek',
        contextWindow: 64000,
      },
      models: [
        { id: 'deepseek-flash', provider: 'deepseek', contextWindow: 64000 },
      ],
    })
    const wrapper = mountStep()
    await flushPromises()

    expect(
      wrapper.get('[data-skip-consequence-step="loom"]').text(),
    ).toContain('跳过会怎样')
    expect(wrapper.get('[data-onboarding-step-why]').text()).toContain('为什么需要')
    expect(wrapper.get('[data-onboarding-step-why]').text()).toContain('Loom 负责对话')
    expect(wrapper.get('[data-onboarding-step-why-detected]').text()).toContain(
      '主模型',
    )
    expect(mock.loadLoom).toHaveBeenCalledTimes(1)
    expect(
      (wrapper.get('[data-onboarding-loom-port]').element as HTMLInputElement).value,
    ).toBe('5200')
    expect(
      (wrapper.get('[data-onboarding-loom-provider]').element as HTMLInputElement).value,
    ).toBe('deepseek')
    expect(
      (wrapper.get('[data-onboarding-loom-model]').element as HTMLInputElement).value,
    ).toBe('deepseek-flash')
    expect(
      (wrapper.get('[data-onboarding-loom-context-window]').element as HTMLInputElement).value,
    ).toBe('64000')
    expect(wrapper.find('[data-onboarding-loom-base-url]').exists()).toBe(true)
    expect(
      (wrapper.get('[data-onboarding-loom-api-key]').element as HTMLInputElement).type,
    ).toBe('password')
    expect(wrapper.get('[data-onboarding-loom-key-note]').text()).toContain(
      '已配置，留空保持不变',
    )
    expect(wrapper.text()).not.toContain('第 7 步')
    expect(wrapper.text()).not.toContain('Token')
    expect(wrapper.text()).not.toContain('systemctl')
    for (const selector of REMOVED_SELECTORS) {
      expect(wrapper.find(selector).exists(), selector).toBe(false)
    }
  })

  it('calls setup once, records the step, refreshes and advances on success', async () => {
    mock.setupLoom.mockImplementation(async (body: Record<string, unknown>) =>
      makeSetupResult({
        loom: {
          ...makeSetupResult().loom,
          port: body.port as number,
        },
      }),
    )
    const wrapper = mountStep({ currentPassword: 'pw-123' })
    await flushPromises()

    await wrapper
      .get('[data-onboarding-loom-provider]')
      .setValue('new-api')
    await wrapper
      .get('[data-onboarding-loom-base-url]')
      .setValue('https://api.example.test/v1')
    await wrapper.get('[data-onboarding-loom-model]').setValue('deepseek-chat')
    await wrapper.get('[data-onboarding-loom-api-key]').setValue('sk-secret')
    await wrapper.get('[data-onboarding-loom-setup]').trigger('click')
    await flushPromises()

    expect(mock.setupLoom).toHaveBeenCalledTimes(1)
    expect(mock.setupLoom).toHaveBeenCalledWith({
      port: 5100,
      provider: 'new-api',
      base_url: 'https://api.example.test/v1',
      model: 'deepseek-chat',
      context_window: 128000,
      api_key: 'sk-secret',
      current_password: 'pw-123',
    })
    expect(mock.recordStep).toHaveBeenCalledWith('loom', 'completed', {
      port: 5100,
      provider: 'new-api',
      model: 'deepseek-chat',
      context_window: 128000,
    })
    expect(mock.refresh).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('next')).toHaveLength(1)
    const result = wrapper.get('[data-onboarding-loom-result]')
    expect(result.attributes('data-state')).toBe('ok')
    expect(result.text()).toContain('端口 5100')
    expect(result.text()).toContain('systemd')
    expect(result.text()).toContain('ok')
    expect(wrapper.text()).not.toContain('sk-secret')
    expect(
      (wrapper.get('[data-onboarding-loom-api-key]').element as HTMLInputElement).value,
    ).toBe('')
  })

  it('sends a manually entered context window and records it', async () => {
    mock.setupLoom.mockResolvedValue(makeSetupResult())
    const wrapper = mountStep({ currentPassword: 'pw-123' })
    await flushPromises()

    await wrapper
      .get('[data-onboarding-loom-base-url]')
      .setValue('https://api.example.test/v1')
    await wrapper
      .get('[data-onboarding-loom-context-window]')
      .setValue('32000')
    await wrapper.get('[data-onboarding-loom-setup]').trigger('click')
    await flushPromises()

    expect(mock.setupLoom).toHaveBeenCalledWith(
      expect.objectContaining({ context_window: 32000 }),
    )
    expect(mock.recordStep).toHaveBeenCalledWith(
      'loom',
      'completed',
      expect.objectContaining({ context_window: 32000 }),
    )
  })

  it('rejects a context window outside the supported range', async () => {
    const wrapper = mountStep({ currentPassword: 'pw-123' })
    await flushPromises()

    await wrapper
      .get('[data-onboarding-loom-base-url]')
      .setValue('https://api.example.test/v1')
    await wrapper
      .get('[data-onboarding-loom-context-window]')
      .setValue('100')
    await wrapper.get('[data-onboarding-loom-setup]').trigger('click')
    await flushPromises()

    expect(mock.setupLoom).not.toHaveBeenCalled()
    expect(wrapper.get('[data-onboarding-loom-error]').text()).toContain(
      '上下文上限',
    )
  })

  it('shows the failure message and code without recording or advancing', async () => {
    mock.setupLoom.mockResolvedValue(
      makeSetupResult({
        ok: false,
        stage: 'provider_probe',
        code: 'loom_provider_auth_failed',
        message: '供应商鉴权失败',
        field: 'api_key',
      }),
    )
    const wrapper = mountStep({ currentPassword: 'pw-123' })
    await flushPromises()

    await wrapper
      .get('[data-onboarding-loom-base-url]')
      .setValue('https://api.example.test/v1')
    await wrapper.get('[data-onboarding-loom-setup]').trigger('click')
    await flushPromises()

    const result = wrapper.get('[data-onboarding-loom-result]')
    expect(result.attributes('data-state')).toBe('failed')
    expect(result.text()).toContain('供应商鉴权失败')
    expect(result.text()).toContain('loom_provider_auth_failed')
    expect(mock.recordStep).not.toHaveBeenCalled()
    expect(mock.refresh).not.toHaveBeenCalled()
    expect(wrapper.emitted('next')).toBeUndefined()
  })

  it('keeps an existing key when the API Key field is blank', async () => {
    mock.loom.value = makeStatus({ credentials: [] })
    mock.setupLoom.mockResolvedValue(makeSetupResult())
    const wrapper = mountStep({ currentPassword: 'pw-123' })
    await flushPromises()

    expect(wrapper.find('[data-onboarding-loom-key-note]').exists()).toBe(false)
    await wrapper
      .get('[data-onboarding-loom-base-url]')
      .setValue('https://api.example.test/v1')
    await wrapper.get('[data-onboarding-loom-setup]').trigger('click')
    await flushPromises()

    expect(mock.setupLoom).toHaveBeenCalledTimes(1)
    const payload = mock.setupLoom.mock.calls[0][0] as Record<string, unknown>
    expect(payload).not.toHaveProperty('api_key')
    expect(mock.recordStep).toHaveBeenCalledWith(
      'loom',
      'completed',
      expect.objectContaining({ port: 5100, provider: 'deepseek' }),
    )
    expect(wrapper.emitted('next')).toHaveLength(1)
  })

  it('records the skipped step and advances without calling setup', async () => {
    const wrapper = mountStep()
    await flushPromises()

    await wrapper.get('[data-onboarding-loom-skip]').trigger('click')
    await flushPromises()

    expect(mock.setupLoom).not.toHaveBeenCalled()
    expect(mock.recordStep).toHaveBeenCalledWith('loom', 'skipped', {
      reason: 'user_skipped',
    })
    expect(mock.refresh).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('next')).toHaveLength(1)
  })

  it('shows a readable validation error without calling setup', async () => {
    const wrapper = mountStep()
    await flushPromises()

    await wrapper.get('[data-onboarding-loom-base-url]').setValue('')
    await wrapper.get('[data-onboarding-loom-setup]').trigger('click')
    await flushPromises()

    expect(mock.setupLoom).not.toHaveBeenCalled()
    expect(wrapper.get('[data-onboarding-loom-error]').text()).toContain('Base URL')
  })

  it('surfaces an API error and does not record or advance', async () => {
    mock.setupLoom.mockImplementation(async () => {
      mock.error.value = { message: '无法连接后端' }
      return null
    })
    const wrapper = mountStep({ currentPassword: 'pw-123' })
    await flushPromises()

    await wrapper
      .get('[data-onboarding-loom-base-url]')
      .setValue('https://api.example.test/v1')
    await wrapper.get('[data-onboarding-loom-setup]').trigger('click')
    await flushPromises()

    expect(mock.recordStep).not.toHaveBeenCalled()
    expect(mock.refresh).not.toHaveBeenCalled()
    expect(wrapper.emitted('next')).toBeUndefined()
    expect(wrapper.get('[data-onboarding-loom-error]').text()).toContain('无法连接后端')
  })

  it('does not advance when recording the completed step fails', async () => {
    mock.setupLoom.mockResolvedValue(makeSetupResult())
    mock.recordStep.mockImplementation(async () => {
      mock.error.value = { message: '进度写入失败' }
      return null
    })
    const wrapper = mountStep({ currentPassword: 'pw-123' })
    await flushPromises()

    await wrapper
      .get('[data-onboarding-loom-base-url]')
      .setValue('https://api.example.test/v1')
    await wrapper.get('[data-onboarding-loom-setup]').trigger('click')
    await flushPromises()

    expect(mock.refresh).not.toHaveBeenCalled()
    expect(wrapper.emitted('next')).toBeUndefined()
    expect(wrapper.get('[data-onboarding-loom-error]').text()).toContain('进度写入失败')
  })

  it('shows busy feedback and staged progress while applying Loom', async () => {
    const pending = deferred<LoomSetupResult>()
    mock.setupLoom.mockReturnValue(pending.promise)
    const wrapper = mountStep({ currentPassword: 'pw-123' })
    await flushPromises()

    await wrapper
      .get('[data-onboarding-loom-base-url]')
      .setValue('https://api.example.test/v1')
    const button = wrapper.get('[data-onboarding-loom-setup]')
    await button.trigger('click')

    expect(button.text()).toContain('正在启动并应用…')
    expect(button.attributes('data-busy')).toBe('true')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.find('.onboarding-spinner').exists()).toBe(true)

    const progress = wrapper.get('[data-onboarding-long-task]')
    expect(progress.text()).toContain('通常 5-20 秒，请勿关闭')
    expect(progress.text()).toContain('已用时 0 秒')

    pending.resolve(makeSetupResult())
    await flushPromises()

    expect(wrapper.find('[data-onboarding-long-task]').exists()).toBe(false)
  })
})
