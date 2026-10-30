/// <reference types="vitest/globals" />

import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SettingsSection from '@/components/settings/SettingsSection.vue'

function mountSection() {
  return mount(SettingsSection, {
    props: {
      title: '账户',
      description: '登录状态与访问凭据',
    },
    slots: {
      actions: '<button type="button" class="test-section-action">刷新</button>',
      default: '<div class="test-section-body">内容</div>',
    },
  })
}

describe('SettingsSection', () => {
  it('渲染标题区容器、描述、动作槽与默认槽', () => {
    const wrapper = mountSection()

    const heading = wrapper.find('.settings-section__heading')
    expect(heading.exists()).toBe(true)

    const title = heading.find('.settings-section__title')
    expect(title.exists()).toBe(true)
    expect(title.text()).toBe('账户')

    const description = heading.find('.settings-section__desc')
    expect(description.exists()).toBe(true)
    expect(description.text()).toBe('登录状态与访问凭据')

    const actions = wrapper.find('.settings-section__actions')
    expect(actions.exists()).toBe(true)
    expect(actions.find('.test-section-action').exists()).toBe(true)
    expect(actions.text()).toBe('刷新')

    const body = wrapper.find('.settings-section__body')
    expect(body.exists()).toBe(true)
    expect(body.find('.test-section-body').exists()).toBe(true)
    expect(body.text()).toBe('内容')
  })

  it('标题使用 H3 语义并保留 settings-section__title 类', () => {
    const wrapper = mountSection()
    const title = wrapper.find('.settings-section__title')

    expect(title.exists()).toBe(true)
    expect(title.classes()).toContain('settings-section__title')
    expect(title.element.tagName).toBe('H3')
  })
})
