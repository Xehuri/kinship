import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MeterBar from '@/components/common/MeterBar.vue'

function mountMeter(value: number, max: number) {
  return mount(MeterBar, {
    props: { value, max, label: '上下文占用' },
  })
}

describe('MeterBar', () => {
  it('renders a progressbar with clamped aria values', () => {
    const wrapper = mountMeter(120, 100)
    const bar = wrapper.get('[role="progressbar"]')

    expect(bar.attributes('aria-label')).toBe('上下文占用')
    expect(bar.attributes('aria-valuemin')).toBe('0')
    expect(bar.attributes('aria-valuemax')).toBe('100')
    expect(bar.attributes('aria-valuenow')).toBe('100')
    expect(bar.attributes('aria-valuetext')).toBe('100 / 100')
    expect(bar.get('.meter__fill').attributes('style')).toContain('100%')
  })

  it('clamps negative values to zero', () => {
    const wrapper = mountMeter(-20, 100)
    const bar = wrapper.get('[role="progressbar"]')

    expect(bar.attributes('aria-valuenow')).toBe('0')
    expect(bar.attributes('aria-valuetext')).toBe('0 / 100')
    expect(bar.get('.meter__fill').attributes('style')).toContain('0%')
  })

  it('treats a non-positive or non-finite max as zero without dividing by it', () => {
    for (const max of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const wrapper = mountMeter(50, max)
      const bar = wrapper.get('[role="progressbar"]')

      expect(bar.attributes('aria-valuemax')).toBe('0')
      expect(bar.attributes('aria-valuenow')).toBe('0')
      expect(bar.attributes('aria-valuetext')).toBe('0 / 0')
      expect(bar.get('.meter__fill').attributes('style')).toContain('0%')
      wrapper.unmount()
    }
  })

  it('treats a non-finite value as zero', () => {
    const wrapper = mountMeter(Number.NaN, 100)
    const bar = wrapper.get('[role="progressbar"]')

    expect(bar.attributes('aria-valuenow')).toBe('0')
    expect(bar.get('.meter__fill').attributes('style')).toContain('0%')
  })
})
