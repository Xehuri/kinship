import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { ChatMessage, SessionInfo, TokenUsage } from '@/types'
import type { SubAgentInfo } from '@/composables/useSubAgents'

const observerInstances: MockIntersectionObserver[] = []

class MockIntersectionObserver {
  readonly options: IntersectionObserverInit | undefined
  readonly observed: Element[] = []
  readonly disconnect = vi.fn()
  readonly unobserve = vi.fn()
  private readonly callback: IntersectionObserverCallback

  constructor(
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.callback = callback
    this.options = options
    observerInstances.push(this)
  }

  observe(target: Element): void {
    this.observed.push(target)
  }

  takeRecords(): IntersectionObserverEntry[] {
    return []
  }

  fire(isIntersecting: boolean): void {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
}

const mocks = vi.hoisted(() => ({
  chat: {} as any,
  streaming: {} as any,
  subAgents: {} as any,
  api: {} as any,
  notificationsOpen: vi.fn(),
  push: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/chat', meta: {} }),
  useRouter: () => ({ push: mocks.push }),
}))

vi.mock('@/composables/useChat', async () => {
  const { computed, ref } = await import('vue')
  const messages = ref<ChatMessage[]>([])
  const currentSessionId = ref('s1')
  const sessions = ref<SessionInfo[]>([
    { id: 's1', title: 'Loom 会话', date: '今天', preview: '', backend: 'loom' },
    { id: 's2', title: 'OpenCode 会话', date: '昨天', preview: '', backend: 'opencode' },
  ])
  const nextCursor = ref<string | null>(null)
  const loadingMessages = ref(false)

  const chat = {
    sessions,
    currentSessionId,
    messages,
    nextCursor,
    loadingMessages,
    currentSessionTitle: computed(
      () => sessions.value.find((session) => session.id === currentSessionId.value)?.title || '',
    ),
    sendingMessage: ref(false),
    loadingMoreMessages: ref(false),
    hasMoreHistory: computed(() => nextCursor.value !== null),
    loadSessions: vi.fn(async () => {}),
    switchSession: vi.fn(async () => {}),
    createNewSession: vi.fn(async () => 'new-session'),
    loadChatHistory: vi.fn(async () => {}),
    loadMoreHistory: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => true),
    clearMessages: vi.fn(),
    renameSession: vi.fn(async () => true),
    compactSession: vi.fn(async () => ({ ok: true })),
    initStreaming: vi.fn(),
  }

  mocks.chat = chat
  return { useChatSingleton: () => chat }
})

vi.mock('@/composables/useStreamingMessage', async () => {
  const { ref } = await import('vue')
  const isStreaming = ref(false)
  const currentTokens = ref<TokenUsage | null>(null)
  const streaming = { isStreaming, currentTokens }
  mocks.streaming = streaming
  return { useStreamingMessageSingleton: () => streaming }
})

vi.mock('@/composables/useApi', async () => {
  const { ref } = await import('vue')
  const isLoggedIn = ref(true)
  const api = { isLoggedIn }
  mocks.api = api
  return { useApi: () => api }
})

vi.mock('@/composables/useSubAgents', async () => {
  const { ref } = await import('vue')
  const subAgents = ref<SubAgentInfo[]>([])
  const isChildMode = ref(false)
  const parentSessionTitle = ref('主会话')
  const loading = ref(false)
  const state = {
    subAgents,
    isChildMode,
    parentSessionTitle,
    parentChain: ref([]),
    showList: ref(false),
    loading,
    loadSubAgents: vi.fn(async () => {}),
    enterSubAgent: vi.fn(async () => {}),
    returnToParent: vi.fn(async () => {}),
    scanFromMessages: vi.fn(() => []),
  }
  mocks.subAgents = state
  return { useSubAgentsSingleton: () => state }
})

vi.mock('@/composables/useNotifications', () => ({
  useNotificationsSingleton: () => ({ open: mocks.notificationsOpen }),
}))

