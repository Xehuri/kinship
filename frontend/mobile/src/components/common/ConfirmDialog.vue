<template>
  <Teleport to="body">
    <Transition name="ax-confirm">
      <div v-if="visible" class="ax-confirm" @click.self="emit('cancel')">
        <section
          ref="panelRef"
          class="ax-confirm__panel"
          role="alertdialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          :aria-describedby="messageId"
          data-testid="confirm-dialog"
          tabindex="-1"
        >
          <h2 :id="titleId" class="ax-confirm__title">{{ title }}</h2>
          <p :id="messageId" class="ax-confirm__message">{{ message }}</p>
          <div class="ax-confirm__actions">
            <button
              ref="cancelRef"
              class="ax-confirm__button"
              type="button"
              data-testid="confirm-dialog-cancel"
              @click="emit('cancel')"
            >
              {{ cancelLabel }}
            </button>
            <button
              class="ax-confirm__button ax-confirm__button--primary"
              type="button"
              data-testid="confirm-dialog-confirm"
              @click="emit('confirm')"
            >
              {{ confirmLabel }}
            </button>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { useFocusTrap } from '@/composables/useFocusTrap'

const props = withDefaults(
  defineProps<{
    visible: boolean
    title: string
    message: string
    confirmLabel?: string
    cancelLabel?: string
  }>(),
  {
    confirmLabel: '确认',
    cancelLabel: '取消',
  },
)

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const panelRef = ref<HTMLElement | null>(null)
const cancelRef = ref<HTMLButtonElement | null>(null)
const uid = useId()
const titleId = `confirm-dialog-title-${uid}`
const messageId = `confirm-dialog-message-${uid}`

const trap = useFocusTrap(panelRef, {
  onEscape: () => emit('cancel'),
})

watch(
  () => props.visible,
  async (visible) => {
    if (visible) {
      await nextTick()
      if (!props.visible) return
      trap.activate()
      cancelRef.value?.focus()
      return
    }
    trap.deactivate()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  trap.deactivate()
})
</script>

<style scoped>
.ax-confirm {
  position: fixed;
  inset: 0;
  z-index: var(--z-toast);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background: color-mix(in srgb, var(--ink) 38%, transparent);
}

.ax-confirm__panel {
  inline-size: 100%;
  max-inline-size: 360px;
  max-block-size: calc(100dvh - var(--space-8));
  padding: var(--space-5);
  overflow-y: auto;
  background: var(--surface-raised);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  box-shadow: 0 18px 48px color-mix(in srgb, var(--ink) 22%, transparent);
  outline: none;
}

.ax-confirm__title {
  color: var(--ink);
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 600;
  line-height: 1.3;
}

.ax-confirm__message {
  margin-block-start: var(--space-2);
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}

.ax-confirm__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  margin-block-start: var(--space-5);
}

.ax-confirm__button {
  min-block-size: 36px;
  padding: 0 var(--space-4);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--ink);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  transition:
    background var(--motion-fast) ease,
    border-color var(--motion-fast) ease;
}

.ax-confirm__button:hover {
  background: var(--inset);
}

.ax-confirm__button--primary {
  border-color: transparent;
  background: var(--accent);
  color: var(--accent-ink);
}

.ax-confirm__button--primary:hover {
  background: color-mix(in srgb, var(--accent) 88%, var(--ink));
}

.ax-confirm__panel button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.ax-confirm-enter-active,
.ax-confirm-leave-active {
  transition: opacity var(--motion-slow) ease;
}

.ax-confirm-enter-from,
.ax-confirm-leave-to {
  opacity: 0;
}

.ax-confirm-enter-active .ax-confirm__panel,
.ax-confirm-leave-active .ax-confirm__panel {
  transition: transform var(--motion-slow) ease;
}

.ax-confirm-enter-from .ax-confirm__panel,
.ax-confirm-leave-to .ax-confirm__panel {
  transform: translateY(8px) scale(0.98);
}

@media (max-width: 767.98px) {
  .ax-confirm__panel {
    inline-size: calc(100vw - 32px);
  }

  .ax-confirm__button {
    min-block-size: var(--tap);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ax-confirm-enter-active,
  .ax-confirm-leave-active,
  .ax-confirm-enter-active .ax-confirm__panel,
  .ax-confirm-leave-active .ax-confirm__panel {
    transition: none;
  }
}
</style>
