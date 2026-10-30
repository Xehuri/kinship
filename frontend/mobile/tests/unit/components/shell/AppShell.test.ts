import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const push = vi.hoisted(() => vi.fn())
const openNotifications = vi.hoisted(() => vi.fn())

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/reports', meta: { shell: 'v2' } }),
  useRouter: () => ({ push }),
}))

vi.mock('@/composables/useNotifications', () => ({
  useNotificationsSingleton: () => ({ open: openNotifications }),
}))

import AppShell from '@/components/shell/AppShell.vue'

describe('AppShell', () => {
  it('renders six desktop nav items and four mobile nav items', () => {
    const wrapper = mount(AppShell, {
      props: { title: '报告', meta: '共 3 份' },
    })

    const desktop = wrapper.findAll('.ax-nav__item')
    const mobile = wrapper.findAll('.ax-mobile-nav__item')

    expect(desktop).toHaveLength(6)
    expect(mobile).toHaveLength(4)
    expect(desktop.map((item) => item.attributes('aria-label'))).toEqual([
      '对话',
      '计划',
      '提醒',
      '报告',
      '文件',
      '设置',
    ])
    expect(mobile.map((item) => item.find('.ax-mobile-nav__label').text())).toEqual([
      '对话',
      '计划',
      '报告',
      '设置',
    ])
  })

  it('does not render a health or dashboard entry', () => {
    const wrapper = mount(AppShell, { props: { title: '报告' } })
    const labels = wrapper.findAll('.ax-nav__item').map((item) => item.text())

    expect(labels).not.toContain('看板')
    expect(labels).not.toContain('健康')
    expect(labels.some((label) => label.includes('数据源'))).toBe(false)
  })

  it('marks the current route active and pushes nav targets', async () => {
    const wrapper = mount(AppShell, { props: { title: '报告' } })

    expect(wrapper.find('.ax-nav__item--active').attributes('aria-label')).toBe('报告')
    expect(wrapper.find('.ax-mobile-nav__item--active .ax-mobile-nav__label').text()).toBe('报告')

    await wrapper.findAll('.ax-nav__item')[1].trigger('click')
    expect(push).toHaveBeenLastCalledWith('/plan')

    await wrapper.findAll('.ax-nav__item')[2].trigger('click')
    expect(push).toHaveBeenLastCalledWith('/reminders')
  })

  it('renders the brand and page header', () => {
    const wrapper = mount(AppShell, { props: { title: '提醒', meta: '更新于今天' } })

    expect(wrapper.find('.ax-nav__brand-name').text()).toBe('Kinship')
    expect(wrapper.find('.ax-nav__brand-sub').text()).toBe('知己')
    expect(wrapper.find('.ax-page-header__title').text()).toBe('提醒')
    expect(wrapper.find('.ax-page-header__meta').text()).toBe('更新于今天')
  })

  it('always renders a global notifications bell in the page header', async () => {
    const wrapper = mount(AppShell, { props: { title: '提醒' } })
    const bell = wrapper.get('[data-testid="notifications-trigger"]')

    expect(bell.attributes('aria-label')).toBe('通知历史')
    await bell.trigger('click')
    expect(openNotifications).toHaveBeenCalledTimes(1)
  })

  it('renders the inspector slot inside the shell aside', () => {
    const wrapper = mount(AppShell, {
      props: { title: '对话' },
      slots: { inspector: '<div data-testid="inspector-content">用量</div>' },
    })
    const aside = wrapper.get('[data-testid="inspector-slot"]')

    expect(aside.element.tagName).toBe('ASIDE')
    expect(aside.attributes('aria-label')).toBe('上下文')
    expect(aside.find('[data-testid="inspector-content"]').text()).toBe('用量')
    expect(wrapper.get('.ax-shell').classes()).not.toContain('ax-shell--no-inspector')
  })

  it('marks the shell as having no inspector when the slot is absent', () => {
    const wrapper = mount(AppShell, { props: { title: '对话' } })

    expect(wrapper.get('.ax-shell').classes()).toContain('ax-shell--no-inspector')
  })

  it('toggles and reflects the inspector open state from the header trigger', async () => {
    const wrapper = mount(AppShell, {
      props: { title: '对话' },
      slots: { inspector: '<div />' },
    })
    const trigger = wrapper.get('[data-testid="inspector-trigger"]')

    expect(trigger.attributes('aria-expanded')).toBe('false')
    await trigger.trigger('click')
    expect(wrapper.emitted('update:inspectorOpen')).toEqual([[true]])

    await wrapper.setProps({ inspectorOpen: true })
    expect(wrapper.get('.ax-shell').classes()).toContain('ax-shell--inspector-open')
    expect(trigger.attributes('aria-expanded')).toBe('true')

    await trigger.trigger('click')
    expect(wrapper.emitted('update:inspectorOpen')).toEqual([[true], [false]])
  })

  it('closes the inspector from the aside close button', async () => {
    const wrapper = mount(AppShell, {
      props: { title: '对话', inspectorOpen: true },
      slots: { inspector: '<div />' },
    })

    await wrapper.get('[data-testid="inspector-close"]').trigger('click')

    expect(wrapper.emitted('update:inspectorOpen')).toEqual([[false]])
  })

  it('does not render the inspector trigger without an inspector slot', () => {
    const wrapper = mount(AppShell, { props: { title: '对话' } })

    expect(wrapper.find('[data-testid="inspector-trigger"]').exists()).toBe(false)
  })
})
