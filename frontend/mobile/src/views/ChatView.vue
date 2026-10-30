<template>
  <AppShell
    class="ax-chat-page"
    title="对话"
    meta="小贺 · 知己"
    :inspector-open="contextInspectorOpen"
    @update:inspector-open="contextInspectorOpen = $event"
  >
    <template #actions>
      <template v-if="isMobile">
        <button
          class="ax-chat__action"
          type="button"
          data-testid="token-trigger"
          aria-label="上下文与用量"
          title="上下文与用量"
          @click="contextInspectorOpen = true"
        >
          <AppIcon name="Hash" :size="16" />
          <span v-if="totalTokens > 0" class="ax-chat__token">{{ tokenLabel }}</span>
        </button>

        <button
          class="ax-chat__action"
          type="button"
          data-testid="context-trigger"
          aria-label="子智能体与上下文"
          title="子智能体与上下文"
          @click="contextInspectorOpen = true"
        >
          <AppIcon name="Users" :size="16" />
        </button>
      </template>
    </template>

    <div class="ax-chat" data-testid="chat-page">
      <div ref="scrollRef" class="ax-chat__scroll" @scroll="handleScroll">
        <div v-if="isSubAgentMode" class="ax-chat__backrow">
          <button
            class="ax-chat__back"
            type="button"
            data-testid="chat-back"
            @click="handleBackToParent"
          >
            <AppIcon name="CaretLeft" :size="14" />
            <span>返回 {{ parentSessionTitle }} 会话</span>
          </button>
        </div>

        <div v-if="showDemo" class="ax-chat__demo" role="status">
          <AppIcon name="Info" :size="14" />
          <span>演示模式：以下为测试对话，登录后可查看真实消息</span>
        </div>

        <div
          v-if="pageState?.state === 'loading'"
          class="ax-chat__state ax-list"
          aria-busy="true"
          aria-label="正在加载聊天记录"
        >
          <div v-for="index in 5" :key="index" class="ax-skeleton">
            <span class="skeleton ax-skeleton__line" />
            <span class="skeleton ax-skeleton__line ax-skeleton__line--short" />
          </div>
        </div>

        <div
          v-else-if="pageState?.state === 'error'"
          class="ax-chat__state ax-state"
          role="alert"
        >
          <h2 class="ax-state__title">{{ pageState.title }}</h2>
          <p class="ax-state__body">{{ pageState.body }}</p>
          <button class="ax-state__action" type="button" @click="handleRetry">
            重试
          </button>
        </div>

        <div
          v-else-if="pageState?.state === 'empty'"
          class="ax-chat__state ax-state"
        >
          <h2 class="ax-state__title">{{ pageState.title }}</h2>
          <p class="ax-state__body">{{ pageState.body }}</p>
        </div>

        <template v-else>
          <div
            ref="sentinelRef"
            class="ax-chat__sentinel"
            data-testid="history-sentinel"
          >
            <div class="ax-chat__sentinel-status" role="status">
              <span v-if="loadingMoreHistory">正在加载更早的消息…</span>
            </div>
          </div>

          <ChatThread :turns="turns" @open-focus="handleOpenFocus" />
        </template>
      </div>

      <Composer @send="handleSend" />
    </div>

    <template #inspector>
      <ContextInspector
        v-if="!isMobile"
        embedded
        :visible="true"
      />
    </template>

    <ContextInspector
      v-if="isMobile"
      :visible="contextInspectorOpen"
      @close="contextInspectorOpen = false"
    />

    <FocusDrawer
      :visible="focusPayload !== null"
      :title="focusPayload?.title"
      :content="focusPayload?.content"
      :bytes="focusPayload?.bytes"
      :truncated="focusPayload?.truncated"
      @close="focusPayload = null"
    />
  </AppShell>
</template>

<script setup lang="ts">
import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  ref,
  watch,
} from 'vue'
import AppShell from '@/components/shell/AppShell.vue'
import AppIcon from '@/components/common/AppIcon.vue'
import ChatThread from '@/components/chat/ChatThread.vue'
import Composer from '@/components/chat/Composer.vue'
import ContextInspector from '@/components/chat/ContextInspector.vue'
import FocusDrawer from '@/components/chat/FocusDrawer.vue'
import { useChatSingleton } from '@/composables/useChat'
import { useStreamingMessageSingleton } from '@/composables/useStreamingMessage'
import { useSubAgentsSingleton } from '@/composables/useSubAgents'
import { useChatScroll } from '@/composables/useChatScroll'
import { useTurnViews } from '@/composables/useTurnViews'
import { useApi } from '@/composables/useApi'
import { useMediaQuery } from '@/composables/useMediaQuery'
import { USE_MOCK_DATA } from '@/composables/useMockData'
import { DEMO_MESSAGES } from '@/data/demoMessages'
import { formatTokenDisplay } from '@/utils/format'
import type { ChatMessage } from '@/types'
import type { ToolFocusPayload } from '@/utils/toolDisplay'

