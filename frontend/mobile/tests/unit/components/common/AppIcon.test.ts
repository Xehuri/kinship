import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AppIcon from '@/components/common/AppIcon.vue'

const productionIcons = [
  'Heartbeat',
  'Footprints',
  'MoonStars',
  'Drop',
  'BatteryFull',
  'MapPin',
  'Microphone',
  'Waveform',
  'UploadSimple',
  'ArrowClockwise',
  'ArrowUp',
  'BatteryCharging',
  'DeviceMobile',
  'DesktopTower',
  'ChatTeardropText',
]

describe('AppIcon', () => {
  it('renders a known icon as an svg with aria-hidden', () => {
    const wrapper = mount(AppIcon, { props: { name: 'Gear' } })
    const svg = wrapper.find('svg')

    expect(svg.exists()).toBe(true)
    expect(svg.attributes('aria-hidden')).toBe('true')
    expect(svg.attributes('aria-label')).toBeUndefined()
  })

  it('honors label as role img with aria-label', () => {
    const wrapper = mount(AppIcon, { props: { name: 'Heartbeat', label: '心率' } })
    const svg = wrapper.find('svg')

    expect(svg.attributes('role')).toBe('img')
    expect(svg.attributes('aria-label')).toBe('心率')
    expect(svg.attributes('aria-hidden')).toBeUndefined()
  })

  it.each(['gear', 'ph-gear', 'Gear', 'PhGear'])('normalizes %s', (name) => {
    const wrapper = mount(AppIcon, { props: { name } })
    expect(wrapper.find('svg').exists()).toBe(true)
    expect(wrapper.find('.icon--placeholder').exists()).toBe(false)
  })

  it.each(productionIcons)('renders the production icon %s', (name) => {
    const wrapper = mount(AppIcon, { props: { name } })
    expect(wrapper.find('svg').exists()).toBe(true)
  })

  it('renders the placeholder for an unknown name', () => {
    const wrapper = mount(AppIcon, { props: { name: 'definitely-not-an-icon' } })

    expect(wrapper.find('svg').exists()).toBe(false)
    expect(wrapper.find('.icon--placeholder').exists()).toBe(true)
    expect(wrapper.find('.icon--placeholder').attributes('aria-hidden')).toBe('true')
  })

  it('renders the placeholder with label semantics', () => {
    const wrapper = mount(AppIcon, { props: { name: 'definitely-not-an-icon', label: '未知图标' } })
    const placeholder = wrapper.find('.icon--placeholder')

    expect(placeholder.attributes('role')).toBe('img')
    expect(placeholder.attributes('aria-label')).toBe('未知图标')
  })
})
