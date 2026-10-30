import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { SubAgentInfo } from '@/composables/useSubAgents'

const mocks = vi.hoisted(() => ({
  chat: {} as Record<string, unknown>,
  streaming: {} as Record<string, unknown>,
  subAgents: {} as Record<string, unknown>,
}))

const mockFetchContextWindow = vi.hoisted(() => vi.fn())

vi.mock('@/api/model', () => ({
  fetchContextWindow: mockFetchContextWindow,
}))

vi.mock('@/composables/useChat', async () => {
  const { computed, ref } = await import('vue')
  const chat = {
    currentSessionId: ref('s1'),
    currentSessionTitle: computed(() => 'Loom 会话'),
    messages: ref([]),
    compactSession: vi.fn(async () => ({ ok: true })),
  }
  mocks.chat = chat
  return { useChatSingleton: () => chat }
})

vi.mock('@/composables/useStreamingMessage', async () => {
  const { ref } = await import('vue')
  const streaming = {
    currentTokens: ref({
      total: 1200,
      input: 700,
      output: 500,
      reasoning: 100,
      cache: { read: 200, write: 50 },
    }),
  }
  mocks.streaming = streaming
  return { useStreamingMessageSingleton: () => streaming }
})

vi.mock('@/composables/useSubAgents', async () => {
  const { ref } = await import('vue')
  const subAgents = {
    subAgents: ref<SubAgentInfo[]>([
      {
        id: 'agent-1',
        name: '审查聊天实现',
        type: 'explore',
        childSessionId: 'child-1',
        status: 'completed',
        messageIndex: 1,
      },
    ]),
    isChildMode: ref(false),
    parentSessionTitle: ref('主会话'),
    loading: ref(false),
    loadSubAgents: vi.fn(async () => {}),
    enterSubAgent: vi.fn(async () => {}),
    returnToParent: vi.fn(async () => {}),
  }
  mocks.subAgents = subAgents
  return { useSubAgentsSingleton: () => subAgents }
})

import ContextInspector from '@/components/chat/ContextInspector.vue'

const mounted: Array<ReturnType<typeof mount>> = []

function mountInspector(props: Record<string, unknown> = {}) {
  const wrapper = mount(ContextInspector, {
    attachTo: document.body,
    props: { visible: true, ...props },
    global: { stubs: { teleport: true } },
  })
  mounted.push(wrapper)
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(mocks.chat.currentSessionId as { value: string }).value = 's1'
  ;(mocks.subAgents.isChildMode as { value: boolean }).value = false
  ;(mocks.streaming.currentTokens as { value: unknown }).value = {
    total: 1200,
    input: 700,
    output: 500,
    reasoning: 100,
    cache: { read: 200, write: 50 },
  }
  mockFetchContextWindow.mockReset()
  mockFetchContextWindow.mockResolvedValue({
    model: 'deepseek-flash',
    provider: 'xehuri-api',
    contextWindow: 1_000_000,
  })
})

afterEach(() => {
  while (mounted.length > 0) {
    mounted.pop()?.unmount()
  }
  document.documentElement.classList.remove('chat-overlay-lock')
})

