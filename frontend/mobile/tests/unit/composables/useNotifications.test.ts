import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useNotifications, useNotificationsSingleton } from '@/composables/useNotifications'

const fetchNotificationHistory = vi.hoisted(() => vi.fn())
const deleteNotificationRequest = vi.hoisted(() => vi.fn())

vi.mock('@/api/notifications', () => ({
  fetchNotificationHistory,
  deleteNotification: deleteNotificationRequest,
}))

const FIRST = { id: 12, title: '喝水提醒', content: '下午记得喝水', created_at: 1761300000 }
const SECOND = { id: 11, title: '睡眠报告', content: '昨晚深睡 6 小时', created_at: 1761290000 }

describe('useNotifications', () => {
  beforeEach(() => {
    fetchNotificationHistory.mockReset()
    deleteNotificationRequest.mockReset()
  })

  it('opens the drawer and loads real history from the API', async () => {
    fetchNotificationHistory.mockResolvedValue({ notifications: [FIRST, SECOND], total: 2 })
    const notifications = useNotifications()

    await notifications.open()

    expect(fetchNotificationHistory).toHaveBeenCalledTimes(1)
    expect(notifications.visible.value).toBe(true)
    expect(notifications.state.value).toBe('success')
    expect(notifications.notifications.value).toEqual([FIRST, SECOND])
    expect(notifications.total.value).toBe(2)
  })

  it('marks the error state without inventing notifications when the request fails', async () => {
    fetchNotificationHistory.mockResolvedValue(null)
    const notifications = useNotifications()

    await notifications.open()

    expect(notifications.visible.value).toBe(true)
    expect(notifications.state.value).toBe('error')
    expect(notifications.notifications.value).toEqual([])
    expect(notifications.total.value).toBe(0)
  })

  it('rejects a malformed response instead of rendering partial data', async () => {
    fetchNotificationHistory.mockResolvedValue({ total: 3 })
    const notifications = useNotifications()

    await notifications.load()

    expect(notifications.state.value).toBe('error')
    expect(notifications.notifications.value).toEqual([])
  })

  it('recovers through load() after an error (retry path)', async () => {
    fetchNotificationHistory
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ notifications: [FIRST], total: 1 })
    const notifications = useNotifications()

    await notifications.load()
    expect(notifications.state.value).toBe('error')

    await notifications.load()
    expect(notifications.state.value).toBe('success')
    expect(notifications.notifications.value).toEqual([FIRST])
  })

  it('toggles open and closed without touching the list on close', async () => {
    fetchNotificationHistory.mockResolvedValue({ notifications: [FIRST], total: 1 })
    const notifications = useNotifications()

    await notifications.toggle()
    expect(notifications.visible.value).toBe(true)

    await notifications.toggle()
    expect(notifications.visible.value).toBe(false)
    expect(notifications.notifications.value).toEqual([FIRST])
  })

  it('deletes a notification through the DELETE endpoint and removes it locally', async () => {
    fetchNotificationHistory.mockResolvedValue({ notifications: [FIRST, SECOND], total: 2 })
    deleteNotificationRequest.mockResolvedValue({ status: 'ok' })
    const notifications = useNotifications()
    await notifications.load()

    const deleted = await notifications.deleteNotification(FIRST.id)

    expect(deleted).toBe(true)
    expect(deleteNotificationRequest).toHaveBeenCalledWith(FIRST.id)
    expect(notifications.notifications.value).toEqual([SECOND])
    expect(notifications.total.value).toBe(1)
    expect(notifications.deletingId.value).toBeNull()
  })

  it('keeps the list intact when delete fails', async () => {
    fetchNotificationHistory.mockResolvedValue({ notifications: [FIRST, SECOND], total: 2 })
    deleteNotificationRequest.mockResolvedValue(null)
    const notifications = useNotifications()
    await notifications.load()

    const deleted = await notifications.deleteNotification(FIRST.id)

    expect(deleted).toBe(false)
    expect(notifications.notifications.value).toEqual([FIRST, SECOND])
    expect(notifications.total.value).toBe(2)
    expect(notifications.deletingId.value).toBeNull()
  })

  it('shares one singleton between the floating bell and the reminders entry', () => {
    const first = useNotificationsSingleton()
    const second = useNotificationsSingleton()

    expect(first).toBe(second)
  })
})
