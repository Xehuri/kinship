<template>
  <Teleport to="body" :disabled="embedded">
    <Transition name="ax-inspector" :css="!embedded">
      <div
        v-if="embedded || visible"
        class="ax-inspector"
        :class="{ 'ax-inspector--embedded': embedded }"
        data-testid="context-inspector"
        @click.self="handleBackdropClick"
      >
        <section
          ref="panelRef"
          class="ax-inspector__panel"
          :class="{ 'ax-inspector__panel--embedded': embedded }"
          :role="embedded ? 'region' : 'dialog'"
          :aria-modal="embedded ? undefined : 'true'"
          :aria-labelledby="embedded ? undefined : 'context-inspector-title'"
          :aria-label="embedded ? '上下文' : undefined"
          tabindex="-1"
        >
          <header class="ax-inspector__header">
            <div class="ax-inspector__heading">
              <h2 id="context-inspector-title" class="ax-inspector__title">上下文</h2>
              <p class="ax-inspector__meta">{{ headerMeta }}</p>
            </div>
            <button
              v-if="!embedded"
              class="ax-inspector__close"
              type="button"
              aria-label="关闭上下文面板"
              @click="requestClose"
            >
              <AppIcon name="X" :size="18" />
            </button>
          </header>

          <div class="ax-inspector__body">
            <section
              class="ax-inspector__section ax-inspector__section--usage"
              aria-labelledby="context-usage-title"
            >
              <div class="ax-inspector__section-head">
                <h3 id="context-usage-title" class="ax-inspector__section-title">用量</h3>
                <button
                  class="ax-inspector__compact"
                  type="button"
                  data-testid="compact-action"
                  aria-label="压缩会话"
                  :disabled="isCompacting || !currentSessionId"
                  @click="handleCompact"
                >
                  <AppIcon name="ArrowsClockwise" :size="14" />
                  <span>{{ isCompacting ? '压缩中…' : '压缩' }}</span>
                </button>
              </div>

              <div v-if="hasTokenUsage" class="ax-inspector__usage" data-testid="context-usage">
                <span class="ax-inspector__usage-percent">{{ usagePercentLabel }}</span>
                <span class="ax-inspector__usage-amount">{{ usageAmountLabel }}</span>
              </div>
              <MeterBar
                v-if="hasTokenUsage && validMax !== null"
                class="ax-inspector__meter"
                :value="usedTokens"
                :max="validMax"
                label="上下文占用"
              />
              <p
                v-else-if="hasTokenUsage"
                class="ax-inspector__window-unknown"
                data-testid="context-window-unknown"
              >
                上下文窗口大小未知
              </p>

              <dl v-if="tokenRows.length > 0" class="ax-inspector__rows">
                <div v-for="row in tokenRows" :key="row.key" class="ax-inspector__row">
                  <dt class="ax-inspector__row-label">{{ row.label }}</dt>
                  <dd class="ax-inspector__row-value">{{ row.value.toLocaleString() }}</dd>
                </div>
              </dl>
              <p v-else class="ax-inspector__empty">当前会话还没有可用的用量数据。</p>

              <p v-if="compactError" class="ax-inspector__error" role="alert">{{ compactError }}</p>
            </section>

            <section
              class="ax-inspector__section ax-inspector__section--subagents"
              aria-labelledby="context-subagents-title"
            >
              <div class="ax-inspector__section-head">
                <h3 id="context-subagents-title" class="ax-inspector__section-title">子智能体</h3>
                <span class="ax-inspector__count">{{ subAgentList.length }}</span>
              </div>

              <button
                v-if="isChildMode"
                class="ax-inspector__back"
                type="button"
                data-testid="back-to-parent"
                @click="handleBackToParent"
              >
                <AppIcon name="CaretLeft" :size="14" />
                <span>返回 {{ parentSessionTitle }} 会话</span>
              </button>

              <div
                v-if="loading"
                class="ax-inspector__skeletons"
                aria-busy="true"
                aria-label="正在加载子智能体"
              >
                <div v-for="index in 3" :key="index" class="ax-skeleton">
                  <span class="skeleton ax-skeleton__line" />
                  <span class="skeleton ax-skeleton__line ax-skeleton__line--short" />
                </div>
              </div>

              <p v-else-if="subAgentList.length === 0" class="ax-inspector__empty">
                本轮会话还没有派生过子智能体。
              </p>

              <ul v-else class="ax-inspector__agents" data-testid="subagent-list">
                <li v-for="agent in subAgentList" :key="agent.id" class="ax-inspector__agent">
                  <button
                    class="ax-inspector__agent-button"
                    type="button"
                    data-testid="subagent-row"
                    :disabled="!agent.childSessionId"
                    @click="handleEnterSubAgent(agent)"
                  >
                    <span class="ax-inspector__agent-name">{{ agent.name }}</span>
                    <span class="ax-inspector__agent-meta">
                      <span>{{ agent.type }}</span>
                      <span>{{ agent.status }}</span>
                    </span>
                  </button>
                </li>
              </ul>
            </section>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>

  <ConfirmDialog
    :visible="compactConfirmOpen"
    title="压缩会话"
    message="确认压缩当前会话？压缩后模型侧上下文会合并为摘要，原始历史仍完整保留。"
    cancel-label="取消"
    confirm-label="确认压缩"
    @confirm="confirmCompact"
    @cancel="handleCompactCancel"
  />
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import MeterBar from '@/components/common/MeterBar.vue'
import { useChatSingleton } from '@/composables/useChat'
import { useContextWindow } from '@/composables/useContextWindow'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { useStreamingMessageSingleton } from '@/composables/useStreamingMessage'
import { useSubAgentsSingleton, type SubAgentInfo } from '@/composables/useSubAgents'

