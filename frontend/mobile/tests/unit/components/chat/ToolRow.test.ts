import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ToolRow from '@/components/chat/ToolRow.vue'
import ToolResultCard from '@/components/chat/ToolResultCard.vue'
import type { ToolStatus } from '@/types/turn'
import { makeResult, makeTool } from './chatFixtures'

describe('ToolRow header', () => {
  it('renders the registry icon, verb, summary and duration', () => {
    const wrapper = mount(ToolRow, {
      props: {
        step: makeTool('bash', {
          arguments: { command: 'npm run test' },
          durationMs: 1200,
          result: makeResult('全部通过'),
        }),
      },
    })

    expect(wrapper.get('[data-testid="tool-name"]').text()).toBe('bash')
    expect(wrapper.get('.tool-row__verb').text()).toBe('运行')
    expect(wrapper.get('.tool-row__summary').text()).toBe('npm run test')
    expect(wrapper.get('[data-testid="tool-duration"]').text()).toBe('1.2s')
    expect(wrapper.get('[data-testid="tool-row"]').attributes('data-tool')).toBe('bash')
  })

  it('orders the raw tool name before the human verb', () => {
    const wrapper = mount(ToolRow, {
      props: {
        step: makeTool('read', { arguments: { path: '/demo/health.json' } }),
      },
    })
    const html = wrapper.get('.tool-row__header').html()

    expect(wrapper.get('[data-testid="tool-name"]').text()).toBe('read')
    expect(html.indexOf('tool-row__icon')).toBeLessThan(html.indexOf('data-testid="tool-name"'))
    expect(html.indexOf('data-testid="tool-name"')).toBeLessThan(html.indexOf('tool-row__verb'))
  })

  it('keeps a completed tool silent: no status word and no success glyph', () => {
    const wrapper = mount(ToolRow, {
      props: { step: makeTool('read', { status: 'completed' }) },
    })

    expect(wrapper.find('.tool-row__status').exists()).toBe(false)
    expect(wrapper.find('.status-glyph').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('完成')
    expect(wrapper.get('[data-testid="tool-row"]').attributes('data-status')).toBe('completed')
  })

  it('marks every non-completed status with the right tone', () => {
    const cases: Array<{ status: ToolStatus; tone: string | undefined; text: string }> = [
      { status: 'pending', tone: undefined, text: '待执行' },
      { status: 'running', tone: undefined, text: '' },
      { status: 'error', tone: 'error', text: '失败' },
      { status: 'abandoned', tone: 'warning', text: '未返回' },
    ]

    for (const testCase of cases) {
      const wrapper = mount(ToolRow, {
        props: {
          step: makeTool('bash', {
            status: testCase.status,
            result: makeResult('输出', { isError: testCase.status === 'error' }),
          }),
        },
      })
      const row = wrapper.get('[data-testid="tool-row"]')

      expect(row.attributes('data-status')).toBe(testCase.status)
      if (testCase.tone === undefined) {
        expect(row.attributes('data-tone')).toBeUndefined()
      } else {
        expect(row.attributes('data-tone')).toBe(testCase.tone)
      }
      if (testCase.text.length > 0) {
        expect(wrapper.get('.tool-row__status').text()).toBe(testCase.text)
      }
      if (testCase.status === 'running') {
        expect(row.attributes('data-live')).toBe('true')
      }
      wrapper.unmount()
    }
  })
})

describe('ToolRow disclosure', () => {
  it('expands into the result card and forwards open-focus', async () => {
    const text = 'A'.repeat(1500)
    const wrapper = mount(ToolRow, {
      props: {
        step: makeTool('read', {
          arguments: { path: '/demo/health.json' },
          result: makeResult(text),
        }),
      },
    })

    expect(wrapper.find('[data-testid="tool-result-card"]').exists()).toBe(false)
    await wrapper.get('.tool-row__header').trigger('click')
    expect(wrapper.find('[data-testid="tool-result-card"]').exists()).toBe(true)

    await wrapper.get('[data-testid="tool-result-card__focus"]').trigger('click')
    const payload = wrapper.emitted('open-focus')?.[0]?.[0]
    expect(payload).toMatchObject({ title: 'read 输出', content: text })
    expect(wrapper.findComponent(ToolResultCard).exists()).toBe(true)
  })
})
