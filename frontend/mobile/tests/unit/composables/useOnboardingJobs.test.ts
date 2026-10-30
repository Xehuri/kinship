/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope, type EffectScope } from 'vue'

const mocks = vi.hoisted(() => ({
  getOnboardingJob: vi.fn(),
  cancelOnboardingJob: vi.fn(),
}))

vi.mock('@/api/system', () => {
  class SystemApiError extends Error {
    readonly status: number
    readonly code: string

    constructor(status: number, code: string, message: string) {
      super(message)
      this.name = 'SystemApiError'
      this.status = status
      this.code = code
    }
  }
  return {
    SystemApiError,
    getOnboardingJob: mocks.getOnboardingJob,
    cancelOnboardingJob: mocks.cancelOnboardingJob,
  }
})

import {
  isTerminalJobState,
  readPersistedOnboardingJob,
  useOnboardingJobs,
  type UseOnboardingJobsReturn,
} from '@/composables/useOnboardingJobs'
import { SystemApiError, type DownloadJob } from '@/api/system'

function makeJob(overrides: Partial<DownloadJob> = {}): DownloadJob {
  return {
    id: 'job-1',
    kind: 'download:kernel',
    state: 'running',
    asset: 'kernel',
    progress: { bytes: 0, total: 100, pct: 0 },
    current: 'download',
    logs_tail: [],
    result: null,
    error: null,
    cancel_requested: false,
    created_at: '2026-10-26T00:00:00Z',
    updated_at: '2026-10-26T00:00:01Z',
    ...overrides,
  }
}