interface TokenRow {
  key: string
  label: string
  value: number
}

const props = withDefaults(
  defineProps<{
    visible: boolean
    embedded?: boolean
  }>(),
  {
    embedded: false,
  },
)

const emit = defineEmits<{
  close: []
}>()

const chat = useChatSingleton()
const streaming = useStreamingMessageSingleton()
const subAgents = useSubAgentsSingleton()

const panelRef = ref<HTMLElement | null>(null)
const trap = useFocusTrap(panelRef, {
  onEscape: () => emit('close'),
})

const currentSessionId = computed(() => chat.currentSessionId.value)
const currentSessionTitle = computed(() => chat.currentSessionTitle.value)
const subAgentList = computed(() => subAgents.subAgents.value)
const isChildMode = computed(() => subAgents.isChildMode.value)
const parentSessionTitle = computed(() => subAgents.parentSessionTitle.value)
const loading = computed(() => subAgents.loading.value)

const contextWindowEnabled = computed(
  () => (props.embedded || props.visible) && Boolean(currentSessionId.value),
)
const windowState = useContextWindow(contextWindowEnabled)

const hasTokenUsage = computed(() => streaming.currentTokens.value !== null)
const usedTokens = computed(() => streaming.currentTokens.value?.total ?? 0)
const validMax = computed<number | null>(() => {
  const value = windowState.contextWindow.value
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : null
})
const usagePercentLabel = computed(() => {
  const max = validMax.value
  if (max === null || !Number.isFinite(usedTokens.value)) return '—'
  return `${((usedTokens.value / max) * 100).toFixed(1)}%`
})
const usageAmountLabel = computed(() => {
  const used = usedTokens.value.toLocaleString('zh-CN')
  const max = validMax.value
  return max === null ? `${used} / —` : `${used} / ${max.toLocaleString('zh-CN')}`
})

const isCompacting = ref(false)
const compactError = ref('')
const compactConfirmOpen = ref(false)

const headerMeta = computed(
  () => currentSessionTitle.value || '当前会话',
)

const tokenRows = computed<TokenRow[]>(() => {
  const tokens = streaming.currentTokens.value
  if (!tokens) return []

  const rows: TokenRow[] = [
    { key: 'total', label: '总计', value: tokens.total },
    { key: 'input', label: '输入', value: tokens.input },
    { key: 'output', label: '输出', value: tokens.output },
  ]
  if (tokens.reasoning) {
    rows.push({ key: 'reasoning', label: '推理', value: tokens.reasoning })
  }
  if (tokens.cache) {
    rows.push({ key: 'cache-read', label: '缓存(读)', value: tokens.cache.read })
    rows.push({ key: 'cache-write', label: '缓存(写)', value: tokens.cache.write })
  }
  return rows
})

function requestClose(): void {
  emit('close')
}

function handleBackdropClick(): void {
  if (props.embedded) return
  requestClose()
}

function handleCompact(): void {
  if (isCompacting.value || !currentSessionId.value) return
  compactConfirmOpen.value = true
}

function handleCompactCancel(): void {
  compactConfirmOpen.value = false
}

async function confirmCompact(): Promise<void> {
  compactConfirmOpen.value = false
  await nextTick()
  await runCompact()
}

async function runCompact(): Promise<void> {
  const sessionId = currentSessionId.value
  if (!sessionId || isCompacting.value) return

  isCompacting.value = true
  compactError.value = ''
  try {
    const result = await chat.compactSession(sessionId)
    if (!result) compactError.value = '压缩请求失败，请稍后重试。'
  } catch {
    compactError.value = '压缩请求失败，请稍后重试。'
  } finally {
    isCompacting.value = false
  }
}

