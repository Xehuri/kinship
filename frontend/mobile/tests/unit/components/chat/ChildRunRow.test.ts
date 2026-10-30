import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ChildRunRow from '@/components/chat/ChildRunRow.vue'
import AppIcon from '@/components/common/AppIcon.vue'

describe('ChildRunRow', () => {
  it('renders label, agent, turns, records and duration without fetching data', () => {
    const wrapper = mount(ChildRunRow, {
      props: {
        id: 'child-1',
        label: '整理文件',
        agent: 'general',
        turns: 3,
        records: 12,
        durationMs: 1500,
        status: 'completed',
      },
    })

    const row = wrapper.get('[data-testid="child-run-row"]')
    expect(row.text()).toContain('整理文件')
    expect(row.text()).toContain('general')
    expect(row.text()).toContain('3 轮')
    expect(row.text()).toContain('12 条记录')
    expect(row.text()).toContain('1.5s')
    expect(wrapper.getComponent(AppIcon).props('name')).toBe('GitBranch')
  })

  it('emits open-child with the id when activated', async () => {
    const wrapper = mount(ChildRunRow, {
      props: {
        id: 'child-42',
        label: '后台任务',
        turns: 1,
        records: 2,
      },
    })

    await wrapper.get('[data-testid="child-run-row"]').trigger('click')

    expect(wrapper.emitted('open-child')).toEqual([['child-42']])
  })

  it('falls back to an unlabelled agent', () => {
    const wrapper = mount(ChildRunRow, {
      props: {
        id: 'child-2',
        label: '任务',
        turns: 1,
        records: 1,
      },
    })

    expect(wrapper.get('[data-testid="child-run-row"]').text()).toContain('未标注')
  })
})
