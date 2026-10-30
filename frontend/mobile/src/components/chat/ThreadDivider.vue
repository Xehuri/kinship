<script setup lang="ts">
import type { CompactionStep } from '@/types/turn'
import type { ToolFocusPayload } from '@/utils/toolDisplay'
import CompactionDivider from './CompactionDivider.vue'

const props = defineProps<{
  step: CompactionStep
}>()

const emit = defineEmits<{
  'open-focus': [payload: ToolFocusPayload]
}>()

function openSummary(): void {
  emit('open-focus', {
    title: '上下文摘要',
    content: props.step.text,
  })
}
</script>

<template>
  <div
    class="thread-divider"
    data-testid="thread-divider"
    data-kind="compaction"
  >
    <CompactionDivider
      :text="step.text"
      @open-summary="openSummary"
    />
  </div>
</template>

<style scoped>
.thread-divider {
  min-inline-size: 0;
  padding-block: var(--space-1);
}
</style>
