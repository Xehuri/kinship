/**
 * 引导下载作业轮询 (T12)
 *
 * 同一 composable 实例只跟踪一个活动作业, 轮询采用指数退避并在
 * done/failed/cancelled 时停止; 作用域销毁时清理定时器并按代号丢弃
 * 在途响应, 不产生泄漏定时器或卸载后的状态回写。
 */

import { onScopeDispose, ref, type Ref } from 'vue'
import {
  SystemApiError,
  cancelOnboardingJob,
  getOnboardingJob,
  type DownloadJob,
} from '@/api/system'

const TERMINAL_JOB_STATES: ReadonlySet<DownloadJob['state']> = new Set([
  'done',
  'failed',
  'cancelled',
])

const DEFAULT_BASE_DELAY_MS = 800
const DEFAULT_MAX_DELAY_MS = 5000
const BACKOFF_FACTOR = 1.5
const STORAGE_KEY = 'axeuh.onboarding.job'

export interface PersistedOnboardingJob {
  id: string
  asset: string | null
}

function canUseStorage(): boolean {
  return typeof localStorage !== 'undefined'
}

export function readPersistedOnboardingJob(): PersistedOnboardingJob | null {
  if (!canUseStorage()) return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null
    }
    const value = parsed as Record<string, unknown>
    if (typeof value.id !== 'string' || !value.id) return null
    return {
      id: value.id,
      asset: typeof value.asset === 'string' ? value.asset : null,
    }
  } catch {
    return null
  }
}

function writePersistedOnboardingJob(job: PersistedOnboardingJob): void {
  if (!canUseStorage()) return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(job))
  } catch {
    // Storage can be unavailable or full; polling still works in memory.
  }
}

function clearPersistedOnboardingJob(): void {
  if (!canUseStorage()) return
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore storage failures; there is nothing else to clean up.
  }
}

function persistJobState(job: DownloadJob): void {
  if (isTerminalJobState(job.state)) {
    clearPersistedOnboardingJob()
    return
  }
  writePersistedOnboardingJob({ id: job.id, asset: job.asset })
}

export function isTerminalJobState(state: DownloadJob['state']): boolean {
  return TERMINAL_JOB_STATES.has(state)
}

export interface OnboardingJobsOptions {
  baseDelayMs?: number
  maxDelayMs?: number
}

export interface UseOnboardingJobsReturn {
  job: Ref<DownloadJob | null>
  polling: Ref<boolean>
  error: Ref<SystemApiError | null>
  start: (initial: DownloadJob | string, setupToken?: string) => void
  restore: (asset: string) => boolean
  stop: () => void
  cancel: (
    setupToken?: string,
    currentPassword?: string,
  ) => Promise<DownloadJob | null>
}

function toSystemApiError(value: unknown): SystemApiError {
  if (value instanceof SystemApiError) return value
  return new SystemApiError(
    0,
    'unknown_error',
    value instanceof Error ? value.message : String(value),
  )
}

export function useOnboardingJobs(
  options: OnboardingJobsOptions = {},
): UseOnboardingJobsReturn {
  const baseDelay = Math.max(1, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS)
  const maxDelay = Math.max(baseDelay, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS)

  const job = ref<DownloadJob | null>(null)
  const polling = ref(false)
  const error = ref<SystemApiError | null>(null)

  let generation = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function stop(): void {
    generation += 1
    clearTimer()
    polling.value = false
  }

  function nextDelay(current: number): number {
    return Math.min(maxDelay, Math.round(current * BACKOFF_FACTOR))
  }

  function schedule(
    mine: number,
    jobId: string,
    setupToken: string | undefined,
    delay: number,
  ): void {
    timer = setTimeout(() => {
      timer = null
      void poll(mine, jobId, setupToken, delay)
    }, delay)
  }

  async function poll(
    mine: number,
    jobId: string,
    setupToken: string | undefined,
    delay: number,
  ): Promise<void> {
    if (mine !== generation) return
    let snapshot: DownloadJob
    try {
      snapshot = await getOnboardingJob(jobId)
    } catch (e) {
      if (mine !== generation) return
      error.value = toSystemApiError(e)
      if (e instanceof SystemApiError && e.status === 404) {
        clearPersistedOnboardingJob()
        polling.value = false
        return
      }
      schedule(mine, jobId, setupToken, nextDelay(delay))
      return
    }
    if (mine !== generation) return
    error.value = null
    job.value = snapshot
    persistJobState(snapshot)
    if (isTerminalJobState(snapshot.state)) {
      polling.value = false
      return
    }
    schedule(mine, jobId, setupToken, nextDelay(delay))
  }

  function start(initial: DownloadJob | string, setupToken?: string): void {
    stop()
    const mine = generation
    polling.value = true
    error.value = null
    if (typeof initial === 'string') {
      schedule(mine, initial, setupToken, 0)
      return
    }
    job.value = initial
    persistJobState(initial)
    if (isTerminalJobState(initial.state)) {
      polling.value = false
      return
    }
    schedule(mine, initial.id, setupToken, baseDelay)
  }

  function restore(asset: string): boolean {
    const saved = readPersistedOnboardingJob()
    if (!saved || saved.asset !== asset) return false
    start(saved.id)
    return true
  }

  async function cancel(
    setupToken?: string,
    currentPassword?: string,
  ): Promise<DownloadJob | null> {
    const active = job.value
    if (!active) return null
    error.value = null
    try {
      const snapshot = await cancelOnboardingJob(
        active.id,
        setupToken,
        currentPassword,
      )
      job.value = snapshot
      persistJobState(snapshot)
      if (isTerminalJobState(snapshot.state)) stop()
      return snapshot
    } catch (e) {
      error.value = toSystemApiError(e)
      return null
    }
  }

  onScopeDispose(stop)

  return { job, polling, error, start, restore, stop, cancel }
}
