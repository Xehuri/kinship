/// <reference types="vitest/globals" />

import { describe, expect, it } from 'vitest'
import {
  FALLBACK_ORDER,
  OPTIONAL_CAPABILITY_STEP_IDS,
  PHASE_1_STEP_IDS,
  PHASE_2_STEP_IDS,
  fallbackOnboardingSteps,
  isPhase1Complete,
  isPhase1CompleteFromState,
  isPhase1Step,
  onboardingMilestoneStepId,
  onboardingStepPhase,
  onboardingStepVisual,
  optionalCapabilityCount,
  phaseProgress,
  phaseStepIds,
  skipConsequenceFor,
  whyFor,
} from '@/config/onboardingSteps'

const BACKEND_STEP_IDS = [
  'welcome',
  'account',
  'dependencies',
  'kernel',
  'kernel_models',
  'xiaomi',
  'qq',
  'moss',
  'loom',
  'clients',
  'finish',
] as const

const SKIPPABLE_BACKEND_STEPS = [
  'kernel',
  'kernel_models',
  'xiaomi',
  'qq',
  'moss',
  'loom',
] as const

function step(id: string, state: 'completed' | 'skipped' | 'current' | 'pending') {
  return { id, state }
}

describe('onboardingSteps 阶段划分', () => {
  it('保留后端契约的 11 个步骤且顺序不变', () => {
    expect([...FALLBACK_ORDER]).toEqual([...BACKEND_STEP_IDS])
    expect(new Set(FALLBACK_ORDER).size).toBe(11)
    expect(fallbackOnboardingSteps().map((item) => item.id)).toEqual([
      ...BACKEND_STEP_IDS,
    ])
  })

  it('阶段 1 是可用所需的 4 步', () => {
    expect([...PHASE_1_STEP_IDS]).toEqual([
      'welcome',
      'account',
      'dependencies',
      'kernel',
    ])
    expect(PHASE_1_STEP_IDS.every((id) => onboardingStepPhase(id) === 1)).toBe(true)
  })

  it('阶段 2 是可用之后的可选 7 步', () => {
    expect([...PHASE_2_STEP_IDS]).toEqual([
      'kernel_models',
      'xiaomi',
      'qq',
      'moss',
      'loom',
      'clients',
      'finish',
    ])
    expect(PHASE_2_STEP_IDS.every((id) => onboardingStepPhase(id) === 2)).toBe(true)
  })

  it('两个阶段不重叠且并集等于 11 步', () => {
    const union = [...PHASE_1_STEP_IDS, ...PHASE_2_STEP_IDS]
    expect(union).toHaveLength(11)
    expect(new Set(union).size).toBe(11)
    expect(
      (PHASE_2_STEP_IDS as readonly string[]).some((id) =>
        (PHASE_1_STEP_IDS as readonly string[]).includes(id),
      ),
    ).toBe(false)
    expect(phaseStepIds(1)).toBe(PHASE_1_STEP_IDS)
    expect(phaseStepIds(2)).toBe(PHASE_2_STEP_IDS)
    expect(isPhase1Step('kernel')).toBe(true)
    expect(isPhase1Step('kernel_models')).toBe(false)
  })

  it('每个步骤都带 phase / milestone / skip_consequence 元数据', () => {
    for (const id of BACKEND_STEP_IDS) {
      const meta = onboardingStepVisual(id)
      expect([1, 2]).toContain(meta.phase)
      expect(typeof meta.milestone).toBe('boolean')
      expect(typeof meta.skip_consequence).toBe('string')
    }
  })

  it('里程碑边界只有 kernel 一步', () => {
    expect(onboardingMilestoneStepId()).toBe('kernel')
    const flagged = BACKEND_STEP_IDS.filter(
      (id) => onboardingStepVisual(id).milestone,
    )
    expect(flagged).toEqual(['kernel'])
  })

  it('每个可跳过步骤都有"跳过会怎样"后果文案, 不可跳过的为空', () => {
    for (const stepInfo of fallbackOnboardingSteps()) {
      const consequence = skipConsequenceFor(stepInfo.id)
      if (stepInfo.skippable) {
        expect(consequence.length, stepInfo.id).toBeGreaterThan(0)
      } else {
        expect(consequence, stepInfo.id).toBe('')
      }
    }
    for (const id of SKIPPABLE_BACKEND_STEPS) {
      expect(skipConsequenceFor(id).length, id).toBeGreaterThan(0)
    }
    expect(skipConsequenceFor('kernel')).toContain('音频不会分析')
  })

  it('里程碑页的"可选"能力恰好 4 项', () => {
    expect(optionalCapabilityCount()).toBe(4)
    expect([...OPTIONAL_CAPABILITY_STEP_IDS]).toEqual([
      'xiaomi',
      'qq',
      'moss',
      'loom',
    ])
    expect(
      OPTIONAL_CAPABILITY_STEP_IDS.every((id) => onboardingStepPhase(id) === 2),
    ).toBe(true)
  })

  it('未知步骤按可选阶段处理, 不阻塞"已可用"', () => {
    expect(onboardingStepPhase('brand_new_step')).toBe(2)
    expect(skipConsequenceFor('brand_new_step')).toBe('')
    expect(whyFor('brand_new_step')).toBe('')
    expect(onboardingStepVisual('brand_new_step').milestone).toBe(false)
  })

  it('全部 11 个步骤都有非空的必要性说明', () => {
    for (const id of BACKEND_STEP_IDS) {
      expect(whyFor(id), id).not.toBe('')
      expect(onboardingStepVisual(id).why, id).toBe(whyFor(id))
    }
  })
})

describe('onboardingSteps 进度与完成判定', () => {
  it('3/4 与 0/7 的进度口径 (completed + skipped 均计入)', () => {
    const steps = BACKEND_STEP_IDS.map((id) => {
      if (['welcome', 'account', 'dependencies'].includes(id)) {
        return step(id, 'completed')
      }
      if (id === 'kernel') return step(id, 'current')
      return step(id, 'pending')
    })
    expect(phaseProgress(steps, 1)).toEqual({ done: 3, total: 4 })
    expect(phaseProgress(steps, 2)).toEqual({ done: 0, total: 7 })
  })

  it('跳过也算处理完成', () => {
    const steps = BACKEND_STEP_IDS.map((id) => {
      if (['welcome', 'account', 'dependencies'].includes(id)) {
        return step(id, 'completed')
      }
      if (id === 'kernel') return step(id, 'skipped')
      return step(id, 'pending')
    })
    expect(phaseProgress(steps, 1)).toEqual({ done: 4, total: 4 })
    expect(isPhase1Complete(steps)).toBe(true)
  })

  it('阶段 1 未全部处理时不算完成', () => {
    const steps = BACKEND_STEP_IDS.map((id) =>
      id === 'welcome' ? step(id, 'completed') : step(id, 'pending'),
    )
    expect(isPhase1Complete(steps)).toBe(false)
    expect(isPhase1CompleteFromState(['welcome', 'account', 'dependencies'], [])).toBe(
      false,
    )
  })

  it('无 steps 时用 completed/skipped 列表降级判定', () => {
    expect(
      isPhase1CompleteFromState(
        ['welcome', 'account', 'dependencies'],
        ['kernel'],
      ),
    ).toBe(true)
    expect(isPhase1CompleteFromState(['welcome'], [])).toBe(false)
  })

  it('缺少阶段 1 步骤的响应不会被误判为完成', () => {
    expect(isPhase1Complete([step('welcome', 'completed')])).toBe(false)
  })
})
