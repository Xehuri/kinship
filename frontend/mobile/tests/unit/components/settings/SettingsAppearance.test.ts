/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import SettingsAppearance from '@/components/settings/SettingsAppearance.vue'
import { disposeTheme } from '@/composables/useTheme'
import { disposeTopInset } from '@/composables/useTopInset'

type ChangeListener = (e: { matches: boolean; media: string }) => void

let listeners: ChangeListener[]
let systemPrefersLight: boolean

function emitSystemChange(matches: boolean): void {
  for (const cb of listeners) {
    cb({ matches, media: '(prefers-color-scheme: light)' })
  }
}

function mountAppearance() {
  return mount(SettingsAppearance)
}

function press(wrapper: ReturnType<typeof mountAppearance>, setting: string, value: string) {
  return wrapper.find(`[data-setting="${setting}"][data-value="${value}"]`)
}

beforeEach(() => {
  disposeTheme()
  disposeTopInset()
  localStorage.clear()
  for (const name of ['data-theme', 'data-accent', 'data-density', 'data-motion']) {
    document.documentElement.removeAttribute(name)
  }

  listeners = []
  systemPrefersLight = false
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn(() => ({
      matches: systemPrefersLight,
      media: '(prefers-color-scheme: light)',
      onchange: null,
      addEventListener: (_type: string, cb: ChangeListener) => listeners.push(cb),
      removeEventListener: (_type: string, cb: ChangeListener) => {
        listeners = listeners.filter((listener) => listener !== cb)
      },
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

afterEach(() => {
  disposeTheme()
  disposeTopInset()
})

describe('SettingsAppearance', () => {
  it('渲染主题、强调色、密度、动效与顶部页边距，且不再出现冰川蓝', () => {
    const wrapper = mountAppearance()

    expect(wrapper.text()).toContain('主题')
    expect(wrapper.text()).toContain('强调色')
    expect(wrapper.text()).toContain('信息密度')
    expect(wrapper.text()).toContain('动效')
    expect(wrapper.text()).toContain('顶部页边距')
    expect(wrapper.text()).not.toContain('冰川蓝')
    expect(wrapper.text()).not.toContain('暗黑模式')

    expect(press(wrapper, 'theme', 'light').exists()).toBe(true)
    expect(press(wrapper, 'theme', 'dark').exists()).toBe(true)
    expect(press(wrapper, 'theme', 'system').exists()).toBe(true)
  })

  it('点击主题写入 axeuh-theme 与 data-theme', async () => {
    const wrapper = mountAppearance()

    await press(wrapper, 'theme', 'dark').trigger('click')

    expect(localStorage.getItem('axeuh-theme')).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(press(wrapper, 'theme', 'dark').attributes('aria-pressed')).toBe('true')
    expect(press(wrapper, 'theme', 'system').attributes('aria-pressed')).toBe('false')
  })

  it('跟随系统时随系统偏好切换解析主题', async () => {
    systemPrefersLight = true
    const wrapper = mountAppearance()

    expect(document.documentElement.getAttribute('data-theme')).toBe('light')

    emitSystemChange(false)
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(press(wrapper, 'theme', 'system').attributes('aria-pressed')).toBe('true')

    emitSystemChange(true)
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('点击强调色写入 axeuh-accent 与 data-accent', async () => {
    const wrapper = mountAppearance()

    await press(wrapper, 'accent', 'indigo').trigger('click')

    expect(localStorage.getItem('axeuh-accent')).toBe('indigo')
    expect(document.documentElement.getAttribute('data-accent')).toBe('indigo')
    expect(press(wrapper, 'accent', 'indigo').attributes('aria-pressed')).toBe('true')
  })

  it('点击密度与动效写入持久化键和 data 属性', async () => {
    const wrapper = mountAppearance()

    await press(wrapper, 'density', 'compact').trigger('click')
    await press(wrapper, 'motion', 'reduced').trigger('click')

    expect(localStorage.getItem('axeuh-density')).toBe('compact')
    expect(localStorage.getItem('axeuh-motion')).toBe('reduced')
    expect(document.documentElement.getAttribute('data-density')).toBe('compact')
    expect(document.documentElement.getAttribute('data-motion')).toBe('reduced')
  })

  it('渲染统一控制网格，包含五个设置字段', () => {
    const wrapper = mountAppearance()
    const controls = wrapper.find('.settings-controls')

    expect(controls.exists()).toBe(true)

    const children = Array.from(controls.element.children)
    expect(children).toHaveLength(5)
    for (const child of children) {
      expect(child.classList.contains('settings-field')).toBe(true)
    }
    expect(controls.findAll('.settings-field')).toHaveLength(5)
  })

  it('顶部页边距字段横跨整行', () => {
    const wrapper = mountAppearance()

    expect(wrapper.find('[data-setting-row="top-inset"]').classes()).toContain('settings-field--wide')
  })

  it('顶部页边距滑块写入 top_inset 并可重置', async () => {
    const wrapper = mountAppearance()
    const row = wrapper.find('[data-setting-row="top-inset"]')

    await wrapper.find('.top-inset-range').setValue(40)
    expect(localStorage.getItem('top_inset')).toBe('40')
    expect(row.text()).toContain('40 px')

    await wrapper.find('.top-inset-reset-btn').trigger('click')
    expect(localStorage.getItem('top_inset')).toBe('0')
    expect(row.text()).toContain('0 px')
  })
})