vi.mock('@/composables/useMockData', () => ({ USE_MOCK_DATA: false }))

import ChatView from '@/views/ChatView.vue'

function userMessage(id: string, content: string): ChatMessage {
  return { id, role: 'user', content, timestamp: '2026-10-24T10:00:00.000Z' }
}

function assistantWithTool(id: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    info: { id, role: 'assistant' },
    parts: [
      { type: 'reasoning', text: '先核对健康数据' },
      {
        type: 'tool',
        callID: 'call-1',
        tool: 'read',
        state: {
          status: 'completed',
          input: { filePath: 'health.json' },
          output: 'tool output content',
        },
      },
      { type: 'text', text: '今天状态不错。' },
    ],
    timestamp: '2026-10-24T10:00:01.000Z',
  }
}

function assistantWithLongResult(id: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    info: { id, role: 'assistant' },
    parts: [
      {
        type: 'tool',
        callID: 'call-long',
        tool: 'read',
        state: {
          status: 'completed',
          input: { filePath: 'long.log' },
          output: `FULL-OUTPUT ${'x'.repeat(1300)}`,
        },
      },
      { type: 'text', text: '读取完成。' },
    ],
    timestamp: '2026-10-24T10:00:01.000Z',
  }
}

const mounted: Array<ReturnType<typeof mount>> = []

function mountChat() {
  const wrapper = mount(ChatView, {
    attachTo: document.body,
    global: { stubs: { teleport: true } },
  })
  mounted.push(wrapper)
  return wrapper
}

async function settleInitialLoad(): Promise<void> {
  await flushPromises()
  await nextTick()
  await nextTick()
}

function requireObserver(index = 0): MockIntersectionObserver {
  const observer = observerInstances[index]
  if (!observer) throw new Error('IntersectionObserver was not installed')
  return observer
}

function setViewportMobile(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  observerInstances.length = 0
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
  setViewportMobile(false)
  mocks.api.isLoggedIn.value = true
  mocks.streaming.isStreaming.value = false
  mocks.streaming.currentTokens.value = null
  mocks.chat.messages.value = []
  mocks.chat.currentSessionId.value = 's1'
  mocks.chat.nextCursor.value = null
  mocks.chat.loadingMessages.value = false
  mocks.chat.loadingMoreMessages.value = false
  mocks.chat.loadMoreHistory.mockImplementation(async () => {
    mocks.chat.messages.value = [
      userMessage('u-earlier', '更早的一条'),
      ...mocks.chat.messages.value,
    ]
    mocks.chat.nextCursor.value = null
  })
  mocks.subAgents.isChildMode.value = false
  mocks.subAgents.subAgents.value = []
})

afterEach(() => {
  while (mounted.length > 0) {
    mounted.pop()?.unmount()
  }
  vi.unstubAllGlobals()
  document.documentElement.classList.remove('chat-overlay-lock')
})

