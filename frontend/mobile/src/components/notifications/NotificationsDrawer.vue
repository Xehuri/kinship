<template>
  <Teleport to="body">
    <Transition name="notifications-drawer">
      <div
        v-if="visible"
        class="notifications-drawer"
        data-testid="notifications-drawer"
        @click.self="requestClose"
      >
        <section
          ref="panelRef"
          class="notifications-drawer__panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="notifications-drawer-title"
          tabindex="-1"
        >
          <header class="notifications-drawer__header">
            <div class="notifications-drawer__heading">
              <h2 id="notifications-drawer-title" class="notifications-drawer__title">
                通知历史
              </h2>
              <p class="notifications-drawer__meta">
                {{ headerMeta }}
              </p>
            </div>
            <button
              class="notifications-drawer__close"
              type="button"
              aria-label="关闭通知历史"
              @click="requestClose"
            >
              <AppIcon name="X" :size="18" />
            </button>
          </header>

          <div class="notifications-drawer__body">
            <div
              v-if="state === 'loading' || state === 'idle'"
              class="notifications-drawer__skeletons"
              aria-busy="true"
              aria-label="正在加载通知"
            >
              <div v-for="index in 4" :key="index" class="notifications-drawer__skeleton">
                <span class="skeleton notifications-drawer__skeleton-line" />
                <span class="skeleton notifications-drawer__skeleton-line notifications-drawer__skeleton-line--short" />
              </div>
            </div>

            <div
              v-else-if="state === 'error'"
              class="notifications-drawer__state"
              role="alert"
            >
              <AppIcon name="WarningCircle" :size="28" />
              <h3 class="notifications-drawer__state-title">加载失败</h3>
              <p class="notifications-drawer__state-body">
                无法获取通知历史，请检查连接后重试。
              </p>
              <button
                class="notifications-drawer__action"
                type="button"
                data-testid="notifications-retry"
                @click="emit('retry')"
              >
                重试
              </button>
            </div>

            <div
              v-else-if="notifications.length === 0"
              class="notifications-drawer__state"
              data-testid="notifications-empty"
            >
              <AppIcon name="Bell" :size="28" />
              <h3 class="notifications-drawer__state-title">暂无通知</h3>
              <p class="notifications-drawer__state-body">
                AI 推送的通知会按时间倒序出现在这里。
              </p>
            </div>

            <ul v-else class="notifications-drawer__list">
              <li
                v-for="item in notifications"
                :key="item.id"
                class="notifications-drawer__item"
                data-testid="notification-item"
              >
                <div class="notifications-drawer__item-main">
                  <h3 class="notifications-drawer__item-title">
                    {{ item.title }}
                  </h3>
                  <p class="notifications-drawer__item-content">
                    {{ item.content }}
                  </p>
                  <time
                    class="notifications-drawer__item-time"
                    :datetime="isoTime(item.created_at)"
                  >
                    {{ formatTime(item.created_at) }}
                  </time>
                </div>
                <button
                  class="notifications-drawer__delete"
                  type="button"
                  data-testid="notification-delete"
                  :disabled="deletingId === item.id"
                  :aria-label="`删除通知：${item.title}`"
                  @click="emit('delete', item.id)"
                >
                  <AppIcon name="Trash" :size="16" />
                </button>
              </li>
            </ul>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { useFocusTrap } from '@/composables/useFocusTrap'
import type { NotificationsState } from '@/composables/useNotifications'
import type { NotificationItem } from '@/api/notifications'

const props = withDefaults(
  defineProps<{
    visible: boolean
    notifications?: readonly NotificationItem[]
    total?: number
    state?: NotificationsState
    deletingId?: number | null
  }>(),
  {
    notifications: () => [],
    total: 0,
    state: 'idle',
    deletingId: null,
  },
)

const emit = defineEmits<{
  close: []
  delete: [id: number]
  retry: []
}>()

const panelRef = ref<HTMLElement | null>(null)
const trap = useFocusTrap(panelRef, {
  onEscape: () => emit('close'),
})

const headerMeta = computed<string>(() => {
  if (props.state === 'loading' || props.state === 'idle') return '正在加载'
  if (props.state === 'error') return '加载失败'
  return `共 ${props.total} 条`
})

/** 背景滚动锁: 同时锁住 body 与 v2 壳层自己的滚动容器 */
let scrollLocked = false

function lockScroll(): void {
  if (scrollLocked) return
  scrollLocked = true
  document.documentElement.classList.add('notifications-scroll-lock')
}

function unlockScroll(): void {
  if (!scrollLocked) return
  scrollLocked = false
  document.documentElement.classList.remove('notifications-scroll-lock')
}

function requestClose(): void {
  emit('close')
}

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      lockScroll()
      trap.activate()
      return
    }
    unlockScroll()
    trap.deactivate()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  unlockScroll()
  trap.deactivate()
})

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function formatTime(timestamp: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp * 1000)
  if (Number.isNaN(date.getTime())) return ''

  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return `今天 ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) {
    return `昨天 ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function isoTime(timestamp: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp * 1000)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}
