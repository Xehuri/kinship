import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import type { PlanDayResponse } from '@/types'

const mocks = vi.hoisted(() => ({
  fetchEffectivePlan: vi.fn(),
  fetchPlanDay: vi.fn(),
  fetchLongTasks: vi.fn(),
  sendMessage: vi.fn(),
  fetchCurrentSessionId: vi.fn(),
  listSessions: vi.fn(),
}))

vi.mock('@/api/plan', () => ({
  fetchEffectivePlan: mocks.fetchEffectivePlan,
  fetchPlanDay: mocks.fetchPlanDay,
  fetchLongTasks: mocks.fetchLongTasks,
}))

vi.mock('@/api/session', () => ({
  sendMessage: mocks.sendMessage,
  fetchCurrentSessionId: mocks.fetchCurrentSessionId,
  listSessions: mocks.listSessions,
  normalizeSession: (raw: unknown) => raw,
}))

import PlanView from '@/views/PlanView.vue'
import { DUE_TASK, FUTURE_TASK, PLAN, PLAN_DATE } from './fixtures'

const AppShellStub = defineComponent({
  props: {
    title: { type: String, required: true },
    meta: { type: String, default: '' },
  },
  template: `
    <div class="shell-stub">
      <h1 data-testid="shell-title">{{ title }}</h1>
      <p data-testid="shell-meta">{{ meta }}</p>
      <div data-testid="shell-actions"><slot name="actions" /></div>
      <div data-testid="shell-body"><slot /></div>
    </div>
  `,
})

function dayResponse(date = PLAN_DATE): PlanDayResponse {
  return {
    date,
    plan: { ...PLAN, date },
    coverage: PLAN.coverage,
    long_tasks_due: [],
    warnings: ['debt 未收口'],
    generated_at: 1793143800,
  }
}

function mountView() {
  return mount(PlanView, {
    global: {
      stubs: { AppShell: AppShellStub },
    },
  })
}