async function handleEnterSubAgent(agent: SubAgentInfo): Promise<void> {
  if (!agent.childSessionId) return
  await subAgents.enterSubAgent(agent.childSessionId)
  if (!props.embedded) requestClose()
}

async function handleBackToParent(): Promise<void> {
  await subAgents.returnToParent()
  if (!props.embedded) requestClose()
}

async function loadSubAgents(): Promise<void> {
  await subAgents.loadSubAgents(chat.currentSessionId.value, chat.messages.value)
}

let scrollLocked = false

function lockScroll(): void {
  if (scrollLocked) return
  scrollLocked = true
  document.documentElement.classList.add('chat-overlay-lock')
}

function unlockScroll(): void {
  if (!scrollLocked) return
  scrollLocked = false
  document.documentElement.classList.remove('chat-overlay-lock')
}

watch(
  () => props.visible,
  (visible) => {
    if (!visible) compactConfirmOpen.value = false
    if (props.embedded) {
      compactError.value = ''
      void loadSubAgents()
      return
    }
    if (visible) {
      compactError.value = ''
      lockScroll()
      trap.activate()
      void loadSubAgents()
      return
    }
    unlockScroll()
    trap.deactivate()
  },
  { immediate: true },
)

watch(compactConfirmOpen, async (open) => {
  if (open) {
    trap.deactivate()
    return
  }
  if (props.embedded || !props.visible) return
  await nextTick()
  if (compactConfirmOpen.value || props.embedded || !props.visible) return
  trap.activate()
})

watch(currentSessionId, () => {
  compactConfirmOpen.value = false
  void windowState.refresh()
  if (props.embedded) void loadSubAgents()
})

onBeforeUnmount(() => {
  if (props.embedded) return
  unlockScroll()
  trap.deactivate()
})
</script>

<style scoped>
:global(html.chat-overlay-lock),
:global(html.chat-overlay-lock body) {
  overflow: hidden;
}

:global(html.chat-overlay-lock .ax-shell__body) {
  overflow: hidden;
}

.ax-inspector {
  position: fixed;
  inset: 0;
  z-index: var(--z-sheet);
  display: flex;
  align-items: stretch;
  justify-content: flex-end;
  background: color-mix(in srgb, var(--ink) 34%, transparent);
}

.ax-inspector__panel {
  display: flex;
  flex-direction: column;
  inline-size: min(400px, 100vw);
  block-size: 100dvh;
  min-block-size: 0;
  overflow: hidden;
  background: var(--surface);
  border-inline-start: 1px solid var(--hairline);
  box-shadow: -12px 0 32px color-mix(in srgb, var(--ink) 14%, transparent);
  outline: none;
}

.ax-inspector__header {
  display: flex;
  flex: none;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4);
  border-block-end: 1px solid var(--hairline);
}

.ax-inspector__heading {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-inline-size: 0;
}

.ax-inspector__title {
  font-family: var(--font-display);
  font-size: 19px;
  font-weight: 600;
  line-height: 1.25;
}

.ax-inspector__meta {
  overflow: hidden;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ax-inspector__panel button {
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.ax-inspector__close {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  inline-size: var(--tap);
  block-size: var(--tap);
  margin: calc(var(--space-2) * -1) calc(var(--space-2) * -1) 0 0;
  border-radius: var(--radius-sm);
  color: var(--muted);
}

.ax-inspector__close:hover {
  background: var(--inset);
  color: var(--ink);
}

.ax-inspector__body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-block-size: 0;
  padding-block-end: env(safe-area-inset-bottom);
  overflow: hidden;
  overscroll-behavior: contain;
}

.ax-inspector__section {
  padding: var(--space-4);
  border-block-end: 1px solid var(--hairline);
}

.ax-inspector__section--usage {
  flex: none;
}

.ax-inspector__section--subagents {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-block-size: 0;
  overflow: hidden;
}

.ax-inspector__section-head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  color: var(--muted);
}

.ax-inspector__section-title {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  line-height: 1.4;
}

