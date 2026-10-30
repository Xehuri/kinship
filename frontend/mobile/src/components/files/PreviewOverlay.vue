<template>
  <Teleport to="body">
    <Transition name="ax-preview-drawer">
      <div
        v-if="visible"
        class="ax-preview-drawer"
        data-testid="file-preview"
        role="dialog"
        aria-modal="true"
        :aria-label="`预览 ${name}`"
      >
        <FilePreviewPane :path="path" :name="name" :kind="kind" @close="handleClose" />
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import type { FilePreviewKind } from '@/types/files'
import FilePreviewPane from './FilePreviewPane.vue'

const props = defineProps<{
  visible: boolean
  path: string
  name: string
  kind: FilePreviewKind
}>()

const emit = defineEmits<{
  close: []
}>()

function handleClose(): void {
  emit('close')
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.visible) {
    handleClose()
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<style scoped>
.ax-preview-drawer {
  position: fixed;
  inset: 0;
  z-index: var(--z-sheet);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
}

.ax-preview-drawer :deep(.ax-preview-pane) {
  flex: 1 1 auto;
}

.ax-preview-drawer :deep(.ax-preview-pane__header) {
  padding-block-start: calc(var(--space-2) + var(--app-top-inset, 0px));
}

.ax-preview-drawer-enter-active,
.ax-preview-drawer-leave-active {
  transition:
    opacity var(--motion-slow) ease,
    transform var(--motion-slow) ease;
}

.ax-preview-drawer-enter-from,
.ax-preview-drawer-leave-to {
  opacity: 0;
  transform: translateY(12px);
}
</style>