describe('useOnboardingJobs', () => {
  let scope: EffectScope

  function createJobs(): UseOnboardingJobsReturn {
    return useOnboardingJobs({ baseDelayMs: 100, maxDelayMs: 400 })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    localStorage.clear()
    scope = effectScope()
  })

  afterEach(() => {
    scope.stop()
    vi.useRealTimers()
  })

  it('polls after the base delay and stops on done', async () => {
    mocks.getOnboardingJob.mockResolvedValue(makeJob({ state: 'done' }))
    const jobs = scope.run(createJobs)!

    jobs.start(makeJob())
    expect(jobs.polling.value).toBe(true)
    expect(mocks.getOnboardingJob).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(100)

    expect(mocks.getOnboardingJob).toHaveBeenCalledTimes(1)
    expect(mocks.getOnboardingJob).toHaveBeenCalledWith('job-1')
    expect(jobs.job.value?.state).toBe('done')
    expect(jobs.polling.value).toBe(false)

    await vi.advanceTimersByTimeAsync(2000)
    expect(mocks.getOnboardingJob).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['failed', 'cancelled'] as const)(
    'stops polling on terminal state %s',
    async (state) => {
      mocks.getOnboardingJob.mockResolvedValue(makeJob({ state }))
      const jobs = scope.run(createJobs)!

      jobs.start(makeJob())
      await vi.advanceTimersByTimeAsync(100)

      expect(jobs.job.value?.state).toBe(state)
      expect(jobs.polling.value).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('backs off between polls until the max delay', async () => {
    mocks.getOnboardingJob.mockResolvedValue(makeJob())
    const jobs = scope.run(createJobs)!

    jobs.start(makeJob())

    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.getOnboardingJob).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(149)
    expect(mocks.getOnboardingJob).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.getOnboardingJob).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(224)
    expect(mocks.getOnboardingJob).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.getOnboardingJob).toHaveBeenCalledTimes(3)

    jobs.stop()
    expect(jobs.polling.value).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears timers when the scope is disposed', async () => {
    mocks.getOnboardingJob.mockResolvedValue(makeJob())
    const jobs = scope.run(createJobs)!

    jobs.start(makeJob())
    expect(vi.getTimerCount()).toBe(1)

    scope.stop()

    expect(jobs.polling.value).toBe(false)
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(2000)
    expect(mocks.getOnboardingJob).not.toHaveBeenCalled()
  })

  it('keeps a single active job when start is called twice', async () => {
    mocks.getOnboardingJob.mockImplementation((jobId: string) =>
      Promise.resolve(makeJob({ id: jobId })),
    )
    const jobs = scope.run(createJobs)!

    jobs.start(makeJob({ id: 'job-1' }))
    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.getOnboardingJob).toHaveBeenLastCalledWith('job-1')

    jobs.start(makeJob({ id: 'job-2' }))
    await vi.advanceTimersByTimeAsync(100)

    expect(mocks.getOnboardingJob).toHaveBeenCalledTimes(2)
    expect(mocks.getOnboardingJob).toHaveBeenLastCalledWith('job-2')
    expect(jobs.job.value?.id).toBe('job-2')

    jobs.stop()
  })

  it('accepts a job id and polls immediately', async () => {
    mocks.getOnboardingJob.mockResolvedValue(makeJob({ state: 'done' }))
    const jobs = scope.run(createJobs)!

    jobs.start('job-9')
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.getOnboardingJob).toHaveBeenCalledWith('job-9')
    expect(jobs.polling.value).toBe(false)
  })

  it('forwards setup token and password when cancelling', async () => {
    mocks.cancelOnboardingJob.mockResolvedValue(
      makeJob({ state: 'cancelled', cancel_requested: true }),
    )
    const jobs = scope.run(createJobs)!

    jobs.start(makeJob())
    const result = await jobs.cancel('setup-token-1', 'pw-1')

    expect(mocks.cancelOnboardingJob).toHaveBeenCalledWith(
      'job-1',
      'setup-token-1',
      'pw-1',
    )
    expect(result?.state).toBe('cancelled')
    expect(jobs.job.value?.state).toBe('cancelled')
    expect(jobs.polling.value).toBe(false)
  })

  it('keeps polling after a cancel request that is not terminal yet', async () => {
    mocks.cancelOnboardingJob.mockResolvedValue(
      makeJob({ cancel_requested: true }),
    )
    mocks.getOnboardingJob.mockResolvedValue(makeJob({ state: 'cancelled' }))
    const jobs = scope.run(createJobs)!

    jobs.start(makeJob())
    const result = await jobs.cancel()

    expect(result?.cancel_requested).toBe(true)
    expect(jobs.polling.value).toBe(true)

    await vi.advanceTimersByTimeAsync(100)
    expect(jobs.job.value?.state).toBe('cancelled')
    expect(jobs.polling.value).toBe(false)
  })

  it('retries with backoff after a transient poll failure', async () => {
    mocks.getOnboardingJob
      .mockRejectedValueOnce(new SystemApiError(0, 'network_error', 'offline'))
      .mockResolvedValueOnce(makeJob({ state: 'done' }))
    const jobs = scope.run(createJobs)!

    jobs.start(makeJob())
    await vi.advanceTimersByTimeAsync(100)

    expect(jobs.error.value?.code).toBe('network_error')
    expect(jobs.polling.value).toBe(true)

    await vi.advanceTimersByTimeAsync(150)

    expect(mocks.getOnboardingJob).toHaveBeenCalledTimes(2)
    expect(jobs.error.value).toBeNull()
    expect(jobs.job.value?.state).toBe('done')
    expect(jobs.polling.value).toBe(false)
  })

  it('stops polling when the job no longer exists', async () => {
    mocks.getOnboardingJob.mockRejectedValue(
      new SystemApiError(404, 'job_not_found', '下载作业不存在'),
    )
    const jobs = scope.run(createJobs)!

    jobs.start(makeJob())
    await vi.advanceTimersByTimeAsync(100)

    expect(jobs.error.value?.status).toBe(404)
    expect(jobs.polling.value).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('treats done/failed/cancelled as terminal only', () => {
    expect(isTerminalJobState('done')).toBe(true)
    expect(isTerminalJobState('failed')).toBe(true)
    expect(isTerminalJobState('cancelled')).toBe(true)
    expect(isTerminalJobState('queued')).toBe(false)
    expect(isTerminalJobState('running')).toBe(false)
  })

  it('persists the active job id and asset to localStorage', () => {
    const jobs = scope.run(createJobs)!

    jobs.start(makeJob({ id: 'job-persist', asset: 'models' }))

    expect(readPersistedOnboardingJob()).toEqual({
      id: 'job-persist',
      asset: 'models',
    })
  })

  it('clears the persisted job once it reaches a terminal state', async () => {
    mocks.getOnboardingJob.mockResolvedValue(makeJob({ state: 'done' }))
    const jobs = scope.run(createJobs)!

    jobs.start(makeJob())
    expect(readPersistedOnboardingJob()).not.toBeNull()

    await vi.advanceTimersByTimeAsync(100)

    expect(readPersistedOnboardingJob()).toBeNull()
  })

  it('restores a persisted job for the matching asset on mount', async () => {
    mocks.getOnboardingJob.mockResolvedValue(makeJob({ id: 'job-resume' }))
    const first = scope.run(createJobs)!
    first.start(makeJob({ id: 'job-resume', asset: 'kernel' }))
    first.stop()

    const second = scope.run(createJobs)!
    expect(second.restore('models')).toBe(false)
    expect(second.restore('kernel')).toBe(true)

    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.getOnboardingJob).toHaveBeenCalledWith('job-resume')
    expect(second.job.value?.id).toBe('job-resume')
  })

  it('ignores malformed persisted job data', () => {
    localStorage.setItem('axeuh.onboarding.job', '{"id":""}')
    expect(readPersistedOnboardingJob()).toBeNull()

    localStorage.setItem('axeuh.onboarding.job', 'not-json')
    expect(readPersistedOnboardingJob()).toBeNull()
  })
})
