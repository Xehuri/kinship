import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const fetchReminders = vi.hoisted(() => vi.fn())
const fetchNotificationHistory = vi.hoisted(() => vi.fn())

vi.mock('@/api/reminders', () => ({
  fetchReminders,
}))

vi.mock('@/api/notifications', () => ({
  fetchNotificationHistory,
  deleteNotification: vi.fn(),
}))

import RemindersView from '@/views/RemindersView.vue'
import { useNotificationsSingleton } from '@/composables/useNotifications'

const stubs = {
  AppShell: {
    props: ['title', 'meta'],
    template: '<div class="ax-shell"><slot name="actions" /><slot /></div>',
  },
}

function expectedUpdatedLabel(seconds: number): string {
  const date = new Date(seconds * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

describe('RemindersView', () => {
  beforeEach(() => {
    fetchReminders.mockReset()
    fetchNotificationHistory.mockReset()
    fetchNotificationHistory.mockResolvedValue({ notifications: [], total: 0 })
    useNotificationsSingleton().close()
  })

  afterEach(() => {
    useNotificationsSingleton().close()
    vi.restoreAllMocks()
  })

  it('renders non-empty board lines and the updated timestamp', async () => {
    const updatedAt = 1761300000
    fetchReminders.mockResolvedValue({
      text: '第一行提醒\n\n  第二行提醒  \n第三行提醒',
      updated_at: updatedAt,
    })

    const wrapper = mount(RemindersView, { global: { stubs } })
    await flushPromises()

    const lines = wrapper.findAll('.ax-reminders__line')
    expect(lines).toHaveLength(3)
    expect(lines.map((line) => line.text())).toEqual([
      '·第一行提醒',
      '·  第二行提醒',
      '·第三行提醒',
    ])
    expect(wrapper.find('.ax-reminders__updated').text()).toBe(
      `更新于 ${expectedUpdatedLabel(updatedAt)}`,
    )
    expect(wrapper.find('input').exists()).toBe(false)
    expect(wrapper.find('textarea').exists()).toBe(false)
  })

  it('shows an empty state for a blank board', async () => {
    fetchReminders.mockResolvedValue({ text: '\n  \n', updated_at: 0 })

    const wrapper = mount(RemindersView, { global: { stubs } })
    await flushPromises()

    expect(wrapper.find('.ax-state__title').text()).toBe('暂无提醒')
    expect(wrapper.findAll('.ax-reminders__line')).toHaveLength(0)
    expect(wrapper.find('.ax-reminders__updated').exists()).toBe(false)
  })

  it('shows an error state with retry', async () => {
    fetchReminders.mockResolvedValue(null)

    const wrapper = mount(RemindersView, { global: { stubs } })
    await flushPromises()

    expect(wrapper.find('.ax-state[role="alert"]').exists()).toBe(true)
    await wrapper.find('.ax-state__action').trigger('click')
    await flushPromises()
    expect(fetchReminders).toHaveBeenCalledTimes(2)
  })
})

describe('RemindersView 通知历史入口', () => {
  beforeEach(() => {
    fetchReminders.mockReset()
    fetchReminders.mockResolvedValue({ text: '提醒一', updated_at: 1761300000 })
    fetchNotificationHistory.mockReset()
    fetchNotificationHistory.mockResolvedValue({ notifications: [], total: 0 })
    useNotificationsSingleton().close()
  })

  afterEach(() => {
    useNotificationsSingleton().close()
    vi.restoreAllMocks()
  })

  it('opens the shared notifications drawer from the read-only history entry', async () => {
    const wrapper = mount(RemindersView, { global: { stubs } })
    await flushPromises()

    const notifications = useNotificationsSingleton()
    expect(notifications.visible.value).toBe(false)

    const entry = wrapper.get('[data-testid="reminders-notifications"]')
    expect(entry.text()).toContain('通知历史')

    await entry.trigger('click')
    await flushPromises()

    expect(notifications.visible.value).toBe(true)
    expect(fetchNotificationHistory).toHaveBeenCalledTimes(1)
  })
})
