<script setup lang="ts">
import type { ProcessGroupView } from '@/utils/processGroups'
import type { ToolFocusPayload } from '@/utils/toolDisplay'
import ReasoningRow from './ReasoningRow.vue'
import ToolRow from './ToolRow.vue'

const props = withDefaults(
  defineProps<{
    group: ProcessGroupView
    live?: boolean
  }>(),
  {
    live: false,
  },
)

const emit = defineEmits<{
  'open-focus': [payload: ToolFocusPayload]
}>()

function thinkingLive(stepLive: boolean | undefined): boolean {
  return props.live || stepLive === true
}
</script>

<template>
  <section
    class="process-group"
    data-testid="process-group"
    role="group"
    :aria-label="group.label"
  >
    <template
      v-for="(step, index) in group.steps"
      :key="step.type === 'tool' ? step.id : `${step.type}-${index}`"
    >
      <ReasoningRow
        v-if="step.type === 'thinking'"
        :text="step.text"
        :duration-ms="step.durationMs"
        :live="thinkingLive(step.live)"
      />
      <ToolRow
        v-else
        :step="step"
        @open-focus="emit('open-focus', $event)"
      />
    </template>
  </section>
</template>

<style scoped>
.process-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-inline-size: 0;
}
</style>
