/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OnboardingStatus } from '@/api/system'

// ==================== Mock useApi + onboarding API ====================

const mockGetSetupStatus = vi.hoisted(() => vi.fn())
const mockGetOnboardingStatus = vi.hoisted(() => vi.fn())

vi.mock('@/composables/useApi', () => ({
  getSetupStatus: mockGetSetupStatus,
}))

vi.mock('@/api/system', () => ({
  getOnboardingStatus: mockGetOnboardingStatus,
}))

import { useSetupStatus, refreshSetupStatus } from '@/composables/useSetupStatus'

function onboardingStatus(
  overrides: Partial<OnboardingStatus> = {},
): OnboardingStatus {
  return {
    state: {
      version: 1,
      completed_steps: [],
      skipped_steps: [],
      current_step: '',
      completed: false,
      started_at: null,
      updated_at: null,
    },
    needs_setup: false,
    degraded: false,
    onboarding_complete: false,
    config_revision: 'rev-1',
    ...overrides,
  }
}

describe('useSetupStatus', () => {
  const {
    needsSetup,
    setupStatus,
    setupStatusError,
    onboardingComplete,
    configDegraded,
    onboardingKnown,
  } = useSetupStatus()

  beforeEach(() => {
    // 重置模块级单例状态
    needsSetup.value = false
    setupStatus.value = null
    setupStatusError.value = false
    onboardingComplete.value = true
    configDegraded.value = false
    onboardingKnown.value = false
    vi.clearAllMocks()
    mockGetOnboardingStatus.mockResolvedValue(onboardingStatus())
  })

  it('needs_setup=true 时 needsSetup 为 true', async () => {
    mockGetSetupStatus.mockResolvedValue(true)

    const result = await refreshSetupStatus()

    expect(result).toBe(true)
    expect(needsSetup.value).toBe(true)
    expect(setupStatus.value).toBe(true)
    expect(setupStatusError.value).toBe(false)
  })

  it('needs_setup=false 时 needsSetup 为 false', async () => {
    mockGetSetupStatus.mockResolvedValue(false)

    const result = await refreshSetupStatus()

    expect(result).toBe(false)
    expect(needsSetup.value).toBe(false)
    expect(setupStatus.value).toBe(false)
    expect(setupStatusError.value).toBe(false)
  })

  it('返回 null (后端不可达) 时 needsSetup 按 false 处理, 但标记错误并保留未知态', async () => {
    mockGetSetupStatus.mockResolvedValue(null)

    const result = await refreshSetupStatus()

    expect(result).toBe(false)
    expect(needsSetup.value).toBe(false)
    // 关键: null 与 false 必须可区分, 不能把不可达误判为"已初始化"
    expect(setupStatus.value).toBeNull()
    expect(setupStatusError.value).toBe(true)
  })

  it('引导未完成时 onboardingComplete 为 false, 且标记 onboardingKnown', async () => {
    mockGetSetupStatus.mockResolvedValue(false)
    mockGetOnboardingStatus.mockResolvedValue(
      onboardingStatus({ onboarding_complete: false, degraded: false }),
    )

    await refreshSetupStatus()

    expect(onboardingComplete.value).toBe(false)
    expect(onboardingKnown.value).toBe(true)
    expect(configDegraded.value).toBe(false)
  })

  it('引导已完成时 onboardingComplete 为 true', async () => {
    mockGetSetupStatus.mockResolvedValue(false)
    mockGetOnboardingStatus.mockResolvedValue(
      onboardingStatus({ onboarding_complete: true }),
    )

    await refreshSetupStatus()

    expect(onboardingComplete.value).toBe(true)
    expect(onboardingKnown.value).toBe(true)
  })

  it('降级态映射到 configDegraded', async () => {
    mockGetSetupStatus.mockResolvedValue(false)
    mockGetOnboardingStatus.mockResolvedValue(
      onboardingStatus({ degraded: true, onboarding_complete: false }),
    )

    await refreshSetupStatus()

    expect(configDegraded.value).toBe(true)
    expect(onboardingKnown.value).toBe(true)
  })

  it('旧后端 (onboarding 接口失败) 回退为已完成且不触发引导', async () => {
    mockGetSetupStatus.mockResolvedValue(false)
    mockGetOnboardingStatus.mockRejectedValue(new Error('404 not found'))

    await refreshSetupStatus()

    expect(onboardingComplete.value).toBe(true)
    expect(configDegraded.value).toBe(false)
    expect(onboardingKnown.value).toBe(false)
  })

  it('onboarding 接口失败不覆盖真实的 needs_setup', async () => {
    mockGetSetupStatus.mockResolvedValue(true)
    mockGetOnboardingStatus.mockRejectedValue(new Error('network error'))

    const result = await refreshSetupStatus()

    expect(result).toBe(true)
    expect(needsSetup.value).toBe(true)
    expect(onboardingComplete.value).toBe(true)
    expect(onboardingKnown.value).toBe(false)
  })

  it('两个接口并行查询 (不串行等待)', async () => {
    let resolveSetup: (value: boolean) => void = () => {}
    let resolveOnboarding: (value: OnboardingStatus) => void = () => {}
    mockGetSetupStatus.mockImplementation(
      () => new Promise<boolean>((resolve) => { resolveSetup = resolve }),
    )
    mockGetOnboardingStatus.mockImplementation(
      () => new Promise<OnboardingStatus>((resolve) => { resolveOnboarding = resolve }),
    )

    const pending = refreshSetupStatus()
    await Promise.resolve()

    expect(mockGetSetupStatus).toHaveBeenCalledTimes(1)
    expect(mockGetOnboardingStatus).toHaveBeenCalledTimes(1)

    resolveSetup(false)
    resolveOnboarding(onboardingStatus({ onboarding_complete: true }))
    await pending

    expect(onboardingKnown.value).toBe(true)
  })

  it('重新查询成功后清除错误标志', async () => {
    mockGetSetupStatus.mockResolvedValue(null)
    await refreshSetupStatus()
    expect(setupStatusError.value).toBe(true)

    mockGetSetupStatus.mockResolvedValue(false)
    await refreshSetupStatus()

    expect(setupStatusError.value).toBe(false)
    expect(setupStatus.value).toBe(false)
  })

  it('useSetupStatus 与 refreshSetupStatus 共享同一状态', async () => {
    mockGetSetupStatus.mockResolvedValue(true)
    await refreshSetupStatus()

    // 再次调用 useSetupStatus 应拿到相同的单例 ref
    const again = useSetupStatus()
    expect(again.needsSetup.value).toBe(true)
    expect(again.needsSetup).toBe(needsSetup)
    expect(again.setupStatus).toBe(setupStatus)
    expect(again.setupStatusError).toBe(setupStatusError)
    expect(again.onboardingComplete).toBe(onboardingComplete)
    expect(again.configDegraded).toBe(configDegraded)
    expect(again.onboardingKnown).toBe(onboardingKnown)
  })
})