describe('ChatView', () => {
  it('renders the v2 shell header and feeds real messages through ChatThread', async () => {
    mocks.chat.messages.value = [
      userMessage('u1', '看看今天的状态'),
      assistantWithTool('a1'),
    ]

    const wrapper = mountChat()
    await flushPromises()

    expect(wrapper.get('.ax-page-header__title').text()).toBe('对话')
    expect(wrapper.get('.ax-page-header__meta').text()).toBe('小贺 · 知己')
    expect(wrapper.find('[data-testid="chat-page"]').exists()).toBe(true)
    expect(wrapper.findAll('.ax-chat__action')).toHaveLength(0)
    expect(wrapper.find('[data-testid="session-trigger"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="compaction-jump"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="chat-files"]').exists()).toBe(false)

    expect(wrapper.get('[data-testid="user-message"]').text()).toContain('看看今天的状态')
    expect(wrapper.get('[data-testid="assistant-message"]').text()).toContain('今天状态不错。')
    expect(wrapper.find('[data-testid="process-disclosure"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="tool-row"]').attributes('data-tool')).toBe('read')
  })

  it('renders the embedded inspector in the AppShell slot on desktop', async () => {
    const wrapper = mountChat()
    await flushPromises()

    const slot = wrapper.get('[data-testid="inspector-slot"]')
    const inspector = slot.get('[data-testid="context-inspector"]')

    expect(inspector.exists()).toBe(true)
    expect(inspector.get('[role="region"]').attributes('aria-label')).toBe('上下文')
    expect(inspector.find('.ax-inspector__close').exists()).toBe(false)
    expect(wrapper.find('[data-testid="token-trigger"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="context-trigger"]').exists()).toBe(false)
    expect(mocks.subAgents.loadSubAgents).toHaveBeenCalled()
  })

  it('shows demo messages and skips session loading when logged out', async () => {
    mocks.api.isLoggedIn.value = false

    const wrapper = mountChat()
    await flushPromises()

    expect(wrapper.text()).toContain('演示模式：以下为测试对话')
    expect(wrapper.findAll('[data-testid="chat-turn"]').length).toBeGreaterThan(0)
    expect(mocks.chat.loadSessions).not.toHaveBeenCalled()
  })

  it('shows an empty state with new-conversation guidance', async () => {
    mocks.chat.currentSessionId.value = ''
    const wrapper = mountChat()
    await flushPromises()

    expect(wrapper.get('.ax-state__title').text()).toBe('暂无会话')
    expect(wrapper.find('[data-testid="chat-thread"]').exists()).toBe(false)
  })

  it('removes the manual load-more control and keeps the sentinel above the thread', async () => {
    mocks.chat.nextCursor.value = 'cursor-1'
    mocks.chat.messages.value = [userMessage('u1', '最近一条')]

    const wrapper = mountChat()
    await settleInitialLoad()

    expect(wrapper.find('[data-testid="load-more"]').exists()).toBe(false)
    expect(wrapper.find('.ax-chat__more').exists()).toBe(false)

    const scroll = wrapper.get('.ax-chat__scroll').element
    const sentinel = wrapper.get('[data-testid="history-sentinel"]').element
    const thread = wrapper.get('[data-testid="chat-thread"]').element

    expect(scroll.contains(sentinel)).toBe(true)
    expect(scroll.contains(thread)).toBe(true)
    expect(
      sentinel.compareDocumentPosition(thread) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('does not auto-load before the initial load has settled and the observer is armed', async () => {
    mocks.chat.nextCursor.value = 'cursor-1'
    mocks.chat.messages.value = [userMessage('u1', '最近一条')]

    const wrapper = mountChat()

    expect(observerInstances).toHaveLength(0)
    await wrapper.get('.ax-chat__scroll').trigger('scroll')
    expect(mocks.chat.loadMoreHistory).not.toHaveBeenCalled()

    await settleInitialLoad()

    expect(observerInstances).toHaveLength(1)
    expect(mocks.chat.loadMoreHistory).not.toHaveBeenCalled()
  })

  it('loads exactly one earlier page when the top sentinel intersects', async () => {
    mocks.chat.nextCursor.value = 'cursor-1'
    mocks.chat.messages.value = [userMessage('u1', '最近一条')]

    const wrapper = mountChat()
    await settleInitialLoad()

    expect(observerInstances).toHaveLength(1)
    const observer = requireObserver()
    expect(observer.options?.root).toBe(wrapper.get('.ax-chat__scroll').element)
    expect(observer.options?.rootMargin).toBe('240px 0px 0px 0px')
    expect(mocks.chat.loadMoreHistory).not.toHaveBeenCalled()

    observer.fire(true)
    await flushPromises()

    expect(mocks.chat.loadMoreHistory).toHaveBeenCalledTimes(1)
  })

  it('does not auto-load when the history cursor is exhausted', async () => {
    mocks.chat.nextCursor.value = null
    mocks.chat.messages.value = [userMessage('u1', '最近一条')]

    const wrapper = mountChat()
    await settleInitialLoad()

    requireObserver().fire(true)
    await flushPromises()
    expect(mocks.chat.loadMoreHistory).not.toHaveBeenCalled()
  })

  it('never auto-loads history in demo mode', async () => {
    mocks.api.isLoggedIn.value = false

    const wrapper = mountChat()
    await settleInitialLoad()

    expect(observerInstances).toHaveLength(0)
    await wrapper.get('.ax-chat__scroll').trigger('scroll')
    await flushPromises()

    expect(mocks.chat.loadMoreHistory).not.toHaveBeenCalled()
  })

  it('falls back to the scroll trigger when IntersectionObserver is unavailable', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    mocks.chat.nextCursor.value = 'cursor-1'
    mocks.chat.messages.value = [userMessage('u1', '最近一条')]

    const wrapper = mountChat()
    await settleInitialLoad()

    expect(observerInstances).toHaveLength(0)
    expect(mocks.chat.loadMoreHistory).not.toHaveBeenCalled()

    const scroll = wrapper.get('.ax-chat__scroll')
    ;(scroll.element as HTMLElement).scrollTop = 0
    await scroll.trigger('scroll')
    await flushPromises()

    expect(mocks.chat.loadMoreHistory).toHaveBeenCalledTimes(1)
  })

  it('reserves a fixed status row and fills it only while a page is loading', async () => {
    mocks.chat.nextCursor.value = 'cursor-1'
    mocks.chat.messages.value = [userMessage('u1', '最近一条')]

    const wrapper = mountChat()
    await settleInitialLoad()

    const status = wrapper.get('.ax-chat__sentinel-status')
    expect(status.attributes('role')).toBe('status')
    expect(status.text()).toBe('')

    mocks.chat.loadingMoreMessages.value = true
    await nextTick()

    expect(status.text()).toBe('正在加载更早的消息…')
  })

  it('sends composer input through the real chat pipeline', async () => {
    const wrapper = mountChat()
    await flushPromises()
    const input = wrapper.get('[data-testid="composer-input"]')

    await input.setValue('帮我看看睡眠')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(mocks.chat.sendMessage).toHaveBeenCalledWith('帮我看看睡眠', [])
  })

  it('opens a focus drawer from a truncated tool result', async () => {
    mocks.chat.messages.value = [userMessage('u1', '读日志'), assistantWithLongResult('a1')]
    const wrapper = mountChat()
    await flushPromises()

    await wrapper.get('[data-testid="tool-row"] button').trigger('click')
    await wrapper.get('[data-testid="tool-result-card__focus"]').trigger('click')
    await flushPromises()

    const drawer = wrapper.get('[data-testid="focus-drawer"]')
    expect(drawer.text()).toContain('read 输出')
    expect(drawer.text()).toContain('FULL-OUTPUT')
  })

  it('renders the global notifications bell through AppShell', async () => {
    const wrapper = mountChat()
    await flushPromises()

    await wrapper.get('[data-testid="notifications-trigger"]').trigger('click')

    expect(mocks.notificationsOpen).toHaveBeenCalledTimes(1)
  })

  it('keeps token and context triggers on mobile and opens the inspector', async () => {
    setViewportMobile(true)
    const wrapper = mountChat()
    await flushPromises()

    expect(wrapper.get('[data-testid="token-trigger"]').isVisible()).toBe(true)
    expect(wrapper.get('[data-testid="context-trigger"]').isVisible()).toBe(true)
    expect(wrapper.find('[data-testid="session-trigger"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="inspector-trigger"]').exists()).toBe(false)
    expect(
      wrapper.find('[data-testid="inspector-slot"] [data-testid="context-inspector"]').exists(),
    ).toBe(false)
    expect(wrapper.find('[data-testid="context-inspector"]').exists()).toBe(false)

    await wrapper.get('[data-testid="token-trigger"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="inspector-slot"] [data-testid="context-inspector"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="context-inspector"]').exists()).toBe(true)
  })
})
