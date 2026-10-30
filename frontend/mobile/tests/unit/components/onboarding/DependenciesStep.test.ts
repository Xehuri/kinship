/// <reference types="vitest/globals" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import type { Ref } from 'vue'
import type { DependenciesStatus, PreflightResult } from '@/api/system'

interface OnboardingMock {
  preflight: Ref<PreflightResult | null>
  assets: Ref<DependenciesStatus | null>
  assetsLoading: Ref<boolean>
  error: Ref<{ message: string } | null>
  refresh: ReturnType<typeof vi.fn>
  loadAssets: ReturnType<typeof vi.fn>
  recordStep: ReturnType<typeof vi.fn>
}

const onb = vi.hoisted(() => ({}) as OnboardingMock)

vi.mock('@/composables/useOnboarding', async () => {
  const { ref } = await import('vue')
  onb.preflight = ref<PreflightResult | null>(null)
  onb.assets = ref<DependenciesStatus | null>(null)
  onb.assetsLoading = ref(false)
  onb.error = ref<{ message: string } | null>(null)
  onb.refresh = vi.fn().mockResolvedValue(undefined)
  onb.loadAssets = vi.fn().mockResolvedValue(null)
  onb.recordStep = vi.fn().mockResolvedValue({})
  return {
    useOnboarding: () => ({
      preflight: onb.preflight,
      assets: onb.assets,
      assetsLoading: onb.assetsLoading,
      error: onb.error,
      refresh: onb.refresh,
      loadAssets: onb.loadAssets,
      recordStep: onb.recordStep,
    }),
  }
})

import DependenciesStep from '@/components/onboarding/steps/DependenciesStep.vue'

enableAutoUnmount(afterEach)

function makePreflight(): PreflightResult {
  return {
    checks: [
      {
        id: 'ai_dir',
        label: 'AI 数据目录',
        status: 'pass',
        blocking: false,
        category: 'assets',
        detail: '/srv/ai 已存在且包含 AI 结构',
        fix: '',
      },
    ],
    can_proceed: true,
    blocking_failures: [],
    soft_failures: [],
    summary: { pass: 1, warn: 0, fail: 0 },
  }
}

function makeAssets(
  overrides: Partial<DependenciesStatus> = {},
): DependenciesStatus {
  const kernel = {
    dir: '/srv/kernel',
    present: false,
    source: null as 'release' | 'source' | 'unknown' | null,
    version: null as string | null,
    marker: '',
    installed_from_release: false,
    installable: true,
    install_blocked_reason: null as string | null,
  }
  const python = {
    path: '/opt/kinship/.venv-kernel/bin/python',
    source: 'config',
    exists: true,
    configured: '/opt/kinship/.venv-kernel/bin/python',
    configured_exists: true,
    last_resort: false,
  }
  const models = {
    model_dir: '/home/user/.cache/axeuh-kernel/models',
    configured: false,
    exists: false,
  }
  const disk = {
    path: '/srv',
    free: 20 * 1024 ** 3,
    required: 2 * 1024 ** 3,
    sufficient: true,
  }
  const health = {
    pidfile: '/srv/state/kernel.pid',
    found: false,
    pid: null,
    port: null,
    alive: false,
    healthy: false,
    api_version: null,
    base_url: null,
    error: null,
  }
  const dependencies = { kernel, python, models, disk, health }
  return {
    configured: true,
    manifest: null,
    assets: {},
    dependencies,
    kernel,
    python,
    models,
    disk,
    health,
    error: null,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function mountStep(props: { currentPassword?: string } = {}) {
  return mount(DependenciesStep, { props })
}

describe('DependenciesStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    onb.preflight.value = makePreflight()
    onb.assets.value = makeAssets()
    onb.assetsLoading.value = false
    onb.error.value = null
    onb.refresh.mockReset().mockResolvedValue(undefined)
    onb.loadAssets.mockReset().mockResolvedValue(onb.assets.value)
    onb.recordStep.mockReset().mockResolvedValue({})
  })

  it('renders the dependency cards without any download controls', async () => {
    const wrapper = mountStep()
    await flushPromises()

    expect(onb.refresh).toHaveBeenCalledTimes(1)
    expect(onb.loadAssets).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('[data-onboarding-dependency-card]')).toHaveLength(5)
    expect(wrapper.get('[data-onboarding-dependency-card="ai_dir"]').text()).toContain(
      'AI 工作目录',
    )
    expect(wrapper.get('[data-onboarding-dependency-card="kernel"]').text()).toContain(
      'kernel/ 目录不存在',
    )
    expect(wrapper.find('[data-onboarding-dependencies-choice]').exists()).toBe(false)
    expect(wrapper.find('[data-onboarding-dependencies-start]').exists()).toBe(false)
    expect(wrapper.find('[data-onboarding-dependencies-decline]').exists()).toBe(false)
    expect(wrapper.find('[data-onboarding-dependencies-ack]').exists()).toBe(false)
    expect(wrapper.find('[data-onboarding-security]').exists()).toBe(true)
    expect(wrapper.get('[data-onboarding-dependencies-ai-note]').text()).toContain(
      '不会下载任何东西',
    )
  })

  it('renders the why block with the detected check summary', async () => {
    const wrapper = mountStep()
    await flushPromises()

    const why = wrapper.get('[data-onboarding-step-why]')
    expect(why.attributes('data-step-id')).toBe('dependencies')
    expect(why.text()).toContain('为什么需要')
    expect(why.text()).toContain('这里不会下载任何东西')
    const detected = wrapper.get('[data-onboarding-step-why-detected]')
    expect(detected.text()).toContain('自动检测')
    expect(detected.text()).toContain('5 项')
    expect(detected.text()).toContain('正常 3')
  })

  it('shows a busy label immediately while recording the checks', async () => {
    const pending = deferred<Record<string, unknown>>()
    onb.recordStep.mockReturnValue(pending.promise)
    const wrapper = mountStep()
    await flushPromises()

    const button = wrapper.get('[data-onboarding-dependencies-continue]')
    await button.trigger('click')

    expect(button.text()).toContain('正在记录检查结果…')
    expect(button.attributes('data-busy')).toBe('true')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.find('.onboarding-spinner').exists()).toBe(true)

    pending.resolve({})
    await flushPromises()

    expect(wrapper.emitted('next')).toHaveLength(1)
    expect(button.attributes('data-busy')).toBeUndefined()
  })

  it('records the checks choice with a dependency snapshot and advances', async () => {
    const wrapper = mountStep()
    await flushPromises()

    await wrapper.get('[data-onboarding-dependencies-continue]').trigger('click')
    await flushPromises()

    expect(onb.recordStep).toHaveBeenCalledWith(
      'dependencies',
      'completed',
      expect.objectContaining({
        choice: 'checks',
        degraded: false,
        audio_pipeline: 'pending',
        dependencies: expect.objectContaining({
          kernel: expect.objectContaining({ present: false }),
          python: expect.objectContaining({ exists: true }),
          disk: expect.objectContaining({ sufficient: true }),
        }),
      }),
    )
    expect(onb.refresh).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('next')).toHaveLength(1)
  })

  it('surfaces a record failure and does not advance', async () => {
    onb.recordStep.mockResolvedValue(null)
    onb.error.value = { message: '写入进度失败' }
    const wrapper = mountStep()
    await flushPromises()

    await wrapper.get('[data-onboarding-dependencies-continue]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-onboarding-dependencies-error]').text()).toContain(
      '写入进度失败',
    )
    expect(wrapper.emitted('next')).toBeUndefined()
  })
})
