import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ChatThread from '@/components/chat/ChatThread.vue'
import { compaction, makeTool, makeTurn, thinking } from './chatFixtures'

function childTestIds(wrapper: ReturnType<typeof mount>, index: number): string[] {
  const article = wrapper.findAll('[data-testid="chat-turn"]')[index]
  if (article === undefined) {
    throw new Error(`Missing turn at index ${index}`)
  }
  return Array.from((article.element as HTMLElement).children).map(
    (child) => child.getAttribute('data-testid') ?? '',
  )
}

describe('ChatThread', () => {
  it('orders each turn as user -> process -> assistant', () => {
    const wrapper = mount(ChatThread, {
      props: {
        turns: [
          makeTurn({ id: 't1', steps: [thinking()] }),
          makeTurn({ id: 't2', userText: '第二条', steps: [makeTool('read')] }),
        ],
      },
    })

    expect(wrapper.findAll('[data-testid="chat-turn"]')).toHaveLength(2)
    expect(childTestIds(wrapper, 0)).toEqual([
      'user-message',
      'process-disclosure',
      'assistant-message',
    ])
    expect(childTestIds(wrapper, 1)).toEqual([
      'user-message',
      'process-disclosure',
      'assistant-message',
    ])
  })

  it('expands only the latest user turn with process steps', () => {
    const wrapper = mount(ChatThread, {
      props: {
        turns: [
          makeTurn({ id: 't1', steps: [thinking()] }),
          makeTurn({ id: 't2', steps: [makeTool('read')] }),
          makeTurn({ id: 't3', steps: [thinking(), makeTool('bash')] }),
        ],
      },
    })

    const disclosures = wrapper.findAll('[data-testid="process-disclosure"]')
    expect(disclosures.map((item) => item.attributes('data-state'))).toEqual([
      'collapsed',
      'collapsed',
      'expanded',
    ])
    expect(wrapper.findAll('[data-testid="process-body"]')).toHaveLength(1)
  })

  it('does not expand an older process when the latest user turn has none', () => {
    const wrapper = mount(ChatThread, {
      props: {
        turns: [
          makeTurn({ id: 't1', steps: [thinking()] }),
          makeTurn({ id: 't2', userText: '只看这一条', steps: [], reply: '好的。' }),
        ],
      },
    })

    const disclosures = wrapper.findAll('[data-testid="process-disclosure"]')
    expect(disclosures).toHaveLength(1)
    expect(disclosures[0]?.attributes('data-state')).toBe('collapsed')
    expect(wrapper.findAll('[data-testid="process-body"]')).toHaveLength(0)
  })

  it('keeps a user-collapsed latest process collapsed', async () => {
    const wrapper = mount(ChatThread, {
      props: { turns: [makeTurn({ id: 't1', steps: [thinking()] })] },
    })
    const disclosure = wrapper.get('[data-testid="process-disclosure"]')
    expect(disclosure.attributes('data-state')).toBe('expanded')

    await disclosure.get('[data-testid="process-toggle"]').trigger('click')

    expect(disclosure.attributes('data-state')).toBe('collapsed')
    expect(wrapper.findAll('[data-testid="process-body"]')).toHaveLength(0)
  })

  it('renders a compaction-only turn as a divider without a fake user or reply', () => {
    const wrapper = mount(ChatThread, {
      props: {
        turns: [
          makeTurn({
            id: 'divider',
            userText: '',
            reply: '',
            steps: [compaction('压缩摘要正文')],
          }),
        ],
      },
    })

    expect(wrapper.findAll('[data-testid="chat-turn"]')).toHaveLength(0)
    expect(wrapper.find('[data-testid="thread-divider"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="compaction-divider"]').text()).toContain('上下文已压缩')
  })

  it('renders a compaction divider inside a mixed turn', () => {
    const wrapper = mount(ChatThread, {
      props: {
        turns: [
          makeTurn({
            id: 'mixed',
            steps: [thinking(), compaction('压缩摘要正文'), makeTool('read')],
          }),
        ],
      },
    })

    expect(wrapper.findAll('[data-testid="thread-divider"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="user-message"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="assistant-message"]').exists()).toBe(true)
  })

  it('renders nothing for an empty reply without user content', () => {
    const wrapper = mount(ChatThread, {
      props: {
        turns: [makeTurn({ id: 't1', userText: '', steps: [], reply: '' })],
      },
    })

    expect(wrapper.find('[data-testid="assistant-message"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="assistant-empty"]').exists()).toBe(false)
  })

  it('renders no empty note for consecutive user messages', () => {
    const wrapper = mount(ChatThread, {
      props: {
        turns: [
          makeTurn({ id: 'u1', userText: '第一问', steps: [], reply: '' }),
          makeTurn({ id: 'u2', userText: '第二问', steps: [], reply: '' }),
        ],
      },
    })

    expect(wrapper.findAll('[data-testid="user-message"]')).toHaveLength(2)
    expect(wrapper.findAll('[data-testid="assistant-message"]')).toHaveLength(0)
    expect(wrapper.findAll('[data-testid="assistant-empty"]')).toHaveLength(0)
  })

  it('renders no empty note for a live empty turn', () => {
    const wrapper = mount(ChatThread, {
      props: { turns: [makeTurn({ id: 't3', steps: [], reply: '', live: true })] },
    })

    expect(wrapper.find('[data-testid="assistant-message"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="assistant-empty"]').exists()).toBe(false)
  })
})
