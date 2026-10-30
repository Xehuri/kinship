import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import PlanItemRow from '@/components/plan/PlanItemRow.vue'
import { PLAN } from './fixtures'
import type { PlanItem } from '@/types'

describe('PlanItemRow', () => {
  it('renders the intent, status, kind, window, checkpoint and facts', () => {
    const wrapper = mount(PlanItemRow, {
      props: { item: PLAN.items[0] },
    })

    expect(wrapper.get('[data-testid="plan-item-intent"]').text()).toBe('材料提交')
    expect(wrapper.text()).toContain('计划中')
    expect(wrapper.text()).toContain('照看')
    expect(wrapper.text()).toContain('09:30~11:00')
    expect(wrapper.text()).toContain('cov-08')
    expect(wrapper.text()).toContain('完成条件')
    expect(wrapper.text()).toContain('材料提交成功')
    expect(wrapper.text()).toContain('不做')
    expect(wrapper.text()).toContain('不主动提理发')
    expect(wrapper.text()).toContain('备注')
    expect(wrapper.text()).toContain('缺一张照片')
    expect(wrapper.text()).toContain('目标 2026-10-28')
  })

  it('renders no interactive controls because the plan is read only', () => {
    const wrapper = mount(PlanItemRow, {
      props: { item: PLAN.items[0] },
    })

    expect(wrapper.find('button').exists()).toBe(false)
    expect(wrapper.find('input').exists()).toBe(false)
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.html()).not.toContain('contenteditable')
  })

  it('maps done, skipped, carried and blocked item statuses', () => {
    const cases = [
      ['done', '已完成'],
      ['skipped', '已跳过'],
      ['carried', '顺延'],
      ['blocked', '受阻'],
    ] as const

    for (const [status, label] of cases) {
      const item: PlanItem = { ...PLAN.items[0], status }
      const wrapper = mount(PlanItemRow, { props: { item } })
      expect(wrapper.get('.plan-item__status').text()).toBe(label)
    }
  })

  it('omits the facts table when the item has no optional detail', () => {
    const item: PlanItem = {
      id: 'c3',
      kind: 'note',
      intent: '留一点空档',
      status: 'planned',
    }
    const wrapper = mount(PlanItemRow, { props: { item } })

    expect(wrapper.find('.plan-item__facts').exists()).toBe(false)
    expect(wrapper.get('[data-testid="plan-item-intent"]').text()).toBe('留一点空档')
    expect(wrapper.text()).not.toContain('完成条件')
  })
})
