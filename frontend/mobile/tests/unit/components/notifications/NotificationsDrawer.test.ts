import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import NotificationsDrawer from '@/components/notifications/NotificationsDrawer.vue'

const ITEMS = [
  { id: 12, title: '喝水提醒', content: '下午记得喝水', created_at: 1761300000 },
  { id: 11, title: '睡眠报告', content: '昨晚深睡 6 小时', created_at: 1761290000 },
]

const mounted: Array<ReturnType<typeof mount>> = []

function mountDrawer(props: Record<string, unknown> = {}) {
  const wrapper = mount(NotificationsDrawer, {
    attachTo: document.body,
    props: {
      visible: true,
      notifications: ITEMS,
      total: ITEMS.length,
      state: 'success',
      deletingId: null,
      ...props,
    },
    global: {
      stubs: { teleport: true },
    },
  })
  mounted.push(wrapper)
  return wrapper
}

afterEach(() => {
  while (mounted.length > 0) {
    mounted.pop()?.unmount()
  }
  document.documentElement.classList.remove('notifications-scroll-lock')
})

describe('NotificationsDrawer', () => {
  it('renders real notification title/content/time pairs from props', () => {
    const wrapper = mountDrawer()

    const items = wrapper.findAll('[data-testid="notification-item"]')
    expect(items).toHaveLength(2)
    expect(items[0].find('.notifications-drawer__item-title').text()).toBe('喝水提醒')
    expect(items[0].find('.notifications-drawer__item-content').text()).toBe('下午记得喝水')
    expect(items[0].find('time').attributes('datetime')).toBe(
      new Date(ITEMS[0].created_at * 1000).toISOString(),
    )
    expect(wrapper.text()).toContain('共 2 条')
  })

  it('renders a loading skeleton instead of a fake list', () => {
    const wrapper = mountDrawer({ state: 'loading', notifications: [], total: 0 })

    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="notification-item"]')).toHaveLength(0)
    expect(wrapper.find('[data-testid="notifications-empty"]').exists()).toBe(false)
  })

  it('renders the empty state with its test id', () => {
    const wrapper = mountDrawer({ state: 'success', notifications: [], total: 0 })

    expect(wrapper.get('[data-testid="notifications-empty"]').text()).toContain('暂无通知')
    expect(wrapper.findAll('[data-testid="notification-item"]')).toHaveLength(0)
  })

  it('renders an error state and emits retry', async () => {
    const wrapper = mountDrawer({ state: 'error', notifications: [], total: 0 })

    expect(wrapper.get('[role="alert"]').text()).toContain('加载失败')
    await wrapper.get('[data-testid="notifications-retry"]').trigger('click')

    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('emits delete with the notification id', async () => {
    const wrapper = mountDrawer()

    await wrapper.findAll('[data-testid="notification-delete"]')[0].trigger('click')

    expect(wrapper.emitted('delete')).toEqual([[12]])
  })

  it('disables the row delete button while that notification is being deleted', () => {
    const wrapper = mountDrawer({ deletingId: 12 })

    const buttons = wrapper.findAll('[data-testid="notification-delete"]')
    expect(buttons[0].attributes('disabled')).toBeDefined()
    expect(buttons[1].attributes('disabled')).toBeUndefined()
  })

  it('closes through the header close button and the backdrop', async () => {
    const wrapper = mountDrawer()

    await wrapper.get('[aria-label="关闭通知历史"]').trigger('click')
    await wrapper.get('.notifications-drawer').trigger('click')

    expect(wrapper.emitted('close')).toHaveLength(2)
  })

  it('closes on Escape through the focus trap', async () => {
    const wrapper = mountDrawer()
    await nextTick()
    await flushPromises()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))

    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('focuses the first control on open and returns focus to the opener on close', async () => {
    const opener = document.createElement('button')
    opener.type = 'button'
    opener.textContent = 'open'
    document.body.appendChild(opener)
    opener.focus()

    const wrapper = mountDrawer({ visible: false })
    await wrapper.setProps({ visible: true })
    await nextTick()
    await flushPromises()

    expect(document.activeElement).toBe(wrapper.get('[aria-label="关闭通知历史"]').element)

    await wrapper.setProps({ visible: false })
    await nextTick()
    expect(document.activeElement).toBe(opener)

    opener.remove()
  })

  it('locks background scroll while open and releases it on close', async () => {
    const wrapper = mountDrawer({ visible: false })

    await wrapper.setProps({ visible: true })
    await nextTick()
    expect(document.documentElement.classList.contains('notifications-scroll-lock')).toBe(true)

    await wrapper.setProps({ visible: false })
    await nextTick()
    expect(document.documentElement.classList.contains('notifications-scroll-lock')).toBe(false)
  })
})