describe('PlanView', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 28, 9, 0, 0))
    vi.resetAllMocks()
    mocks.fetchEffectivePlan.mockResolvedValue(null)
    mocks.fetchPlanDay.mockResolvedValue(dayResponse())
    mocks.fetchLongTasks.mockResolvedValue({
      tasks: [DUE_TASK, FUTURE_TASK],
      generated_at: 1793143800,
    })
    mocks.fetchCurrentSessionId.mockResolvedValue('ses-current')
    mocks.listSessions.mockResolvedValue([{ id: 'ses-current', title: '当前会话' }])
    mocks.sendMessage.mockResolvedValue({ status: 'ok' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the header, date, status, coverage, items, warnings and due long tasks', async () => {
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.get('[data-testid="shell-title"]').text()).toBe('计划')
    expect(wrapper.get('[data-testid="plan-page"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="plan-date"]').text()).toBe(PLAN_DATE)
    expect(wrapper.get('[data-testid="plan-status"]').text()).toBe('已提交')
    expect(wrapper.get('[data-testid="plan-docmeta"]').text()).toContain('v2')
    expect(wrapper.get('[data-testid="plan-review"]').text()).toContain(
      '2026-10-28 07:30',
    )

    const coverageRows = wrapper.findAll('[data-testid="coverage-row"]')
    expect(coverageRows).toHaveLength(7)
    expect(coverageRows[0].text()).toContain('00:00（分析昨天）')

    expect(wrapper.text()).toContain('材料提交')
    expect(wrapper.text()).toContain('材料提交成功')
    expect(wrapper.text()).toContain('不主动提理发')
    expect(wrapper.text()).toContain('缺一张照片')

    const longTasks = wrapper.findAll('[data-testid="long-task-row"]')
    expect(longTasks).toHaveLength(1)
    expect(longTasks[0].text()).toContain('每周复盘')
    expect(wrapper.text()).not.toContain('下个月复诊')

    expect(wrapper.get('[data-testid="plan-warnings"]').text()).toContain(
      'debt 未收口',
    )
    expect(wrapper.find('[data-testid="plan-empty"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="plan-error"]').exists()).toBe(false)
  })

  it('shows the loading skeleton while the first request is pending', async () => {
    let resolveDay: (value: PlanDayResponse) => void = () => {}
    mocks.fetchPlanDay.mockReturnValue(
      new Promise<PlanDayResponse>((resolve) => {
        resolveDay = resolve
      }),
    )

    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.find('[data-testid="plan-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="plan-empty"]').exists()).toBe(false)

    resolveDay(dayResponse())
    await flushPromises()

    expect(wrapper.find('[data-testid="plan-loading"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('材料提交')
  })

  it('shows the empty state with a retry action when the plan is null', async () => {
    mocks.fetchPlanDay.mockResolvedValue({
      date: PLAN_DATE,
      plan: null,
      coverage: null,
      long_tasks_due: [],
      warnings: [],
      generated_at: 1793143800,
    })

    const wrapper = mountView()
    await flushPromises()

    const empty = wrapper.get('[data-testid="plan-empty"]')
    expect(empty.text()).toContain('今天还没有计划')
    expect(empty.get('button').text()).toBe('重试')

    await empty.get('button').trigger('click')
    await flushPromises()

    expect(mocks.fetchPlanDay).toHaveBeenCalledTimes(2)
  })

  it('shows the error state when the first request fails', async () => {
    mocks.fetchPlanDay.mockRejectedValue(new Error('500'))

    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.get('[data-testid="plan-error"]').text()).toContain(
      '计划加载失败',
    )
    expect(wrapper.find('[data-testid="plan-empty"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="plan-loading"]').exists()).toBe(false)
  })

  it('keeps the last good plan when a later request fails', async () => {
    const wrapper = mountView()
    await flushPromises()

    expect(wrapper.text()).toContain('材料提交')

    mocks.fetchPlanDay.mockRejectedValue(new Error('boom'))
    await wrapper.get('[data-testid="plan-next-day"]').trigger('click')
    await flushPromises()

    expect(mocks.fetchPlanDay).toHaveBeenLastCalledWith('2026-10-29')
    expect(wrapper.get('[data-testid="plan-date"]').text()).toBe('2026-10-29')
    expect(wrapper.get('[data-testid="plan-error"]').text()).toContain('boom')
    expect(wrapper.text()).toContain('材料提交')
  })

  it('moves the date one day and refreshes on every change', async () => {
    const wrapper = mountView()
    await flushPromises()

    expect(mocks.fetchPlanDay).toHaveBeenCalledWith(PLAN_DATE)

    await wrapper.get('[data-testid="plan-prev-day"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="plan-date"]').text()).toBe('2026-10-27')
    expect(mocks.fetchPlanDay).toHaveBeenLastCalledWith('2026-10-27')

    await wrapper.get('[data-testid="plan-next-day"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="plan-date"]').text()).toBe('2026-10-28')

    await wrapper.get('[data-testid="plan-next-day"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="plan-date"]').text()).toBe('2026-10-29')

    await wrapper.get('[data-testid="plan-today"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="plan-date"]').text()).toBe(PLAN_DATE)
    expect(mocks.fetchPlanDay).toHaveBeenLastCalledWith(PLAN_DATE)
  })

  it('sends exactly one replan request through the chat path', async () => {
    const wrapper = mountView()
    await flushPromises()

    await wrapper.get('[data-testid="plan-replan"]').trigger('click')
    await flushPromises()

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      session_id: 'ses-current',
      content: '【计划重排】请根据今天的计划重新安排。',
      backend: 'loom',
    })
    expect(wrapper.get('[data-testid="plan-replan-feedback"]').text()).toContain(
      '已发送给 Loom',
    )
    expect(wrapper.get('[data-testid="plan-replan"]').attributes('disabled')).toBeUndefined()
  })

  it('renders no plan edit controls', async () => {
    const wrapper = mountView()
    await flushPromises()

    const page = wrapper.get('[data-testid="plan-page"]')
    expect(page.find('input').exists()).toBe(false)
    expect(page.find('textarea').exists()).toBe(false)
    expect(page.find('select').exists()).toBe(false)
    expect(page.html()).not.toContain('contenteditable')
  })
})