.ax-inspector__count {
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.ax-inspector__usage {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  margin-block-start: var(--space-3);
}

.ax-inspector__usage-percent {
  font-family: var(--font-mono);
  font-size: 17px;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  line-height: 1.2;
}

.ax-inspector__usage-amount {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.ax-inspector__meter {
  margin-block-start: var(--space-2);
}

.ax-inspector__window-unknown {
  margin-block-start: var(--space-2);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}

.ax-inspector__rows {
  display: flex;
  flex-direction: column;
  margin: var(--space-2) 0 var(--space-3);
  padding: 0;
}

.ax-inspector__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding-block: var(--space-2);
  border-block-end: 1px solid var(--hairline);
}

.ax-inspector__row-label {
  color: var(--muted);
  font-size: 12.5px;
}

.ax-inspector__row-value {
  margin: 0;
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.ax-inspector__empty {
  padding-block: var(--space-2);
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.55;
}

.ax-inspector__section-head .ax-inspector__compact {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  min-block-size: 30px;
  padding: 0 var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: 999px;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0.02em;
  line-height: 1;
  white-space: nowrap;
  transition:
    background var(--motion-fast) ease,
    color var(--motion-fast) ease;
}

.ax-inspector__section-head .ax-inspector__compact:hover:not(:disabled) {
  background: var(--inset);
  color: var(--ink);
}

.ax-inspector__section-head .ax-inspector__compact:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

@media (max-width: 767.98px) {
  .ax-inspector__section-head .ax-inspector__compact {
    min-block-size: 40px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ax-inspector__section-head .ax-inspector__compact {
    transition: none;
  }
}

.ax-inspector__error {
  margin-block: var(--space-2) 0;
  color: var(--danger);
  font-size: 12.5px;
  line-height: 1.5;
}

.ax-inspector__back {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
  inline-size: 100%;
  min-block-size: var(--tap);
  margin-block: var(--space-2) 0;
  padding-inline: var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--ink);
  font-size: 13px;
  text-align: start;
}

.ax-inspector__back:hover {
  background: var(--inset);
}

.ax-inspector__skeletons {
  display: flex;
  flex-direction: column;
  margin-block-start: var(--space-2);
}

.ax-inspector__agents {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-block-size: 0;
  margin: var(--space-2) 0 0;
  padding: 0;
  border-block-start: 1px solid var(--hairline);
  list-style: none;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.ax-inspector__agent {
  border-block-end: 1px solid var(--hairline);
}

.ax-inspector__agent-button {
  display: flex;
  flex-direction: column;
  gap: 2px;
  inline-size: 100%;
  min-block-size: var(--tap);
  padding: var(--space-2) 0;
  text-align: start;
}

.ax-inspector__agent-button:hover:not(:disabled) {
  background: var(--inset);
}

.ax-inspector__agent-button:disabled {
  cursor: default;
  opacity: 0.6;
}

.ax-inspector__agent-name {
  overflow: hidden;
  color: var(--ink);
  font-size: 13.5px;
  font-weight: 500;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ax-inspector__agent-meta {
  display: flex;
  gap: var(--space-3);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.4;
}

.ax-inspector__panel button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@media (max-width: 767.98px) {
  .ax-inspector {
    align-items: flex-end;
  }

  .ax-inspector__panel {
    inline-size: 100%;
    block-size: 85dvh;
    max-block-size: 85dvh;
    border-inline-start: 0;
    border-block-start: 1px solid var(--hairline);
    border-start-start-radius: var(--radius);
    border-start-end-radius: var(--radius);
    box-shadow: 0 -12px 32px color-mix(in srgb, var(--ink) 14%, transparent);
  }
}

.ax-inspector-enter-active,
.ax-inspector-leave-active {
  transition: opacity var(--motion-slow) ease;
}

.ax-inspector-enter-from,
.ax-inspector-leave-to {
  opacity: 0;
}

.ax-inspector-enter-active .ax-inspector__panel,
.ax-inspector-leave-active .ax-inspector__panel {
  transition: transform var(--motion-slow) ease;
}

.ax-inspector-enter-from .ax-inspector__panel {
  transform: translateX(24px);
}

.ax-inspector-leave-to .ax-inspector__panel {
  transform: translateX(24px);
}

@media (max-width: 767.98px) {
  .ax-inspector-enter-from .ax-inspector__panel,
  .ax-inspector-leave-to .ax-inspector__panel {
    transform: translateY(24px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ax-inspector-enter-active,
  .ax-inspector-leave-active,
  .ax-inspector-enter-active .ax-inspector__panel,
  .ax-inspector-leave-active .ax-inspector__panel {
    transition: none;
  }
}

/* ==================== Embedded column ==================== */

.ax-inspector--embedded {
  position: static;
  inset: auto;
  z-index: auto;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  inline-size: 100%;
  block-size: 100%;
  min-block-size: 0;
  background: none;
}

.ax-inspector--embedded .ax-inspector__panel {
  flex: 1 1 auto;
  inline-size: 100%;
  block-size: auto;
  min-block-size: 0;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}
</style>
