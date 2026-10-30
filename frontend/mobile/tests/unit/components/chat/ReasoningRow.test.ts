import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ReasoningRow from '@/components/chat/ReasoningRow.vue'
import AppIcon from '@/components/common/AppIcon.vue'

const TEXT = '第一行推理\n第二行推理\n第三行推理'

describe('ReasoningRow', () => {
  it('collapsed view shows a brain glyph, label, dot and one-line preview', () => {
    const wrapper = mount(ReasoningRow, { props: { text: TEXT } })
    const row = wrapper.get('[data-testid="reasoning-row"]')

    expect(row.attributes('data-state')).toBe('collapsed')
    expect(wrapper.getComponent(AppIcon).props('name')).toBe('Brain')
    expect(wrapper.get('.reasoning-row__label').text()).toBe('思考')
    expect(wrapper.find('.reasoning-row__dot').exists()).toBe(true)
    expect(wrapper.get('[data-testid="reasoning-preview"]').text()).toBe(
      '第一行推理 第二行推理 第三行推理',
    )
    expect(wrapper.get('.reasoning-row__header').attributes('aria-expanded')).toBe('false')
  })

  it('expands into the full text and hides the preview', async () => {
    const wrapper = mount(ReasoningRow, { props: { text: TEXT } })

    await wrapper.get('.reasoning-row__header').trigger('click')

    expect(wrapper.get('[data-testid="reasoning-row"]').attributes('data-state')).toBe('expanded')
    expect(wrapper.find('[data-testid="reasoning-preview"]').exists()).toBe(false)
    expect(wrapper.get('.reasoning-row__header').attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('[data-testid="reasoning-body"]').text()).toBe(TEXT)
  })

  it('marks a live row without changing the collapsed state', () => {
    const wrapper = mount(ReasoningRow, { props: { text: TEXT, live: true } })

    expect(wrapper.get('[data-testid="reasoning-row"]').attributes('data-state')).toBe('collapsed')
    expect(wrapper.get('[data-testid="reasoning-row"]').attributes('data-live')).toBe('true')
    expect(wrapper.find('[data-testid="reasoning-preview"]').exists()).toBe(true)
  })

  it('shows the recorded duration', () => {
    const wrapper = mount(ReasoningRow, { props: { text: TEXT, durationMs: 1200 } })

    expect(wrapper.get('[data-testid="reasoning-duration"]').text()).toBe('1.2s')
  })
})
