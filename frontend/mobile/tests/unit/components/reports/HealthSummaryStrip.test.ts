/// <reference types="vitest/globals" />

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import HealthSummaryStrip from '@/components/reports/HealthSummaryStrip.vue'
import type { HealthSummaryMetric } from '@/composables/useHealthSummary'

const METRICS: HealthSummaryMetric[] = [
  { key: 'heartRate', label: '心率', value: '72', unit: 'bpm', icon: 'Heartbeat' },
  { key: 'steps', label: '步数', value: '8,421', unit: '步', icon: 'Footprints' },
  { key: 'sleep', label: '睡眠', value: '7h32m', unit: '', icon: 'MoonStars' },
  { key: 'spo2', label: '血氧', value: '97', unit: '%', icon: 'Drop' },
  { key: 'stress', label: '压力', value: '32', unit: '/100', icon: 'Pulse' },
  { key: 'battery', label: '电量', value: '82', unit: '%', icon: 'BatteryFull' },
  { key: 'gps', label: 'GPS', value: '1,071', unit: '点', icon: 'MapPin' },
]

function mountStrip(overrides: Record<string, unknown> = {}) {
  return mount(HealthSummaryStrip, {
    props: {
      date: '2026-10-24',
      metrics: METRICS,
      loading: false,
      error: false,
      ...overrides,
    },
  })
}

describe('HealthSummaryStrip', () => {
  it('renders all seven metrics with the current date', () => {
    const wrapper = mountStrip()

    expect(wrapper.find('[data-testid="health-summary"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="health-metric"]')).toHaveLength(7)
    expect(wrapper.text()).toContain('10月24日')
    expect(wrapper.text()).toContain('72')
    expect(wrapper.text()).toContain('8,421')
    expect(wrapper.text()).toContain('7h32m')
    expect(wrapper.text()).toContain('1,071')
  })

  it('renders a loading skeleton without metric values', () => {
    const wrapper = mountStrip({ loading: true })

    expect(wrapper.findAll('[data-testid="health-metric"]')).toHaveLength(0)
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('8,421')
  })

  it('shows the unavailable state with retry and no fabricated values', () => {
    const wrapper = mountStrip({ error: true, metrics: [] })

    const summary = wrapper.find('[data-testid="health-summary"]')
    expect(summary.text()).toContain('健康数据暂不可用')
    expect(summary.findAll('[data-testid="health-metric"]')).toHaveLength(0)
    expect(summary.text()).not.toContain('8,421')
    expect(wrapper.find('[data-testid="health-retry"]').exists()).toBe(true)
  })

  it('emits retry, gps and voiceprint from their controls', async () => {
    const wrapper = mountStrip()

    await wrapper.find('[data-testid="health-gps-action"]').trigger('click')
    await wrapper.find('[data-testid="health-voiceprint-action"]').trigger('click')

    expect(wrapper.emitted('gps')).toHaveLength(1)
    expect(wrapper.emitted('voiceprint')).toHaveLength(1)

    const errorWrapper = mountStrip({ error: true, metrics: [] })
    await errorWrapper.find('[data-testid="health-retry"]').trigger('click')
    expect(errorWrapper.emitted('retry')).toHaveLength(1)
  })
})
