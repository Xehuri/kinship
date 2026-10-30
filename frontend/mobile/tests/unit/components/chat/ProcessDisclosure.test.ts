import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ProcessDisclosure from '@/components/chat/ProcessDisclosure.vue'
import { makeTool, makeTurn, thinking } from './chatFixtures'

afterEach(() => {
  vi.useRealTimers()
})

describe('ProcessDisclosure', () => {
  it('keeps the body out of the DOM until expanded', () => {
    const wrapper = mount(ProcessDisclosure, {
      props: { turn: makeTurn({ steps: [thinking()] }) },
    })
    const root = wrapper.get('[data-testid="process-disclosure"]')

    expect(root.attributes('data-state')).toBe('collapsed')
    expect(wrapper.get('[data-testid="process-toggle"]').attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[data-testid="process-body"]').exists()).toBe(false)
  })

  it('renders activity groups without a visible group header', () => {
    const wrapper = mount(ProcessDisclosure, {
      props: {
        turn: makeTurn({ steps: [thinking(), makeTool('read'), makeTool('bash')] }),
        defaultExpanded: true,
      },
    })

    const groups = wrapper.findAll('[data-testid="process-group"]')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.attributes('aria-label')).toBe('读取文件、运行命令')
    expect(wrapper.find('.process-group__label').exists()).toBe(false)
    expect(wrapper.text()).not.toMatch(/请求|个工具/)
  })

  it('lets the default policy update until the user toggles, then the user wins', async () => {
    const wrapper = mount(ProcessDisclosure, {
      props: { turn: makeTurn({ steps: [thinking()] }), defaultExpanded: false },
    })

    await wrapper.setProps({ defaultExpanded: true })
    expect(wrapper.find('[data-testid="process-body"]').exists()).toBe(true)

    await wrapper.setProps({ defaultExpanded: false })
    expect(wrapper.find('[data-testid="process-body"]').exists()).toBe(false)

    await wrapper.get('[data-testid="process-toggle"]').trigger('click')
    await wrapper.setProps({ defaultExpanded: true })
    await wrapper.setProps({ defaultExpanded: false })
    expect(wrapper.find('[data-testid="process-body"]').exists()).toBe(true)
  })

  it('renders state and duration only in the header', () => {
    const wrapper = mount(ProcessDisclosure, {
      props: {
        turn: makeTurn({
          startedAt: 1000,
          terminal: { reason: 'done', at: 43000 },
          steps: [thinking(), makeTool('read')],
        }),
      },
    })

    const label = wrapper.get('.process-disclosure__label').text()
    expect(label).toBe('已完成 · 用时 42.0s')
    expect(label).not.toMatch(/请求|个工具|\d+ 个/)
  })

  it('marks a live turn as running and lets the header tick', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100000)

    const wrapper = mount(ProcessDisclosure, {
      props: {
        turn: makeTurn({ live: true, startedAt: 87700, steps: [thinking()] }),
      },
    })

    expect(wrapper.get('[data-testid="process-disclosure"]').attributes('data-status')).toBe('running')
    expect(wrapper.get('.process-disclosure__label').text()).toBe('正在处理 · 12.3s')

    vi.advanceTimersByTime(1000)
    await wrapper.vm.$nextTick()
    expect(wrapper.get('.process-disclosure__label').text()).toBe('正在处理 · 13.3s')

    wrapper.unmount()
  })

  it('renders nothing when the turn has no process steps', () => {
    const wrapper = mount(ProcessDisclosure, {
      props: { turn: makeTurn({ steps: [] }), defaultExpanded: true },
    })

    expect(wrapper.find('[data-testid="process-disclosure"]').exists()).toBe(false)
  })
})
