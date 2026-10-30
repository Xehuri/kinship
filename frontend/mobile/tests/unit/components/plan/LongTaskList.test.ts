import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import LongTaskList from '@/components/plan/LongTaskList.vue'
import { DUE_TASK, PAUSED_TASK } from './fixtures'

describe('LongTaskList', () => {
  it('renders title, intent, cadence, next check and status', () => {
    const wrapper = mount(LongTaskList, {
      props: { tasks: [DUE_TASK] },
    })

    const row = wrapper.get('[data-testid="long-task-row"]')
    expect(row.text()).toContain('每周复盘')
    expect(row.text()).toContain('把一周的事收口')
    expect(row.text()).toContain('每周')
    expect(row.text()).toContain('2026-10-28')
    expect(row.text()).toContain('20:00')
    expect(row.text()).toContain('进行中')
    expect(row.attributes('data-status')).toBe('active')
  })

  it('shows a paused task with its own status label', () => {
    const wrapper = mount(LongTaskList, {
      props: { tasks: [PAUSED_TASK] },
    })

    expect(wrapper.get('[data-testid="long-task-row"]').text()).toContain('已暂停')
    expect(wrapper.get('[data-testid="long-task-row"]').attributes('data-status')).toBe(
      'paused',
    )
  })

  it('shows the empty state when no long task is due', () => {
    const wrapper = mount(LongTaskList, {
      props: { tasks: [] },
    })

    expect(wrapper.find('[data-testid="long-task-row"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="long-task-empty"]').text()).toBe(
      '今天没有到期的长期任务。',
    )
  })
})