</script>

<style scoped>
/* ==================== 背景滚动锁 ==================== */

:global(html.notifications-scroll-lock),
:global(html.notifications-scroll-lock body) {
  overflow: hidden;
}

:global(html.notifications-scroll-lock .ax-shell__body) {
  overflow: hidden;
}

/* ==================== 抽屉 ==================== */

.notifications-drawer {
  position: fixed;
  inset: 0;
  z-index: var(--z-sheet);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: color-mix(in srgb, var(--ink) 34%, transparent);
}

.notifications-drawer__panel {
  display: flex;
  flex-direction: column;
  inline-size: min(520px, 100%);
  block-size: auto;
  max-block-size: 70dvh;
  min-block-size: 0;
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  box-shadow: 0 24px 64px color-mix(in srgb, var(--ink) 24%, transparent);
  outline: none;
}

.notifications-drawer__header {
  display: flex;
  flex: none;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4);
  border-block-end: 1px solid var(--hairline);
}

.notifications-drawer__heading {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-inline-size: 0;
}

.notifications-drawer__title {
  font-family: var(--font-display);
  font-size: 19px;
  font-weight: 600;
  line-height: 1.25;
}

.notifications-drawer__meta {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
}

.notifications-drawer__panel button {
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.notifications-drawer__close {
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

.notifications-drawer__close:hover {
  background: var(--inset);
  color: var(--ink);
}

.notifications-drawer__body {
  flex: 1 1 auto;
  min-block-size: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

/* ==================== 状态 ==================== */

.notifications-drawer__skeletons {
  display: flex;
  flex-direction: column;
}

.notifications-drawer__skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  border-block-end: 1px solid var(--hairline);
}

.notifications-drawer__skeleton-line {
  block-size: 12px;
  inline-size: 100%;
  border-radius: var(--radius-sm);
}

.notifications-drawer__skeleton-line--short {
  inline-size: 55%;
}

.notifications-drawer__state {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-6) var(--space-4);
  color: var(--muted);
}

.notifications-drawer__state-title {
  color: var(--ink);
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 600;
  line-height: 1.3;
}

.notifications-drawer__state-body {
  max-inline-size: 32ch;
  font-size: 13.5px;
  line-height: 1.6;
}

.notifications-drawer__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-block-size: var(--tap);
  padding-inline: var(--space-4);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  color: var(--ink);
  font-size: 13px;
  font-weight: 500;
}

.notifications-drawer__action:hover {
  background: var(--inset);
}

/* ==================== 列表 ==================== */

.notifications-drawer__list {
  margin: 0;
  padding: 0;
  border-block-start: 1px solid var(--hairline);
  list-style: none;
}

.notifications-drawer__item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-2) var(--space-3) var(--space-4);
  border-block-end: 1px solid var(--hairline);
}

.notifications-drawer__item-main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: var(--space-1);
  min-inline-size: 0;
}

.notifications-drawer__item-title {
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.notifications-drawer__item-content {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.55;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.notifications-drawer__item-time {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
}

.notifications-drawer__delete {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  inline-size: var(--tap);
  block-size: var(--tap);
  border-radius: var(--radius-sm);
  color: var(--muted);
}

.notifications-drawer__delete:hover:not(:disabled) {
  background: var(--inset);
  color: var(--danger);
}

.notifications-drawer__delete:disabled {
  cursor: progress;
  opacity: 0.45;
}

.notifications-drawer__panel button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* ==================== 移动端: 底部整宽抽屉 ==================== */

@media (max-width: 767.98px) {
  .notifications-drawer {
    align-items: flex-end;
    padding: 0;
  }

  .notifications-drawer__panel {
    inline-size: 100%;
    block-size: auto;
    max-block-size: 85dvh;
    border: 0;
    border-block-start: 1px solid var(--hairline);
    border-start-start-radius: var(--radius);
    border-start-end-radius: var(--radius);
    border-end-start-radius: 0;
    border-end-end-radius: 0;
    box-shadow: 0 -12px 32px color-mix(in srgb, var(--ink) 14%, transparent);
  }

  .notifications-drawer__body {
    padding-block-end: env(safe-area-inset-bottom);
  }
}

/* ==================== 过渡 ==================== */

.notifications-drawer-enter-active,
.notifications-drawer-leave-active {
  transition: opacity var(--motion-slow) ease;
}

.notifications-drawer-enter-from,
.notifications-drawer-leave-to {
  opacity: 0;
}

.notifications-drawer-enter-active .notifications-drawer__panel,
.notifications-drawer-leave-active .notifications-drawer__panel {
  transition: transform var(--motion-slow) ease;
}

.notifications-drawer-enter-from .notifications-drawer__panel {
  transform: scale(0.98);
}

.notifications-drawer-leave-to .notifications-drawer__panel {
  transform: scale(0.98);
}

@media (max-width: 767.98px) {
  .notifications-drawer-enter-from .notifications-drawer__panel,
  .notifications-drawer-leave-to .notifications-drawer__panel {
    transform: translateY(24px);
  }
}
</style>
