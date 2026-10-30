/// <reference types="vitest/globals" />

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import OnboardingRail from '@/components/onboarding/OnboardingRail.vue'
import type { OnboardingStepInfo } from '@/api/system'

const STEP_IDS = [
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

const SKIPPABLE = new Set(['kernel', 'kernel_models', 'xiaomi', 'qq', 'moss', 'loom'])

function makeSteps(
  completed: string[] = [],
  skipped: string[] = [],
  current = 'welcome',
): OnboardingStepInfo[] {
  return STEP_IDS.map((id) => ({
    id,
    title: id,
    description: '',
    required: true,
    skippable: SKIPPABLE.has(id),
    auth: 'none',
    state: completed.includes(id)
      ? 'completed'
      : skipped.includes(id)
        ? 'skipped'
        : id === current
          ? 'current'
          : 'pending',
  }))
}

function mountRail(
  steps: OnboardingStepInfo[],
  activeIndex = 0,
  completed: string[] = [],
  skipped: string[] = [],
) {
  return mount(OnboardingRail, {
    props: { steps, activeIndex, completed, skipped },
  })
}

describe('OnboardingRail 阶段分段', () => {
  it('拆成阶段 1 (4 步) 与阶段 2 (7 步) 两段', () => {
    const wrapper = mountRail(makeSteps())
    const segment1 = wrapper.get('[data-onboarding-rail-segment="1"]')
    const segment2 = wrapper.get('[data-onboarding-rail-segment="2"]')
    expect(
      segment1.findAll('[data-onboarding-step]').map((node) => node.attributes('data-step-id')),
    ).toEqual(['welcome', 'account', 'dependencies', 'kernel'])
    expect(
      segment2.findAll('[data-onboarding-step]').map((node) => node.attributes('data-step-id')),
    ).toEqual(['kernel_models', 'xiaomi', 'qq', 'moss', 'loom', 'clients', 'finish'])
  })

  it('每段显示自己的完成计数 (3/4 与 0/7)', () => {
    const completed = ['welcome', 'account', 'dependencies']
    const wrapper = mountRail(makeSteps(completed, [], 'kernel'), 3, completed, [])
    expect(wrapper.get('[data-phase-progress="1"]').text()).toBe('3/4')
    expect(wrapper.get('[data-phase-progress="2"]').text()).toBe('0/7')
  })

  it('跳过也计入完成计数 (4/4)', () => {
    const completed = ['welcome', 'account', 'dependencies']
    const skipped = ['kernel']
    const wrapper = mountRail(makeSteps(completed, skipped, 'kernel_models'), 4, completed, skipped)
    expect(wrapper.get('[data-phase-progress="1"]').text()).toBe('4/4')
  })

  it('阶段 1 未完成时阶段 2 的步骤一律不可点击', () => {
    const wrapper = mountRail(makeSteps(), 5)
    for (const node of wrapper.findAll('[data-step-phase="2"]')) {
      expect(node.attributes('disabled'), node.attributes('data-step-id')).toBeDefined()
    }
  })

  it('阶段 1 完成后阶段 2 的已走过步骤可点击', () => {
    const completed = ['welcome', 'account', 'dependencies']
    const skipped = ['kernel']
    const wrapper = mountRail(
      makeSteps(completed, skipped, 'kernel_models'),
      4,
      completed,
      skipped,
    )
    const kernelModels = wrapper.get('[data-step-id="kernel_models"]')
    expect(kernelModels.attributes('disabled')).toBeUndefined()
    expect(kernelModels.attributes('data-step-phase')).toBe('2')
  })

  it('点击步骤按全局索引发出 navigate', async () => {
    const wrapper = mountRail(makeSteps(['account']), 0, ['account'], [])
    await wrapper.get('[data-step-id="account"]').trigger('click')
    expect(wrapper.emitted('navigate')?.[0]).toEqual([1])
  })
})
