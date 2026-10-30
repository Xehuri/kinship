/// <reference types="vitest/globals" />

import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { FALLBACK_ORDER } from '@/config/onboardingSteps'
import StepWhy from '@/components/onboarding/StepWhy.vue'

enableAutoUnmount(afterEach)

describe('StepWhy', () => {
  it.each([...FALLBACK_ORDER])('renders the why block for %s', (stepId) => {
    const wrapper = mount(StepWhy, { props: { stepId } })

    const block = wrapper.get('[data-onboarding-step-why]')
    expect(block.attributes('data-step-id')).toBe(stepId)
    expect(block.get('[data-onboarding-step-why-reason]').text()).toContain(
      '为什么需要：',
    )
    expect(wrapper.find('[data-onboarding-step-why-detected]').exists()).toBe(false)
  })

  it('renders detected values only when they are provided', () => {
    const wrapper = mount(StepWhy, {
      props: {
        stepId: 'kernel',
        detected: [
          { label: '版本', value: '1.0.0' },
          { label: '空值', value: '   ' },
        ],
      },
    })

    const detected = wrapper.get('[data-onboarding-step-why-detected]')
    expect(detected.text()).toContain('自动检测')
    expect(detected.text()).toContain('版本')
    expect(detected.text()).toContain('1.0.0')
    expect(detected.text()).not.toContain('空值')
  })

  it('keeps the skip consequence inside the why block for skippable steps', () => {
    const wrapper = mount(StepWhy, { props: { stepId: 'kernel' } })

    expect(wrapper.get('[data-skip-consequence-step="kernel"]').text()).toContain(
      '跳过会怎样',
    )
  })
})
