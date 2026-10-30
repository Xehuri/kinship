/// <reference types="vitest/globals" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { nextTick, type Ref } from 'vue'
import type { DependenciesStatus, DownloadJob } from '@/api/system'

interface OnboardingMock {
  assets: Ref<DependenciesStatus | null>
  assetsLoading: Ref<boolean>
  error: Ref<{ message: string } | null>
  job: Ref<DownloadJob | null>
  refresh: ReturnType<typeof vi.fn>
  loadAssets: ReturnType<typeof vi.fn>
  startAssetDownload: ReturnType<typeof vi.fn>
  recordStep: ReturnType<typeof vi.fn>
}

interface JobsMock {
  job: Ref<DownloadJob | null>
  polling: Ref<boolean>
  error: Ref<{ message: string } | null>
  start: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}

const onb = vi.hoisted(() => ({}) as OnboardingMock)
const jobs = vi.hoisted(() => ({}) as JobsMock)

vi.mock('@/composables/useOnboarding', async () => {
  const { ref } = await import('vue')
  onb.assets = ref<DependenciesStatus | null>(null)
  onb.assetsLoading = ref(false)
  onb.error = ref<{ message: string } | null>(null)
  onb.job = ref<DownloadJob | null>(null)
  onb.refresh = vi.fn().mockResolvedValue(undefined)
  onb.loadAssets = vi.fn().mockResolvedValue(null)
  onb.startAssetDownload = vi.fn().mockResolvedValue(null)
  onb.recordStep = vi.fn().mockResolvedValue({})
  return {
    useOnboarding: () => ({
      assets: onb.assets,
      assetsLoading: onb.assetsLoading,
      error: onb.error,
      job: onb.job,
      refresh: onb.refresh,
      loadAssets: onb.loadAssets,
      startAssetDownload: onb.startAssetDownload,
      recordStep: onb.recordStep,
    }),
  }
})

vi.mock('@/composables/useOnboardingJobs', async () => {
  const { ref } = await import('vue')
  const terminal = new Set(['done', 'failed', 'cancelled'])
  jobs.job = ref<DownloadJob | null>(null)
  jobs.polling = ref(false)
  jobs.error = ref<{ message: string } | null>(null)
  jobs.start = vi.fn()
  jobs.restore = vi.fn()
  jobs.stop = vi.fn()
  jobs.cancel = vi.fn()
  return {
    isTerminalJobState: (state: string) => terminal.has(state),
    useOnboardingJobs: () => ({
      job: jobs.job,
      polling: jobs.polling,
      error: jobs.error,
      start: jobs.start,
      restore: jobs.restore,
      stop: jobs.stop,
      cancel: jobs.cancel,
    }),
  }
})

import KernelStep from '@/components/onboarding/steps/KernelStep.vue'

enableAutoUnmount(afterEach)

function makeAssets(
  kernelOverrides: Record<string, unknown> = {},
  pythonOverrides: Record<string, unknown> = {},
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
    ...kernelOverrides,
  }
  const python = {
    path: '/opt/kinship/.venv-kernel/bin/python',
    source: 'config',
    exists: true,
    configured: '/opt/kinship/.venv-kernel/bin/python',
    configured_exists: true,
    last_resort: false,
    ...pythonOverrides,
  }
  const dependencies = {
    kernel,
    python,
    models: {
      model_dir: '/home/user/.cache/axeuh-kernel/models',
      configured: false,
      exists: false,
    },
    disk: { path: '/srv', free: 20 * 1024 ** 3, required: 2 * 1024 ** 3, sufficient: true },
    health: {
      pidfile: '/srv/state/kernel.pid',
      found: false,
      pid: null,
      port: null,
      alive: false,
      healthy: false,
      api_version: null,
      base_url: null,
      error: null,
    },
  }
  return {
    configured: true,
    manifest: null,
    assets: {},
    dependencies,
    kernel,
    python,
    models: dependencies.models,
    disk: dependencies.disk,
    health: dependencies.health,
    error: null,
  }
}

