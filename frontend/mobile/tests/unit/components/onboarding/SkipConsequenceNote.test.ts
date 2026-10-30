/// <reference types="vitest/globals" />

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SkipConsequenceNote from '@/components/onboarding/SkipConsequenceNote.vue'

describe('SkipConsequenceNote', () => {
  it('渲染跳过后果标题与步骤后果文案', () => {
    const wrapper = mount(SkipConsequenceNote, { props: { stepId: 'kernel' } })
    expect(wrapper.attributes('data-onboarding-skip-consequence')).toBe('')
    expect(wrapper.attributes('data-skip-consequence-step')).toBe('kernel')
    expect(wrapper.text()).toContain('跳过会怎样：')
    expect(wrapper.text()).toContain('音频不会分析')
  })

  it('不可跳过的步骤不渲染任何内容', () => {
    const wrapper = mount(SkipConsequenceNote, { props: { stepId: 'welcome' } })
    expect(wrapper.find('[data-onboarding-skip-consequence]').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
  })
})
