<template>
  <Teleport to="body">
    <Transition name="ax-focus">
      <div
        v-if="visible"
        class="ax-focus"
        data-testid="focus-drawer"
        @click.self="requestClose"
      >
        <section
          ref="panelRef"
          class="ax-focus__panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="focus-drawer-title"
          tabindex="-1"
        >
          <header class="ax-focus__header">
            <div class="ax-focus__heading">
              <h2 id="focus-drawer-title" class="ax-focus__title">{{ title }}</h2>
              <p class="ax-focus__meta">{{ meta }}</p>
            </div>
            <button
              class="ax-focus__close"
              type="button"
              aria-label="关闭完整输出"
              @click="requestClose"
            >
              <AppIcon name="X" :size="18" />
            </button>
          </header>

          <div class="ax-focus__body">
            <pre v-if="content.length > 0" class="ax-focus__content">{{ content }}</pre>
            <p v-else class="ax-focus__empty">没有可显示的正文。</p>
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
import { formatSize } from '@/utils/format'

const props = withDefaults(
  defineProps<{
    visible: boolean
    title?: string
    content?: string
    bytes?: number
    truncated?: boolean
  }>(),
  {
    title: '完整输出',
    content: '',
    bytes: 0,
    truncated: false,
  },
)

const emit = defineEmits<{
  close: []
}>()

const panelRef = ref<HTMLElement | null>(null)
const trap = useFocusTrap(panelRef, {
  onEscape: () => emit('close'),
})

const meta = computed(() => {
  const parts: string[] = []
  if (props.bytes > 0) parts.push(formatSize(props.bytes))
  parts.push(props.truncated ? '已截断' : '完整正文')
  return parts.join(' · ')
})

function requestClose(): void {
  emit('close')
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
</script>

<style scoped>
:global(html.chat-overlay-lock),
:global(html.chat-overlay-lock body) {
  overflow: hidden;
}

:global(html.chat-overlay-lock .ax-shell__body) {
  overflow: hidden;
}

.ax-focus {
  position: fixed;
  inset: 0;
  z-index: var(--z-sheet);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: color-mix(in srgb, var(--ink) 42%, transparent);
}

.ax-focus__panel {
  display: flex;
  flex-direction: column;
  inline-size: min(760px, 100%);
  max-block-size: min(80dvh, 720px);
  min-block-size: 0;
  background: var(--surface);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  box-shadow: 0 24px 64px color-mix(in srgb, var(--ink) 24%, transparent);
  outline: none;
  overflow: hidden;
}

.ax-focus__header {
  display: flex;
  flex: none;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4);
  border-block-end: 1px solid var(--hairline);
}

.ax-focus__heading {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-inline-size: 0;
}

.ax-focus__title {
  overflow: hidden;
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 600;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ax-focus__meta {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
}

.ax-focus__panel button {
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.ax-focus__close {
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

.ax-focus__close:hover {
  background: var(--inset);
  color: var(--ink);
}

.ax-focus__body {
  flex: 1 1 auto;
  min-block-size: 0;
  overflow: auto;
  overscroll-behavior: contain;
}

.ax-focus__content {
  margin: 0;
  padding: var(--space-4);
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.ax-focus__empty {
  padding: var(--space-6) var(--space-4);
  color: var(--muted);
  font-size: 13px;
}

.ax-focus__panel button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@media (max-width: 767.98px) {
  .ax-focus {
    align-items: flex-end;
    padding: 0;
  }

  .ax-focus__panel {
    inline-size: 100%;
    max-block-size: 85dvh;
    border-inline: 0;
    border-block-end: 0;
    border-start-start-radius: var(--radius);
    border-start-end-radius: var(--radius);
  }

  .ax-focus__body {
    padding-block-end: env(safe-area-inset-bottom);
  }
}

.ax-focus-enter-active,
.ax-focus-leave-active {
  transition: opacity var(--motion-slow) ease;
}

.ax-focus-enter-from,
.ax-focus-leave-to {
  opacity: 0;
}

.ax-focus-enter-active .ax-focus__panel,
.ax-focus-leave-active .ax-focus__panel {
  transition: transform var(--motion-slow) ease;
}

.ax-focus-enter-from .ax-focus__panel,
.ax-focus-leave-to .ax-focus__panel {
  transform: scale(0.98);
}

@media (prefers-reduced-motion: reduce) {
  .ax-focus-enter-active,
  .ax-focus-leave-active,
  .ax-focus-enter-active .ax-focus__panel,
  .ax-focus-leave-active .ax-focus__panel {
    transition: none;
  }
}
</style>