describe('ContextInspector', () => {
  it('renders every token row and loads subagents when opened', async () => {
    const wrapper = mountInspector()
    await flushPromises()

    const rows = wrapper.findAll('.ax-inspector__row').map((row) => ({
      label: row.get('.ax-inspector__row-label').text(),
      value: row.get('.ax-inspector__row-value').text(),
    }))

    expect(rows).toEqual([
      { label: '总计', value: '1,200' },
      { label: '输入', value: '700' },
      { label: '输出', value: '500' },
      { label: '推理', value: '100' },
      { label: '缓存(读)', value: '200' },
      { label: '缓存(写)', value: '50' },
    ])
    expect(mocks.subAgents.loadSubAgents).toHaveBeenCalledWith('s1', expect.any(Array))
  })

  it('renders the usage head and meter when the context window is known', async () => {
    ;(mocks.streaming.currentTokens as { value: unknown }).value = {
      total: 70_501,
      input: 70_000,
      output: 501,
    }
    const wrapper = mountInspector()
    await flushPromises()

    const usage = wrapper.get('[data-testid="context-usage"]')
    expect(usage.text()).toContain('7.1%')
    expect(usage.text()).toContain('70,501 / 1,000,000')

    const bar = wrapper.get('[role="progressbar"]')
    expect(bar.attributes('aria-valuemax')).toBe('1000000')
    expect(bar.attributes('aria-valuenow')).toBe('70501')
  })

  it('shows an em dash and unknown hint without a progressbar when the window is null', async () => {
    mockFetchContextWindow.mockResolvedValue({
      model: 'deepseek-flash',
      provider: 'xehuri-api',
      contextWindow: null,
    })
    const wrapper = mountInspector()
    await flushPromises()

    const usage = wrapper.get('[data-testid="context-usage"]')
    expect(usage.text()).toContain('1,200 / —')
    expect(wrapper.get('[data-testid="context-window-unknown"]').text()).toBe('上下文窗口大小未知')
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
  })

  it('does not request a context window without an active session', async () => {
    ;(mocks.chat.currentSessionId as { value: string }).value = ''
    mountInspector()
    await flushPromises()

    expect(mockFetchContextWindow).not.toHaveBeenCalled()
  })

  it('refreshes the context window when the session changes', async () => {
    mountInspector({ embedded: true })
    await flushPromises()
    expect(mockFetchContextWindow).toHaveBeenCalledTimes(1)

    ;(mocks.chat.currentSessionId as { value: string }).value = 's2'
    await flushPromises()

    expect(mockFetchContextWindow).toHaveBeenCalledTimes(2)
  })

  it('keeps the subagent list as the only scroll region in the markup', async () => {
    const wrapper = mountInspector()
    await flushPromises()

    expect(wrapper.get('.ax-inspector__body').exists()).toBe(true)
    expect(wrapper.get('.ax-inspector__section--usage').exists()).toBe(true)
    const section = wrapper.get('.ax-inspector__section--subagents')
    const list = wrapper.get('[data-testid="subagent-list"]')

    expect(list.element.tagName).toBe('UL')
    expect(list.classes()).toContain('ax-inspector__agents')
    expect(section.find('[data-testid="subagent-list"]').exists()).toBe(true)
  })

  it('renders the compact action inside the usage section header', async () => {
    const wrapper = mountInspector()
    await flushPromises()

    const head = wrapper.get('.ax-inspector__section--usage .ax-inspector__section-head')
    const action = head.get('[data-testid="compact-action"]')

    expect(head.text()).toContain('用量')
    expect(action.attributes('aria-label')).toBe('压缩会话')
    expect(action.text()).toContain('压缩')
    expect(wrapper.find('.ax-inspector__action').exists()).toBe(false)
  })

  it('opens the confirmation dialog without compacting', async () => {
    const wrapper = mountInspector()
    await flushPromises()

    await wrapper.get('[data-testid="compact-action"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="confirm-dialog"]').exists()).toBe(true)
    expect(wrapper.get('.ax-confirm__message').text()).toContain('原始历史仍完整保留')
    expect(mocks.chat.compactSession).not.toHaveBeenCalled()
  })

  it('cancels the confirmation dialog without compacting', async () => {
    const wrapper = mountInspector()
    await flushPromises()

    await wrapper.get('[data-testid="compact-action"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="confirm-dialog-cancel"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(false)
    expect(mocks.chat.compactSession).not.toHaveBeenCalled()
  })

  it('compacts exactly once after confirmation and closes the dialog', async () => {
    const wrapper = mountInspector()
    await flushPromises()

    await wrapper.get('[data-testid="compact-action"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="confirm-dialog-confirm"]').trigger('click')
    await flushPromises()

    expect(mocks.chat.compactSession).toHaveBeenCalledTimes(1)
    expect(mocks.chat.compactSession).toHaveBeenCalledWith('s1')
    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(false)
  })

  it('cancels the dialog on Escape without closing the inspector', async () => {
    const wrapper = mountInspector()
    await flushPromises()

    await wrapper.get('[data-testid="compact-action"]').trigger('click')
    await flushPromises()

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    await flushPromises()

    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(false)
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(mocks.chat.compactSession).not.toHaveBeenCalled()
  })

  it('disables the compact action without an active session', async () => {
    ;(mocks.chat.currentSessionId as { value: string }).value = ''
    const wrapper = mountInspector()
    await flushPromises()

    expect(wrapper.get('[data-testid="compact-action"]').attributes('disabled')).toBeDefined()
  })

  it('disables the compact action while compacting', async () => {
    let resolveCompact: (value: unknown) => void = () => {}
    const pending = new Promise((resolve) => {
      resolveCompact = resolve
    })
    ;(mocks.chat.compactSession as Mock).mockImplementationOnce(() => pending)

    const wrapper = mountInspector()
    await flushPromises()

    await wrapper.get('[data-testid="compact-action"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="confirm-dialog-confirm"]').trigger('click')
    await flushPromises()

    const action = wrapper.get('[data-testid="compact-action"]')
    expect(action.attributes('disabled')).toBeDefined()
    expect(action.text()).toContain('压缩中…')

    resolveCompact({ ok: true })
    await flushPromises()

    expect(wrapper.get('[data-testid="compact-action"]').attributes('disabled')).toBeUndefined()
  })

  it('closes the confirmation dialog when the session changes', async () => {
    const wrapper = mountInspector()
    await flushPromises()

    await wrapper.get('[data-testid="compact-action"]').trigger('click')
    await flushPromises()

    ;(mocks.chat.currentSessionId as { value: string }).value = 's2'
    await flushPromises()

    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(false)
    expect(mocks.chat.compactSession).not.toHaveBeenCalled()
  })

  it('closes the confirmation dialog when the inspector closes', async () => {
    const wrapper = mountInspector()
    await flushPromises()

    await wrapper.get('[data-testid="compact-action"]').trigger('click')
    await flushPromises()

    await wrapper.setProps({ visible: false })
    await flushPromises()

    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(false)
    expect(mocks.chat.compactSession).not.toHaveBeenCalled()
  })

  it('enters a real child session and closes', async () => {
    const wrapper = mountInspector()
    await flushPromises()

    await wrapper.get('[data-testid="subagent-row"]').trigger('click')
    await flushPromises()

    expect(mocks.subAgents.enterSubAgent).toHaveBeenCalledWith('child-1')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('returns to the parent session when in child mode', async () => {
    ;(mocks.subAgents.isChildMode as { value: boolean }).value = true
    const wrapper = mountInspector()
    await flushPromises()

    await wrapper.get('[data-testid="back-to-parent"]').trigger('click')
    await flushPromises()

    expect(mocks.subAgents.returnToParent).toHaveBeenCalled()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('closes on Escape and locks background scroll while open', async () => {
    const wrapper = mountInspector()
    expect(document.documentElement.classList.contains('chat-overlay-lock')).toBe(true)

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )

    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('renders embedded content inline without close, dialog, trap or scroll lock', async () => {
    const wrapper = mountInspector({ embedded: true })
    await flushPromises()

    const region = wrapper.get('[role="region"]')
    expect(region.attributes('aria-label')).toBe('上下文')
    expect(region.attributes('aria-modal')).toBeUndefined()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.find('.ax-inspector__close').exists()).toBe(false)
    expect(document.documentElement.classList.contains('chat-overlay-lock')).toBe(false)
    expect(mocks.subAgents.loadSubAgents).toHaveBeenCalledWith('s1', expect.any(Array))

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('reloads subagents when the session changes in embedded mode', async () => {
    mountInspector({ embedded: true })
    await flushPromises()

    ;(mocks.chat.currentSessionId as { value: string }).value = 's2'
    await flushPromises()

    expect(mocks.subAgents.loadSubAgents).toHaveBeenLastCalledWith('s2', expect.any(Array))
  })

  it('switches sessions in embedded mode without emitting close', async () => {
    const wrapper = mountInspector({ embedded: true })
    await flushPromises()

    await wrapper.get('[data-testid="subagent-row"]').trigger('click')
    await flushPromises()

    expect(mocks.subAgents.enterSubAgent).toHaveBeenCalledWith('child-1')
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('returns to the parent in embedded mode without emitting close', async () => {
    ;(mocks.subAgents.isChildMode as { value: boolean }).value = true
    const wrapper = mountInspector({ embedded: true })
    await flushPromises()

    await wrapper.get('[data-testid="back-to-parent"]').trigger('click')
    await flushPromises()

    expect(mocks.subAgents.returnToParent).toHaveBeenCalled()
    expect(wrapper.emitted('close')).toBeUndefined()
  })
})