interface ChatPageState {
  state: 'loading' | 'error' | 'empty'
  title: string
  body: string
}

const chat = useChatSingleton()
const streaming = useStreamingMessageSingleton()
const subAgents = useSubAgentsSingleton()
const { isLoggedIn } = useApi()
const isMobile = useMediaQuery('(max-width: 767.98px)')

const isDemoMode = computed(() => !isLoggedIn.value)
const showDemo = computed(() => isDemoMode.value || USE_MOCK_DATA)

const displayMessages = computed<ChatMessage[]>(() =>
  showDemo.value ? DEMO_MESSAGES : chat.messages.value,
)
const turns = useTurnViews(displayMessages)

const isSubAgentMode = computed(() => subAgents.isChildMode.value)
const parentSessionTitle = computed(() => subAgents.parentSessionTitle.value)
const totalTokens = computed(() => streaming.currentTokens.value?.total ?? 0)
const tokenLabel = computed(() => formatTokenDisplay(totalTokens.value))

const loadingMessages = computed(() => chat.loadingMessages.value)
const loadingMoreHistory = computed(() => chat.loadingMoreMessages.value)

const streamingContentLength = computed<number>(() => {
  const list = displayMessages.value
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index]
    if (message?.isStreaming !== true) continue
    let length = 0
    for (const part of message.parts ?? []) {
      length += (part.text?.length ?? 0) + (part.state?.output?.length ?? 0)
    }
    return length
  }
  return 0
})

const { scrollRef, onScroll, scrollToBottom, prepend } = useChatScroll({
  messages: chat.messages,
  sessionId: chat.currentSessionId,
  isStreaming: streaming.isStreaming,
  contentLength: streamingContentLength,
})

const HISTORY_NEAR_TOP_PX = 240
const HISTORY_CHAIN_LIMIT = 8
const HISTORY_FALLBACK_TOP_PX = 80

const sentinelRef = ref<HTMLElement | null>(null)
let historyObserver: IntersectionObserver | null = null
let historyObserverArmed = false
let initialLoadDone = false
let historyLoadInFlight = false

function canAutoLoadHistory(): boolean {
  return (
    historyObserverArmed &&
    !showDemo.value &&
    Boolean(chat.currentSessionId.value) &&
    chat.hasMoreHistory.value &&
    !loadingMessages.value &&
    !loadingMoreHistory.value &&
    !historyLoadInFlight
  )
}

function isSentinelNearTop(): boolean {
  const root = scrollRef.value
  const sentinel = sentinelRef.value
  if (!root || !sentinel) return false
  const offset =
    sentinel.getBoundingClientRect().top - root.getBoundingClientRect().top
  return (
    offset >= -HISTORY_NEAR_TOP_PX && offset <= HISTORY_NEAR_TOP_PX
  )
}

async function loadEarlierHistory(): Promise<void> {
  for (let page = 0; page < HISTORY_CHAIN_LIMIT; page += 1) {
    if (!canAutoLoadHistory()) return
    historyLoadInFlight = true
    const previousCount = chat.messages.value.length
    let grew = false
    try {
      await prepend(() => chat.loadMoreHistory())
      await nextTick()
      grew = chat.messages.value.length > previousCount
    } catch (error) {
      console.warn('[ChatView] 自动加载更早历史失败:', error)
      return
    } finally {
      historyLoadInFlight = false
    }
    if (!grew || !isSentinelNearTop()) return
  }
}

function handleHistoryIntersection(
  entries: IntersectionObserverEntry[],
): void {
  const entry = entries[entries.length - 1]
  if (!entry?.isIntersecting) return
  void loadEarlierHistory()
}

function handleScroll(): void {
  onScroll()
  const root = scrollRef.value
  if (
    historyObserverArmed &&
    historyObserver === null &&
    root !== null &&
    root.scrollTop <= HISTORY_FALLBACK_TOP_PX
  ) {
    void loadEarlierHistory()
  }
}

function disconnectHistoryObserver(): void {
  historyObserver?.disconnect()
  historyObserver = null
  historyObserverArmed = false
}

