<template>
  <Teleport to="body">
    <Transition name="ax-sheet">
      <div
        v-if="visible"
        class="ax-sheet"
        data-testid="voiceprint-sheet"
        @click.self="close"
      >
        <section
          ref="panelRef"
          class="ax-sheet__panel"
          role="dialog"
          aria-modal="true"
          aria-label="声纹记录"
          tabindex="-1"
        >
          <header class="ax-sheet__head">
            <div class="ax-sheet__heading">
              <h2 class="ax-sheet__title">声纹记录</h2>
              <span class="ax-sheet__hint">今日说话人归属与相似度</span>
            </div>
            <button
              class="ax-sheet__close"
              type="button"
              aria-label="关闭声纹记录"
              @click="close"
            >
              <AppIcon name="X" :size="18" />
            </button>
          </header>

          <div class="ax-sheet__body">
            <slot />
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { useFocusTrap } from '@/composables/useFocusTrap'

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const panelRef = ref<HTMLElement | null>(null)
const focusTrap = useFocusTrap(panelRef, {
  onEscape: () => emit('close'),
})

/** 滚动锁: 记录进入前的 overflow, 关闭时原样恢复 */
let scrollLocked = false
let previousBodyOverflow = ''
let lockedShellBody: HTMLElement | null = null
let previousShellBodyOverflow = ''

function lockBodyScroll(): void {
  if (scrollLocked) return
  previousBodyOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  lockedShellBody = document.querySelector<HTMLElement>('.ax-shell__body')
  if (lockedShellBody) {
    previousShellBodyOverflow = lockedShellBody.style.overflow
    lockedShellBody.style.overflow = 'hidden'
  }
  scrollLocked = true
}

function unlockBodyScroll(): void {
  if (!scrollLocked) return
  document.body.style.overflow = previousBodyOverflow
  if (lockedShellBody) {
    lockedShellBody.style.overflow = previousShellBodyOverflow
  }
  lockedShellBody = null
  previousShellBodyOverflow = ''
  scrollLocked = false
}

function close(): void {
  emit('close')
}

watch(
  () => props.visible,
  async (visible) => {
    if (visible) {
      lockBodyScroll()
      await nextTick()
      focusTrap.activate()
      return
    }
    focusTrap.deactivate()
    unlockBodyScroll()
  },
  { immediate: true },
)

onUnmounted(() => {
  focusTrap.deactivate()
  unlockBodyScroll()
})
</script>

<style scoped>
.ax-sheet {
  position: fixed;
  inset: 0;
  z-index: var(--z-sheet);
  display: flex;
  justify-content: flex-end;
  background: var(--overlay-bg);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

.ax-sheet__panel {
  display: flex;
  flex-direction: column;
  inline-size: min(680px, 100%);
  block-size: 100dvh;
  max-block-size: 100dvh;
  min-inline-size: 0;
  background: var(--surface);
  border-inline-start: 1px solid var(--hairline);
  outline: none;
}

.ax-sheet__head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: calc(var(--space-3) + var(--app-top-inset, 0px)) var(--space-4) var(--space-3);
  border-block-end: 1px solid var(--hairline);
}

.ax-sheet__heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-inline-size: 0;
}

.ax-sheet__title {
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 600;
  line-height: 1.3;
}

.ax-sheet__hint {
  overflow: hidden;
  color: var(--muted);
  font-size: 11.5px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ax-sheet__close {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  min-inline-size: var(--tap);
  min-block-size: var(--tap);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  color: var(--muted);
}

.ax-sheet__close:hover {
  background: var(--inset);
  color: var(--ink);
}

.ax-sheet__body {
  flex: 1 1 auto;
  min-block-size: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.ax-sheet__body :deep(.vp-tab) {
  min-block-size: 100%;
}

.ax-sheet-enter-active,
.ax-sheet-leave-active {
  transition: opacity var(--motion-fast) ease;
}

.ax-sheet-enter-active .ax-sheet__panel,
.ax-sheet-leave-active .ax-sheet__panel {
  transition: transform var(--motion-slow) ease;
}

.ax-sheet-enter-from,
.ax-sheet-leave-to {
  opacity: 0;
}

.ax-sheet-enter-from .ax-sheet__panel,
.ax-sheet-leave-to .ax-sheet__panel {
  transform: translateX(24px);
}

@media (max-width: 767.98px) {
  .ax-sheet__panel {
    inline-size: 100%;
    border-inline-start: 0;
  }
}
</style>
