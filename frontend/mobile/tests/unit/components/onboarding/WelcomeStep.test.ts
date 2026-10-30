/// <reference types="vitest/globals" />

import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import WelcomeStep from '@/components/onboarding/steps/WelcomeStep.vue'

enableAutoUnmount(afterEach)

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  setClipboard(undefined)
})

describe('WelcomeStep', () => {
  it('renders the hero, a short explanation and the start action', () => {
    const wrapper = mount(WelcomeStep)

    expect(wrapper.find('[data-onboarding-panel="welcome"]').exists()).toBe(true)
    expect(wrapper.get('[data-onboarding-step-why]').text()).toContain('为什么需要')
    expect(wrapper.get('[data-onboarding-step-why]').text()).toContain(
      '先了解 Kinship 会怎么使用你的数据',
    )
    expect(wrapper.text()).toContain('先认识你，再开始记录')
    expect(wrapper.text()).toContain('数据归你所有')
    expect(wrapper.get('[data-onboarding-welcome-start]').text()).toContain('开始初始化')
  })

  it('emits start when the primary action is clicked', async () => {
    const wrapper = mount(WelcomeStep)

    await wrapper.get('[data-onboarding-welcome-start]').trigger('click')

    expect(wrapper.emitted('start')).toHaveLength(1)
  })

  it('renders the AI harness handoff path as selectable text without a doc link', () => {
    const wrapper = mount(WelcomeStep)
    const card = wrapper.get('[data-onboarding-ai-handoff]')

    expect(card.attributes('data-testid')).toBe('onboarding-ai-handoff')
    expect(card.text()).toContain('让 AI 帮你配置')
    expect(card.get('[data-onboarding-ai-handoff-path]').text()).toBe(
      'docs/ai-harness-setup.md',
    )
    expect(card.text()).toContain('GUI 与 harness 部署')
    expect(card.text()).toContain('Windows / Linux')
    expect(card.text()).toContain('启动验证')
    expect(card.findAll('a[href]')).toHaveLength(0)
    expect(wrapper.find('a[href*="ai-harness-setup"]').exists()).toBe(false)
  })

  it('copies the harness doc path when a clipboard is available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })
    const wrapper = mount(WelcomeStep)

    await wrapper.get('[data-onboarding-ai-handoff-copy]').trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledWith('docs/ai-harness-setup.md')
    expect(wrapper.get('[data-onboarding-ai-handoff-copy]').text()).toContain('已复制')
  })

  it('falls back to manual selection when the clipboard is unavailable', () => {
    setClipboard(undefined)
    const wrapper = mount(WelcomeStep)

    expect(wrapper.find('[data-onboarding-ai-handoff-copy]').exists()).toBe(false)
    expect(wrapper.get('[data-onboarding-ai-handoff-status]').text()).toContain(
      '手动选择',
    )
  })

  it('does not embed preflight, Loom token or PC sensor content', () => {
    const wrapper = mount(WelcomeStep)
    const text = wrapper.text()

    expect(wrapper.find('[data-onboarding-check]').exists()).toBe(false)
    expect(wrapper.find('[data-onboarding-preflight-continue]').exists()).toBe(false)
    expect(wrapper.find('input').exists()).toBe(false)
    expect(text).not.toContain('PC 采集器')
    expect(text).not.toContain('Loom Token')
    expect(text).not.toContain('环境预检')
  })
})