async function armHistoryObserver(): Promise<void> {
  if (!initialLoadDone || historyObserverArmed) return
  await nextTick()
  await nextTick()
  if (!initialLoadDone || historyObserverArmed) return
  const root = scrollRef.value
  const target = sentinelRef.value
  if (!root || !target) return
  historyObserverArmed = true
  if (typeof IntersectionObserver === 'undefined') return
  historyObserver = new IntersectionObserver(handleHistoryIntersection, {
    root,
    rootMargin: `${HISTORY_NEAR_TOP_PX}px 0px 0px 0px`,
    threshold: 0,
  })
  historyObserver.observe(target)
}

const contextInspectorOpen = ref(false)
const focusPayload = ref<ToolFocusPayload | null>(null)
const loadError = ref('')

const pageState = computed<ChatPageState | null>(() => {
  if (showDemo.value) return null
  if (loadError.value) {
    return { state: 'error', title: '加载失败', body: loadError.value }
  }
  if (loadingMessages.value) {
    return { state: 'loading', title: '正在加载', body: '正在加载聊天记录' }
  }
  if (!chat.currentSessionId.value) {
    return {
      state: 'empty',
      title: '暂无会话',
      body: '新建一个会话，或直接发送消息自动创建。',
    }
  }
  if (chat.messages.value.length === 0 && !streaming.isStreaming.value) {
    return { state: 'empty', title: '暂无消息', body: '发送一条消息开始对话。' }
  }
  return null
})

async function loadInitial(): Promise<void> {
  disconnectHistoryObserver()
  initialLoadDone = false
  loadError.value = ''
  try {
    await chat.loadSessions()
    if (chat.currentSessionId.value) {
      await chat.loadChatHistory(chat.currentSessionId.value)
    }
    scrollToBottom(false)
    initialLoadDone = true
    await armHistoryObserver()
  } catch {
    loadError.value = '无法加载会话，请检查连接后重试。'
  }
}

async function handleRetry(): Promise<void> {
  await loadInitial()
}

async function handleSend(text: string, files: File[]): Promise<void> {
  if (showDemo.value) return
  await chat.sendMessage(text, files)
}

async function handleBackToParent(): Promise<void> {
  await subAgents.returnToParent()
}

function handleOpenFocus(payload: ToolFocusPayload): void {
  focusPayload.value = payload
}

onMounted(async () => {
  chat.initStreaming()

  if (showDemo.value) {
    await nextTick()
    scrollToBottom(false)
    return
  }

  await loadInitial()
})

watch(isLoggedIn, (loggedIn) => {
  if (loggedIn && !USE_MOCK_DATA) {
    void loadInitial()
  }
})

watch(sentinelRef, (element) => {
  if (element && initialLoadDone && !historyObserverArmed) {
    void armHistoryObserver()
  }
})

onActivated(() => {
  void armHistoryObserver()
})

onDeactivated(() => {
  disconnectHistoryObserver()
})

onBeforeUnmount(() => {
  disconnectHistoryObserver()
})
</script>

<style scoped>
.ax-chat-page :deep(.ax-page-header__title) {
  flex: none;
}

.ax-chat {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-block-size: 0;
  min-inline-size: 0;
  background: var(--bg);
}

.ax-chat__scroll {
  flex: 1 1 auto;
  min-block-size: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.ax-chat__backrow,
.ax-chat__demo,
.ax-chat__state,
.ax-chat__sentinel {
  inline-size: 100%;
  max-inline-size: var(--chat-column);
  margin-inline: auto;
  padding-inline: var(--space-4);
}

.ax-chat__backrow {
  padding-block-start: var(--space-3);
}

.ax-chat__back {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-block-size: var(--tap);
  color: var(--muted);
  font-size: 13px;
}

.ax-chat__back:hover {
  color: var(--ink);
}

.ax-chat__demo {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-block-start: var(--space-3);
  padding-block: var(--space-2);
  border-block-end: 1px solid var(--hairline);
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.5;
}

.ax-chat__state {
  padding-block: var(--space-6);
}

.ax-chat__sentinel-status {
  display: flex;
  align-items: center;
  justify-content: center;
  block-size: 32px;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.4;
}

/* ==================== Header actions ==================== */

.ax-chat__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-inline-size: var(--tap);
  min-block-size: var(--tap);
  border-radius: var(--radius-sm);
  color: var(--muted);
}

.ax-chat__action:hover {
  background: var(--inset);
  color: var(--ink);
}

.ax-chat__token {
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.ax-chat__action:focus-visible,
.ax-chat__back:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@media (max-width: 767.98px) {
  .ax-chat__backrow,
  .ax-chat__demo,
  .ax-chat__state,
  .ax-chat__sentinel {
    padding-inline: var(--space-3);
  }
}

@media (max-width: 420px) {
  .ax-chat__token {
    display: none;
  }
}
</style>
