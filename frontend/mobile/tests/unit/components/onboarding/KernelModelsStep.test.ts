/// <reference types="vitest/globals" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { nextTick, type Ref } from 'vue'
import type {
  DependenciesStatus,
  DownloadJob,
  KernelModelAssetStatus,
  KernelModelCatalog,
  KernelModelTierStatus,
  StorageSnapshot,
} from '@/api/system'

interface OnboardingMock {
  assets: Ref<DependenciesStatus | null>
  error: Ref<{ message: string; status?: number } | null>
  job: Ref<DownloadJob | null>
  storage: Ref<StorageSnapshot | null>
  storageLoading: Ref<boolean>
  refresh: ReturnType<typeof vi.fn>
  loadAssets: ReturnType<typeof vi.fn>
  loadStorage: ReturnType<typeof vi.fn>
  saveStorage: ReturnType<typeof vi.fn>
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
const api = vi.hoisted(() => ({
  getKernelModels: vi.fn(),
  startKernelModelsDownload: vi.fn(),
}))

vi.mock('@/composables/useOnboarding', async () => {
  const { ref } = await import('vue')
  onb.assets = ref<DependenciesStatus | null>(null)
  onb.error = ref<{ message: string; status?: number } | null>(null)
  onb.job = ref<DownloadJob | null>(null)
  onb.storage = ref<StorageSnapshot | null>(null)
  onb.storageLoading = ref(false)
  onb.refresh = vi.fn().mockResolvedValue(undefined)
  onb.loadAssets = vi.fn().mockResolvedValue(null)
  onb.loadStorage = vi.fn().mockResolvedValue(null)
  onb.saveStorage = vi.fn().mockResolvedValue(null)
  onb.recordStep = vi.fn().mockResolvedValue({})
  return {
    useOnboarding: () => ({
      assets: onb.assets,
      error: onb.error,
      job: onb.job,
      storage: onb.storage,
      storageLoading: onb.storageLoading,
      refresh: onb.refresh,
      loadAssets: onb.loadAssets,
      loadStorage: onb.loadStorage,
      saveStorage: onb.saveStorage,
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

vi.mock('@/api/system', () => ({
  getKernelModels: api.getKernelModels,
  startKernelModelsDownload: api.startKernelModelsDownload,
}))

import KernelModelsStep from '@/components/onboarding/steps/KernelModelsStep.vue'

enableAutoUnmount(afterEach)

const MODEL_IDS = {
  required: [
    'eres2netv2',
    'sensevoice',
    'fsmn-vad',
    'pyannote-segmentation',
    'pyannote-diarization',
    'wespeaker',
  ],
  recommended: ['kws-zipformer'],
  optional: ['cnn14'],
}

function makeAssets(free = 20 * 1024 ** 3): DependenciesStatus {
  const dependencies = {
    kernel: {
      dir: '/srv/kernel',
      present: true,
      source: 'release' as const,
      version: '1.0.0',
      marker: '/srv/kernel/.installed.json',
      installed_from_release: true,
      installable: true,
      install_blocked_reason: null,
    },
    python: {
      path: '/opt/kinship/.venv-kernel/bin/python',
      source: 'config',
      exists: true,
      configured: '',
      configured_exists: true,
      last_resort: false,
    },
    models: {
      model_dir: '/home/user/.cache/axeuh-kernel/models',
      configured: false,
      exists: true,
    },
    disk: { path: '/srv', free, required: 1024 ** 3, sufficient: free >= 1024 ** 3 },
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
    kernel: dependencies.kernel,
    python: dependencies.python,
    models: dependencies.models,
    disk: dependencies.disk,
    health: dependencies.health,
    error: null,
  }
}

function makeCatalog(
  presentOverrides: Record<string, boolean> = {},
): KernelModelCatalog {
  const present: Record<string, boolean> = {
    eres2netv2: true,
    sensevoice: false,
    'fsmn-vad': true,
    'pyannote-segmentation': true,
    'pyannote-diarization': true,
    wespeaker: true,
    'kws-zipformer': false,
    cnn14: false,
    ...presentOverrides,
  }
  const sources: Record<string, string> = {
    eres2netv2: 'bundled',
    sensevoice: 'modelscope',
    'fsmn-vad': 'modelscope',
    'pyannote-segmentation': 'modelscope',
    'pyannote-diarization': 'modelscope',
    wespeaker: 'modelscope',
    'kws-zipformer': 'upstream',
    cnn14: 'upstream',
  }
  const sizes: Record<string, number> = {
    eres2netv2: 74_000_000,
    sensevoice: 940_000_000,
    'fsmn-vad': 4_000_000,
    'pyannote-segmentation': 12_000_000,
    'pyannote-diarization': 22_000_000,
    wespeaker: 53_000_000,
    'kws-zipformer': 40_000_000,
    cnn14: 358_000_000,
  }
  const tiers = [
    { id: 'required', ids: MODEL_IDS.required },
    { id: 'recommended', ids: MODEL_IDS.recommended },
    { id: 'optional', ids: MODEL_IDS.optional },
  ]
  const models: KernelModelAssetStatus[] = Object.entries(sources).map(([id, source]) => ({
    id,
    tier: tiers.find((tier) => tier.ids.includes(id))!.id,
    source,
    repo: `repo/${id}`,
    target: `/models/${id}`,
    kind: 'directory',
    size_bytes: sizes[id],
    gated: id === 'cnn14',
    present: present[id],
    missing_files: present[id] ? [] : ['model.pt'],
    error: null,
  }))
  const tierRows: KernelModelTierStatus[] = tiers.map((tier) => ({
    id: tier.id,
    model_ids: tier.ids,
    total_size_bytes: tier.ids.reduce((sum, id) => sum + sizes[id], 0),
    missing_size_bytes: tier.ids.reduce(
      (sum, id) => sum + (present[id] ? 0 : sizes[id]),
      0,
    ),
  }))
  return {
    manifest_version: '2026.10.26',
    models,
    tiers: tierRows,
    total_size_bytes: models.reduce((sum, model) => sum + model.size_bytes, 0),
    required_size_bytes: tierRows.find((tier) => tier.id === 'required')!
      .total_size_bytes,
  }
}

function makeJob(overrides: Partial<DownloadJob> = {}): DownloadJob {
  return {
    id: 'job-models',
    kind: 'download:models',
    state: 'running',
    asset: 'models',
    progress: { bytes: 420_000_000, total: 1_000_000_000, pct: 42 },
    current: 'models',
    logs_tail: ['[KernelModels] phase=download model=sensevoice result=start'],
    result: null,
    error: null,
    cancel_requested: false,
    created_at: '2026-10-26T00:00:00Z',
    updated_at: '2026-10-26T00:00:01Z',
    ...overrides,
  }
}

function makeStorage(
  overrides: Partial<StorageSnapshot> = {},
): StorageSnapshot {
  return {
    data_root: '/srv/var',
    models_root: '/opt/kinship-models',
    free_bytes: 64 * 1024 ** 3,
    writable: true,
    source: { data_root: 'config', models_root: 'config' },
    models_dir_configured: true,
    data_root_configured: true,
    legacy: {
      exists: false,
      home: '/home/user',
      suggested_root: null,
      modelscope: false,
      huggingface: false,
      axeuh_kernel: false,
      paths: {},
    },
    system_disk: false,
    system_drive: null,
    warnings: [],
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
  return mount(KernelModelsStep, { props })
}

describe('KernelModelsStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    onb.assets.value = makeAssets()
    onb.error.value = null
    onb.job.value = null
    onb.refresh.mockReset().mockResolvedValue(undefined)
    onb.loadAssets.mockReset().mockResolvedValue(onb.assets.value)
    onb.storage.value = makeStorage()
    onb.storageLoading.value = false
    onb.loadStorage.mockReset().mockResolvedValue(onb.storage.value)
    onb.saveStorage.mockReset().mockResolvedValue(makeStorage())
    onb.recordStep.mockReset().mockResolvedValue({})
    jobs.job.value = null
    jobs.polling.value = false
    jobs.error.value = null
    jobs.start.mockReset()
    jobs.restore.mockReset().mockReturnValue(false)
    jobs.stop.mockReset()
    jobs.cancel.mockReset()
    api.getKernelModels.mockReset().mockResolvedValue(makeCatalog())
    api.startKernelModelsDownload.mockReset().mockResolvedValue(null)
  })

  it('loads the catalog and preselects required plus recommended while optional stays off', async () => {
    const wrapper = mountStep()
    await flushPromises()

    expect(
      wrapper.get('[data-skip-consequence-step="kernel_models"]').text(),
    ).toContain('跳过会怎样')
    expect(wrapper.get('[data-onboarding-step-why]').text()).toContain('为什么需要')
    expect(wrapper.get('[data-onboarding-step-why]').text()).toContain('模型决定识别准不准')
    expect(wrapper.get('[data-onboarding-step-why-detected]').text()).toContain(
      '自动检测',
    )
    expect(api.getKernelModels).toHaveBeenCalledTimes(1)
    const required = wrapper.get('[data-onboarding-model-tier-check="required"]')
    const recommended = wrapper.get('[data-onboarding-model-tier-check="recommended"]')
    const optional = wrapper.get('[data-onboarding-model-tier-check="optional"]')
    expect((required.element as HTMLInputElement).checked).toBe(true)
    expect(required.attributes('disabled')).toBeDefined()
    expect((recommended.element as HTMLInputElement).checked).toBe(true)
    expect((optional.element as HTMLInputElement).checked).toBe(false)

    expect(wrapper.get('[data-onboarding-model-row="eres2netv2"]').attributes('data-status')).toBe(
      'present',
    )
    expect(wrapper.get('[data-onboarding-model-row="sensevoice"]').attributes('data-status')).toBe(
      'missing',
    )
    expect(wrapper.get('[data-onboarding-model-row="cnn14"]').attributes('data-status')).toBe(
      'gated',
    )
    expect(wrapper.find('[data-onboarding-models-continue]').exists()).toBe(false)
    expect(wrapper.find('[data-onboarding-models-password]').exists()).toBe(false)
  })

  it('reveals the gated reason when the optional tier is selected and never fakes readiness', async () => {
    const wrapper = mountStep()
    await flushPromises()

    await wrapper.get('[data-onboarding-model-tier-check="optional"]').setValue(true)
    await nextTick()

    expect(wrapper.get('[data-onboarding-models-gated-warning]').text()).toContain('cnn14')
    expect(wrapper.get('[data-onboarding-models-gated-warning]').text()).toContain('HF_TOKEN')
    const row = wrapper.get('[data-onboarding-model-row="cnn14"]')
    expect(row.get('[data-onboarding-model-gated]').text()).toContain('授权')
    expect(row.get('[data-onboarding-model-gated]').text()).not.toContain('成功下载')
    expect(row.text()).not.toContain('已就绪')
  })

  it('starts the models download for the selected tiers with the currentPassword prop', async () => {
    const job = makeJob()
    api.startKernelModelsDownload.mockResolvedValue(job)
    const wrapper = mountStep({ currentPassword: 'pw-123' })
    await flushPromises()

    await wrapper.get('[data-onboarding-models-download]').trigger('click')
    await flushPromises()

    expect(api.startKernelModelsDownload).toHaveBeenCalledWith(
      { tiers: ['required', 'recommended'] },
      undefined,
      'pw-123',
    )
    expect(jobs.start).toHaveBeenCalledWith(job)
    expect(onb.job.value?.id).toBe('job-models')
  })

  it('uses the shared administrator password without rendering a local field', async () => {
    const job = makeJob()
    api.startKernelModelsDownload.mockResolvedValue(job)
    const wrapper = mountStep({ currentPassword: 'pw-shared' })
    await flushPromises()

    expect(wrapper.find('[data-onboarding-models-password]').exists()).toBe(false)

    await wrapper.get('[data-onboarding-models-download]').trigger('click')
    await flushPromises()

    expect(api.startKernelModelsDownload).toHaveBeenCalledWith(
      { tiers: ['required', 'recommended'] },
      undefined,
      'pw-shared',
    )
    expect(jobs.start).toHaveBeenCalledWith(job)
  })

  it('blocks the download without an entry password', async () => {
    const wrapper = mountStep()
    await flushPromises()

    expect(wrapper.find('[data-onboarding-models-password]').exists()).toBe(false)
    await wrapper.get('[data-onboarding-models-download]').trigger('click')
    await flushPromises()

    expect(api.startKernelModelsDownload).not.toHaveBeenCalled()
    expect(wrapper.get('[data-onboarding-models-error]').text()).toContain(
      '缺少入口密码',
    )
  })

  it('blocks the storage save without an entry password', async () => {
    const wrapper = mountStep()
    await flushPromises()

    await wrapper.get('[data-onboarding-storage-input]').setValue('/data/models')
    await wrapper.get('[data-onboarding-storage-save]').trigger('click')
    await flushPromises()

    expect(onb.saveStorage).not.toHaveBeenCalled()
    expect(wrapper.get('[data-onboarding-storage-error]').text()).toContain(
      '请输入当前管理员密码',
    )
  })

  it('warns when the estimated download exceeds the free disk space', async () => {
    onb.assets.value = makeAssets(100 * 1024 ** 2)
    const wrapper = mountStep()
    await flushPromises()

    expect(wrapper.get('[data-onboarding-models-disk-warning]').text()).toContain('空间不足')
  })

  it('renders live job progress and a failure without claiming success', async () => {
    const wrapper = mountStep()
    await flushPromises()

    jobs.job.value = makeJob()
    await nextTick()
    await flushPromises()

    expect(wrapper.get('[data-onboarding-job-progress]').attributes('data-onboarding-job-progress')).toBe('42')
    expect(wrapper.get('[data-onboarding-job-logs]').text()).toContain('sensevoice')

    jobs.job.value = makeJob({
      state: 'failed',
      error: '模型下载未完成: sensevoice',
      progress: { bytes: 420_000_000, total: 1_000_000_000, pct: 42 },
    })
    await nextTick()
    await flushPromises()

    expect(api.getKernelModels).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-onboarding-models-error]').text()).toContain('未完成')
    expect(wrapper.find('[data-onboarding-models-job-notice]').exists()).toBe(false)
    expect(wrapper.get('[data-onboarding-model-row="sensevoice"]').attributes('data-status')).toBe(
      'missing',
    )
  })

  it('re-reads the catalog after a finished job and enables continue when required models are ready', async () => {
    api.getKernelModels
      .mockResolvedValueOnce(makeCatalog())
      .mockResolvedValueOnce(makeCatalog({ sensevoice: true }))
    const wrapper = mountStep()
    await flushPromises()

    expect(wrapper.find('[data-onboarding-models-continue]').exists()).toBe(false)

    jobs.job.value = makeJob({
      state: 'done',
      progress: { bytes: 1_000_000_000, total: 1_000_000_000, pct: 100 },
    })
    await nextTick()
    await flushPromises()

    expect(api.getKernelModels).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-onboarding-models-job-notice]').text()).toContain('重新检测')
    expect(wrapper.find('[data-onboarding-models-continue]').exists()).toBe(true)
  })

  it('re-reads model status on verification', async () => {
    const wrapper = mountStep()
    await flushPromises()

    await wrapper.get('[data-onboarding-models-verify]').trigger('click')
    await flushPromises()

    expect(api.getKernelModels).toHaveBeenCalledTimes(2)
    expect(onb.loadAssets).toHaveBeenCalledTimes(2)
    expect(onb.refresh).toHaveBeenCalledTimes(1)
  })

  it('records a completed model step when required models are present', async () => {
    api.getKernelModels.mockResolvedValue(makeCatalog({ sensevoice: true }))
    const wrapper = mountStep()
    await flushPromises()

    await wrapper.get('[data-onboarding-models-continue]').trigger('click')
    await flushPromises()

    expect(onb.recordStep).toHaveBeenCalledWith(
      'kernel_models',
      'completed',
      expect.objectContaining({
        required_ready: true,
        degraded: false,
      }),
    )
    expect(onb.refresh).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('next')).toHaveLength(1)
  })

  it('records a skipped model step with degraded and advances', async () => {
    const wrapper = mountStep()
    await flushPromises()

    await wrapper.get('[data-onboarding-models-skip]').trigger('click')
    await flushPromises()

    expect(onb.recordStep).toHaveBeenCalledWith(
      'kernel_models',
      'skipped',
      expect.objectContaining({
        skipped: true,
        degraded: true,
        warning: 'audio_pipeline_unavailable',
        required_missing: ['sensevoice'],
      }),
    )
    expect(onb.refresh).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('next')).toHaveLength(1)
  })

  it('shows the current model root, free space, system disk warning and legacy hint', async () => {
    const storage = makeStorage({
      models_root: 'C:\\models',
      free_bytes: 12 * 1024 ** 3,
      system_disk: true,
      system_drive: 'C:',
      warnings: ['模型根位于系统盘（C:），建议改到独立数据盘。'],
      legacy: {
        exists: true,
        home: 'C:\\Users\\user',
        suggested_root: 'C:\\Users\\user',
        modelscope: true,
        huggingface: true,
        axeuh_kernel: false,
        paths: { modelscope: 'C:\\Users\\user\\.cache\\modelscope' },
      },
    })
    onb.storage.value = storage
    onb.loadStorage.mockResolvedValue(storage)
    const wrapper = mountStep()
    await flushPromises()

    expect(wrapper.get('[data-onboarding-storage-root]').text()).toContain(
      'C:\\models',
    )
    expect(wrapper.get('[data-onboarding-storage-free]').text()).toContain('GiB')
    expect(wrapper.get('[data-onboarding-storage-writable]').text()).toContain(
      '可写',
    )
    expect(wrapper.get('[data-onboarding-storage-system-disk]').text()).toContain(
      '系统盘',
    )
    expect(wrapper.get('[data-onboarding-storage-legacy]').text()).toContain(
      '不会迁移',
    )
    expect(wrapper.get('[data-onboarding-storage-use-legacy]').text()).toContain(
      '临时',
    )
    expect(
      (wrapper.get('[data-onboarding-storage-input]').element as HTMLInputElement)
        .value,
    ).toBe('C:\\models')
  })

  it('saves an absolute models.dir with the shared password and reloads models/assets', async () => {
    const saved = makeStorage({
      models_root: '/opt/kinship-models',
      source: { data_root: 'config', models_root: 'config' },
    })
    onb.saveStorage.mockResolvedValue(saved)
    onb.loadStorage.mockResolvedValue(saved)
    const wrapper = mountStep({ currentPassword: 'pw-shared' })
    await flushPromises()

    await wrapper.get('[data-onboarding-storage-input]').setValue(
      '/opt/kinship-models',
    )
    await wrapper.get('[data-onboarding-storage-save]').trigger('click')
    await flushPromises()

    expect(onb.saveStorage).toHaveBeenCalledWith(
      '/opt/kinship-models',
      undefined,
      'pw-shared',
    )
    expect(api.getKernelModels).toHaveBeenCalledTimes(2)
    expect(onb.loadAssets).toHaveBeenCalledTimes(2)
    expect(onb.loadStorage).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-onboarding-storage-notice]').text()).toContain(
      '/opt/kinship-models',
    )
  })

  it.each([403, 409])(
    'shows the %i error returned by the storage save',
    async (status) => {
      onb.saveStorage.mockResolvedValue(null)
      onb.error.value = {
        status,
        message: '环境变量覆盖了 models.dir',
      }
      const wrapper = mountStep({ currentPassword: 'pw-shared' })
      await flushPromises()

      await wrapper.get('[data-onboarding-storage-input]').setValue('/data/models')
      await wrapper.get('[data-onboarding-storage-save]').trigger('click')
      await flushPromises()

      const error = wrapper.get('[data-onboarding-storage-error]').text()
      expect(error).toContain('保存失败')
      expect(error).toContain('环境变量覆盖了 models.dir')
    },
  )

  it('switches to the legacy cache root as a temporary root after password', async () => {
    const legacy = makeStorage({
      models_root: '/home/user',
      legacy: {
        exists: true,
        home: '/home/user',
        suggested_root: '/home/user',
        modelscope: true,
        huggingface: false,
        axeuh_kernel: false,
        paths: {},
      },
    })
    onb.storage.value = legacy
    onb.loadStorage.mockResolvedValue(legacy)
    onb.saveStorage.mockResolvedValue(legacy)
    const wrapper = mountStep({ currentPassword: 'pw-shared' })
    await flushPromises()

    await wrapper.get('[data-onboarding-storage-use-legacy]').trigger('click')
    await flushPromises()

    expect(onb.saveStorage).toHaveBeenCalledWith(
      '/home/user',
      undefined,
      'pw-shared',
    )
    const notice = wrapper.get('[data-onboarding-storage-notice]').text()
    expect(notice).toContain('临时')
    expect(notice).toContain('不会迁移')
  })

  it('hides the legacy quick action when no legacy cache exists', async () => {
    const wrapper = mountStep()
    await flushPromises()

    expect(wrapper.find('[data-onboarding-storage-legacy]').exists()).toBe(false)
  })

  it('shows a busy label and spinner immediately while starting the download', async () => {
    const pending = deferred<DownloadJob>()
    api.startKernelModelsDownload.mockReturnValue(pending.promise)
    jobs.start.mockImplementation((job: DownloadJob) => {
      jobs.job.value = job
    })
    const wrapper = mountStep({ currentPassword: 'pw-123' })
    await flushPromises()

    const button = wrapper.get('[data-onboarding-models-download]')
    await button.trigger('click')

    expect(button.text()).toContain('正在启动下载…')
    expect(button.attributes('data-busy')).toBe('true')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.find('.onboarding-spinner').exists()).toBe(true)

    pending.resolve(makeJob())
    await flushPromises()

    expect(button.text()).toContain('下载中…')
  })

  it('shows a busy label while confirming the models are ready', async () => {
    const pending = deferred<Record<string, unknown>>()
    onb.recordStep.mockReturnValue(pending.promise)
    api.getKernelModels.mockResolvedValue(
      makeCatalog({
        eres2netv2: true,
        sensevoice: true,
        'fsmn-vad': true,
        'pyannote-segmentation': true,
        'pyannote-diarization': true,
        wespeaker: true,
      }),
    )
    const wrapper = mountStep()
    await flushPromises()

    const button = wrapper.get('[data-onboarding-models-continue]')
    await button.trigger('click')

    expect(button.text()).toContain('正在确认…')
    expect(button.attributes('data-busy')).toBe('true')

    pending.resolve({})
    await flushPromises()

    expect(wrapper.emitted('next')).toHaveLength(1)
  })

  it('restores a persisted models job when no shared job exists', async () => {
    jobs.restore.mockReturnValue(true)
    mountStep()
    await flushPromises()

    expect(jobs.restore).toHaveBeenCalledWith('models')
  })
})
