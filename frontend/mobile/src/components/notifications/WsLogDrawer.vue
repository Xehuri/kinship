<template>
  <Teleport to="body">
    <Transition name="ws-log-drawer">
      <div
        v-if="visible"
        class="ws-log-drawer"
        data-testid="ws-log-drawer"
        @click.self="close"
      >
        <section
          class="ws-log-drawer__panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ws-log-drawer-title"
        >
          <header class="ws-log-drawer__header">
            <div class="ws-log-drawer__heading">
              <h2 id="ws-log-drawer-title" class="ws-log-drawer__title">
                WS 日志
              </h2>
              <p class="ws-log-drawer__meta">
                {{ logs.length }} 条 · 最多保留 200 条
              </p>
            </div>
            <div class="ws-log-drawer__actions">
              <button
                class="ws-log-drawer__action"
                type="button"
                :disabled="logs.length === 0"
                @click="clear"
              >
                清空
              </button>
              <button
                class="ws-log-drawer__close"
                type="button"
                aria-label="关闭 WS 日志"
                @click="close"
              >
                <AppIcon name="X" :size="18" />
              </button>
            </div>
          </header>

          <div class="ws-log-drawer__body">
            <p v-if="logs.length === 0" class="ws-log-drawer__empty">
              暂无日志。WebSocket 消息到达后会显示在这里。
            </p>
            <ol v-else class="ws-log-drawer__list">
              <li
                v-for="(entry, index) in logs"
                :key="index"
                class="ws-log-drawer__item"
              >
                <span class="ws-log-drawer__time">{{ entry.time }}</span>
                <span class="ws-log-drawer__message">{{ entry.message }}</span>
              </li>
            </ol>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { useWsLog } from '@/composables/useWsLog'

const { logs, visible, close, clear } = useWsLog()

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && visible.value) {
    close()
  }
}

watch(visible, (open) => {
  document.documentElement.classList.toggle('ws-log-scroll-lock', open)
}, { immediate: true })

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown)
  document.documentElement.classList.remove('ws-log-scroll-lock')
})
</script>

<style scoped>
:global(html.ws-log-scroll-lock),
:global(html.ws-log-scroll-lock body) {
  overflow: hidden;
}

.ws-log-drawer {
  position: fixed;
  inset: 0;
  z-index: var(--z-sheet);
  display: flex;
  align-items: stretch;
  justify-content: flex-end;
  background: color-mix(in srgb, var(--ink) 34%, transparent);
}

.ws-log-drawer__panel {
  display: flex;
  flex-direction: column;
  inline-size: min(480px, 100vw);
  block-size: 100dvh;
  min-block-size: 0;
  background: var(--surface);
  border-inline-start: 1px solid var(--hairline);
  box-shadow: -12px 0 32px color-mix(in srgb, var(--ink) 14%, transparent);
}

.ws-log-drawer__header {
  display: flex;
  flex: none;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4);
  border-block-end: 1px solid var(--hairline);
}

.ws-log-drawer__heading {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-inline-size: 0;
}

.ws-log-drawer__title {
  font-family: var(--font-display);
  font-size: 19px;
  font-weight: 600;
  line-height: 1.25;
}

.ws-log-drawer__meta {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
}

.ws-log-drawer__actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-1);
}

.ws-log-drawer__action {
  min-block-size: 32px;
  padding-inline: var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 12px;
}

.ws-log-drawer__action:hover:not(:disabled) {
  background: var(--inset);
  color: var(--ink);
}

.ws-log-drawer__action:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.ws-log-drawer__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: 36px;
  block-size: 36px;
  border-radius: var(--radius-sm);
  color: var(--muted);
}

.ws-log-drawer__close:hover {
  background: var(--inset);
  color: var(--ink);
}

.ws-log-drawer__action:focus-visible,
.ws-log-drawer__close:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.ws-log-drawer__body {
  flex: 1 1 auto;
  min-block-size: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--space-3) var(--space-4) var(--space-6);
}

.ws-log-drawer__empty {
  padding-block: var(--space-6);
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.6;
  text-align: center;
}

.ws-log-drawer__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.ws-log-drawer__item {
  display: flex;
  gap: var(--space-2);
  padding-block: var(--space-1);
  border-block-end: 1px solid var(--hairline);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  word-break: break-all;
}

.ws-log-drawer__time {
  flex: none;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.ws-log-drawer__message {
  color: var(--ink);
}

@media (max-width: 767.98px) {
  .ws-log-drawer {
    align-items: flex-end;
  }

  .ws-log-drawer__panel {
    inline-size: 100%;
    block-size: auto;
    max-block-size: 85dvh;
    border-inline-start: 0;
    border-block-start: 1px solid var(--hairline);
    border-start-start-radius: var(--radius);
    border-start-end-radius: var(--radius);
    box-shadow: 0 -12px 32px color-mix(in srgb, var(--ink) 14%, transparent);
  }

  .ws-log-drawer__body {
    padding-block-end: calc(var(--space-6) + env(safe-area-inset-bottom));
  }
}

.ws-log-drawer-enter-active,
.ws-log-drawer-leave-active {
  transition: opacity var(--motion-slow) ease;
}

.ws-log-drawer-enter-from,
.ws-log-drawer-leave-to {
  opacity: 0;
}
</style>