function makeJob(overrides: Partial<DownloadJob> = {}): DownloadJob {
  return {
    id: 'job-kernel',
    kind: 'download:kernel',
    state: 'running',
    asset: 'kernel',
    progress: { bytes: 420, total: 1000, pct: 42 },
    current: 'kernel',
    logs_tail: ['[OnboardingAssets] phase=download result=start'],
    result: null,
    error: null,
    cancel_requested: false,
    created_at: '2026-10-26T00:00:00Z',
    updated_at: '2026-10-26T00:00:01Z',
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
  return mount(KernelStep, { props })
}

describe('KernelStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    onb.assets.value = makeAssets()
    onb.assetsLoading.value = false
    onb.error.value = null
    onb.job.value = null
    onb.refresh.mockReset().mockResolvedValue(undefined)
    onb.loadAssets.mockReset().mockResolvedValue(onb.assets.value)
    onb.startAssetDownload.mockReset().mockResolvedValue(null)
    onb.recordStep.mockReset().mockResolvedValue({})
    jobs.job.value = null
    jobs.polling.value = false
    jobs.error.value = null
    jobs.start.mockReset()
    jobs.restore.mockReset().mockReturnValue(false)
    jobs.stop.mockReset()
    jobs.cancel.mockReset()
  })

  it('shows the not-installed state with install, verify and skip actions', async () => {
    const wrapper = mountStep()
    await flushPromises()

    expect(onb.loadAssets).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-onboarding-step-why]').text()).toContain('为什么需要')
    expect(wrapper.get('[data-onboarding-step-why]').text()).toContain('把录音转成文字')
    expect(wrapper.get('[data-onboarding-step-why-detected]').text()).toContain(
      '自动检测',
    )
    expect(wrapper.get('[data-onboarding-kernel-status]').text()).toBe('未安装')
    expect(wrapper.get('[data-onboarding-kernel-source]').text()).toBe('未安装')
    expect(wrapper.get('[data-onboarding-kernel-python]').text()).toContain('已就绪')
    expect(wrapper.get('[data-onboarding-step-why-detected]').text()).toContain('约 70MB')
    expect(wrapper.get('[data-onboarding-kernel-install]').text()).toBe('下载内核')
    expect(wrapper.get('[data-onboarding-kernel-install]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-onboarding-kernel-verify]').text()).toContain('重新检测')
    expect(wrapper.get('[data-onboarding-kernel-skip]').text()).toContain('降级')
    expect(
      wrapper.get('[data-skip-consequence-step="kernel"]').text(),
    ).toContain('音频不会分析')
    expect(wrapper.find('[data-onboarding-kernel-password]').exists()).toBe(false)
  })

  it('offers a local build for a source checkout instead of a download', async () => {
    onb.assets.value = makeAssets({
      present: true,
      source: 'source',
      version: '1.2.3',
      installable: false,
      install_blocked_reason: 'kernel_install_forbidden_dev_checkout',
    })
    const wrapper = mountStep()
    await flushPromises()

    expect(wrapper.get('[data-onboarding-kernel-status]').text()).toBe('源码检出')
    const guard = wrapper.get('[data-onboarding-kernel-guard]')
    expect(guard.text()).toContain('源码检出')
    expect(guard.text()).toContain('本地构建')
    expect(wrapper.get('[data-onboarding-kernel-install]').text()).toBe(
      '本地构建内核（开发）',
    )
    expect(wrapper.get('[data-onboarding-kernel-install]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-onboarding-kernel-password]').exists()).toBe(false)
    expect(wrapper.get('[data-onboarding-kernel-continue]').exists()).toBe(true)
  })

  it('states the release asset size when the manifest provides it', async () => {
    const status = makeAssets()
    status.assets = {
      kernel: {
        name: 'kernel',
        file: 'axeuh-kernel-1.0.0.tar.gz',
        sha256: '0'.repeat(64),
        size: 70 * 1024 * 1024,
        url: 'https://example.com/axeuh-kernel-1.0.0.tar.gz',
        api_version: '1.0.0',
        tiers: [],
      },
    }
    onb.assets.value = status
    const wrapper = mountStep()
    await flushPromises()

    expect(wrapper.get('[data-onboarding-step-why-detected]').text()).toContain(
      '70.0 MiB',
    )
    expect(wrapper.get('[data-onboarding-kernel-install]').text()).toBe('下载内核')
  })

  it('starts the kernel install job with the currentPassword prop and renders progress with logs', async () => {
    const job = makeJob()
    onb.startAssetDownload.mockResolvedValue(job)
    const wrapper = mountStep({ currentPassword: 'pw-123' })
    await flushPromises()

    await wrapper.get('[data-onboarding-kernel-install]').trigger('click')
    await flushPromises()

    expect(onb.startAssetDownload).toHaveBeenCalledWith('kernel', undefined, 'pw-123')
    expect(jobs.start).toHaveBeenCalledWith(job)

    jobs.job.value = job
    await nextTick()
    await flushPromises()

    expect(wrapper.get('[data-onboarding-job-progress]').attributes('data-onboarding-job-progress')).toBe('42')
    expect(wrapper.get('[data-onboarding-job-progress-text]').text()).toContain('42%')
    expect(wrapper.get('[data-onboarding-job-logs]').text()).toContain('phase=download')
  })

  it('uses the shared administrator password without rendering a local field', async () => {
    const job = makeJob()
    onb.startAssetDownload.mockResolvedValue(job)
    const wrapper = mountStep({ currentPassword: 'pw-shared' })
    await flushPromises()

    expect(wrapper.find('[data-onboarding-kernel-password]').exists()).toBe(false)

    await wrapper.get('[data-onboarding-kernel-install]').trigger('click')
    await flushPromises()

    expect(onb.startAssetDownload).toHaveBeenCalledWith('kernel', undefined, 'pw-shared')
    expect(jobs.start).toHaveBeenCalledWith(job)
  })

  it('blocks the install without an entry password and keeps skip available', async () => {
    const wrapper = mountStep()
    await flushPromises()

    expect(wrapper.find('[data-onboarding-kernel-password]').exists()).toBe(false)
    await wrapper.get('[data-onboarding-kernel-install]').trigger('click')
    await flushPromises()

    expect(onb.startAssetDownload).not.toHaveBeenCalled()
    expect(wrapper.get('[data-onboarding-kernel-error]').text()).toContain('缺少入口密码')

    await wrapper.get('[data-onboarding-kernel-skip]').trigger('click')
    await flushPromises()

    expect(onb.recordStep).toHaveBeenCalledWith(
      'kernel',
      'skipped',
      expect.objectContaining({ skipped: true }),
    )
    expect(wrapper.emitted('next')).toHaveLength(1)
  })

  it('re-reads assets and status when verification is requested', async () => {
    const wrapper = mountStep()
    await flushPromises()

    await wrapper.get('[data-onboarding-kernel-verify]').trigger('click')
    await flushPromises()

    expect(onb.loadAssets).toHaveBeenCalledTimes(2)
    expect(onb.refresh).toHaveBeenCalledTimes(1)
  })

  it('records a skipped kernel with the degraded warning and advances', async () => {
    const wrapper = mountStep()
    await flushPromises()

    await wrapper.get('[data-onboarding-kernel-skip]').trigger('click')
    await flushPromises()

    expect(onb.recordStep).toHaveBeenCalledWith(
      'kernel',
      'skipped',
      expect.objectContaining({
        skipped: true,
        degraded: true,
        warning: 'audio_pipeline_unavailable',
      }),
    )
    expect(onb.refresh).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('next')).toHaveLength(1)
  })

  it('warns when the kernel python runtime is missing and hides continue', async () => {
    onb.assets.value = makeAssets(
      {
        present: true,
        source: 'release',
        version: '1.0.0',
        installed_from_release: true,
      },
      { exists: false },
    )
    const wrapper = mountStep()
    await flushPromises()

    expect(wrapper.get('[data-onboarding-kernel-python]').text()).toContain('未找到')
    expect(wrapper.get('[data-onboarding-kernel-python-missing]').text()).toContain(
      '无法启动',
    )
    expect(wrapper.find('[data-onboarding-kernel-continue]').exists()).toBe(false)
  })

  it('records the installed kernel and advances after confirmation', async () => {
    onb.assets.value = makeAssets({
      present: true,
      source: 'release',
      version: '1.0.0',
      installed_from_release: true,
    })
    const wrapper = mountStep()
    await flushPromises()

    await wrapper.get('[data-onboarding-kernel-continue]').trigger('click')
    await flushPromises()

    expect(onb.recordStep).toHaveBeenCalledWith(
      'kernel',
      'completed',
      expect.objectContaining({
        source: 'release',
        version: '1.0.0',
        degraded: false,
      }),
    )
    expect(onb.refresh).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('next')).toHaveLength(1)
  })

  it('adopts a kernel job started from the dependencies step', async () => {
    const job = makeJob()
    onb.job.value = job
    mountStep()
    await flushPromises()

    expect(jobs.start).toHaveBeenCalledWith(job)
  })

  it('reloads assets and shows a success notice when the install job finishes', async () => {
    const wrapper = mountStep()
    await flushPromises()

    jobs.job.value = makeJob({ state: 'done', progress: { bytes: 1000, total: 1000, pct: 100 } })
    await nextTick()
    await flushPromises()

    expect(onb.loadAssets).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-onboarding-kernel-job-notice]').text()).toContain('安装完成')
  })

  it('shows a busy label and spinner immediately while starting the install', async () => {
    const pending = deferred<DownloadJob>()
    onb.startAssetDownload.mockReturnValue(pending.promise)
    jobs.start.mockImplementation((job: DownloadJob) => {
      jobs.job.value = job
    })
    const wrapper = mountStep({ currentPassword: 'pw-123' })
    await flushPromises()

    const button = wrapper.get('[data-onboarding-kernel-install]')
    await button.trigger('click')

    expect(button.text()).toContain('正在启动安装…')
    expect(button.attributes('data-busy')).toBe('true')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.find('.onboarding-spinner').exists()).toBe(true)

    pending.resolve(makeJob())
    await flushPromises()

    expect(button.text()).toContain('安装中…')
  })

  it('shows a busy label and spinner while confirming the kernel is ready', async () => {
    onb.assets.value = makeAssets({
      present: true,
      source: 'release',
      version: '1.0.0',
      installed_from_release: true,
    })
    const pending = deferred<Record<string, unknown>>()
    onb.recordStep.mockReturnValue(pending.promise)
    const wrapper = mountStep()
    await flushPromises()

    const button = wrapper.get('[data-onboarding-kernel-continue]')
    await button.trigger('click')

    expect(button.text()).toContain('正在确认…')
    expect(button.attributes('data-busy')).toBe('true')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.find('.onboarding-spinner').exists()).toBe(true)

    pending.resolve({})
    await flushPromises()

    expect(wrapper.emitted('next')).toHaveLength(1)
  })

  it('shows a busy label while skipping the kernel', async () => {
    const pending = deferred<Record<string, unknown>>()
    onb.recordStep.mockReturnValue(pending.promise)
    const wrapper = mountStep()
    await flushPromises()

    const button = wrapper.get('[data-onboarding-kernel-skip]')
    await button.trigger('click')

    expect(button.text()).toContain('正在跳过…')
    expect(button.attributes('data-busy')).toBe('true')

    pending.resolve({})
    await flushPromises()

    expect(wrapper.emitted('next')).toHaveLength(1)
  })

  it('restores a persisted kernel job when no shared job exists', async () => {
    jobs.restore.mockReturnValue(true)
    mountStep()
    await flushPromises()

    expect(jobs.restore).toHaveBeenCalledWith('kernel')
  })

  it('explains the kernel runtime install for prebuilt downloads', async () => {
    const wrapper = mountStep()
    await flushPromises()

    const note = wrapper.get('[data-onboarding-kernel-runtime-note]')
    expect(note.text()).toContain('.venv-kernel')
    expect(note.text()).toContain('GPU')
    expect(note.text()).toContain('1.1GB')
    expect(note.text()).toContain('6.3GB')
    expect(note.text()).toContain('关闭页面不会中断')
  })

  it('hides the runtime note for a source checkout', async () => {
    onb.assets.value = makeAssets({
      present: true,
      source: 'source',
      version: '1.2.3',
      installable: false,
      install_blocked_reason: 'kernel_install_forbidden_dev_checkout',
    })
    const wrapper = mountStep()
    await flushPromises()

    expect(wrapper.find('[data-onboarding-kernel-runtime-note]').exists()).toBe(false)
  })
})
