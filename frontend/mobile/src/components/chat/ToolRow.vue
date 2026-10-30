<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import type { ToolStep } from '@/types/turn'
import {
  formatDurationMs,
  toolArgumentSummary,
  type ToolFocusPayload,
} from '@/utils/toolDisplay'
import { toolDescriptor } from '@/utils/toolRegistry'
import ToolResultCard from './ToolResultCard.vue'

const props = withDefaults(
  defineProps<{
    step: ToolStep
    defaultExpanded?: boolean
  }>(),
  {
    defaultExpanded: false,
  },
)

const emit = defineEmits<{
  'open-focus': [payload: ToolFocusPayload]
}>()

const expanded = ref(props.defaultExpanded)
const bodyId = `tool-body-${useId()}`

const descriptor = computed(() => toolDescriptor(props.step.name))
const summary = computed(() => toolArgumentSummary(props.step.name, props.step.arguments))
const durationText = computed(() => formatDurationMs(props.step.durationMs))
const streaming = computed(() => props.step.status === 'running')
const tone = computed<'error' | 'warning' | undefined>(() => {
  if (props.step.status === 'abandoned') {
    return 'warning'
  }
  if (props.step.status === 'error' || props.step.result?.isError === true) {
    return 'error'
  }
  return undefined
})
const statusText = computed(() => {
  if (props.step.status === 'pending') {
    return '待执行'
  }
  if (props.step.status === 'error') {
    return '失败'
  }
  if (props.step.status === 'abandoned') {
    return '未返回'
  }
  return ''
})

function toggle(): void {
  expanded.value = !expanded.value
}
</script>

<template>
  <article
    class="tool-row"
    data-testid="tool-row"
    :data-status="step.status"
    :data-tool="step.name"
    :data-tone="tone"
    :data-state="expanded ? 'expanded' : 'collapsed'"
    :data-live="streaming ? 'true' : undefined"
  >
    <button
      class="tool-row__header"
      type="button"
      :aria-expanded="expanded ? 'true' : 'false'"
      :aria-controls="bodyId"
      @click="toggle"
    >
      <AppIcon
        class="tool-row__icon"
        :name="descriptor.icon"
        :size="14"
      />
      <span
        class="tool-row__name"
        data-testid="tool-name"
      >{{ step.name }}</span>
      <span class="tool-row__verb">{{ descriptor.verb }}</span>
      <span
        class="tool-row__dots"
        aria-hidden="true"
      >
        <i /><i /><i /><i />
      </span>
      <span
        class="tool-row__summary"
        :title="summary"
      >{{ summary }}</span>
      <span
        v-if="statusText"
        class="tool-row__status"
      >{{ statusText }}</span>
      <span
        v-if="durationText"
        class="tool-row__duration"
        data-testid="tool-duration"
      >{{ durationText }}</span>
    </button>

    <div
      v-if="expanded"
      :id="bodyId"
      class="tool-row__body"
    >
      <ToolResultCard
        :step="step"
        @open-focus="emit('open-focus', $event)"
      />
    </div>
  </article>
</template>

<style scoped>
.tool-row {
  display: flex;
  flex-direction: column;
  min-inline-size: 0;
}

.tool-row__header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  inline-size: 100%;
  min-block-size: var(--tap);
  color: var(--muted);
  font-size: 13px;
  line-height: 1.5;
  text-align: start;
}

.tool-row__icon {
  color: var(--muted);
}

.tool-row__name {
  flex: none;
  max-inline-size: 18ch;
  overflow: hidden;
  padding-inline: var(--space-1);
  border-radius: var(--radius-sm);
  background: var(--inset);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-row__verb {
  flex: none;
  color: var(--ink);
  white-space: nowrap;
}

.tool-row__dots {
  display: grid;
  flex: none;
  grid-template-columns: repeat(2, 2px);
  gap: 2px;
  align-content: center;
  color: var(--muted);
  opacity: 0.7;
}

.tool-row__dots i {
  inline-size: 2px;
  block-size: 2px;
  border-radius: 50%;
  background: currentColor;
}

.tool-row__summary {
  flex: 1 1 auto;
  min-inline-size: 0;
  overflow: hidden;
  color: var(--muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-row__status {
  flex: none;
  color: var(--muted);
  font-size: 11.5px;
  white-space: nowrap;
}

.tool-row__duration {
  flex: none;
  margin-inline-start: auto;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.tool-row__header:hover .tool-row__verb {
  color: var(--accent);
}

.tool-row[data-tone="error"] .tool-row__icon,
.tool-row[data-tone="error"] .tool-row__verb,
.tool-row[data-tone="error"] .tool-row__summary,
.tool-row[data-tone="error"] .tool-row__status {
  color: var(--danger);
}

.tool-row[data-tone="warning"] .tool-row__icon,
.tool-row[data-tone="warning"] .tool-row__verb,
.tool-row[data-tone="warning"] .tool-row__summary,
.tool-row[data-tone="warning"] .tool-row__status {
  color: var(--warning);
}

.tool-row__body {
  padding-block: var(--space-1) var(--space-2);
  padding-inline-start: 22px;
}

@supports ((-webkit-background-clip: text) or (background-clip: text)) {
  .tool-row[data-live="true"] .tool-row__verb,
  .tool-row[data-live="true"] .tool-row__summary {
    background: linear-gradient(90deg, var(--muted) 0%, var(--ink) 45%, var(--muted) 90%);
    background-size: 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: tool-shimmer 1.6s linear infinite;
  }
}

@keyframes tool-shimmer {
  from {
    background-position: 200% 0;
  }

  to {
    background-position: -200% 0;
  }
}

@media (min-width: 768px) and (pointer: fine) {
  .tool-row__header {
    min-block-size: 24px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .tool-row[data-live="true"] .tool-row__verb,
  .tool-row[data-live="true"] .tool-row__summary {
    animation: none;
    background: none;
    color: var(--muted);
  }
}

:root[data-motion="reduced"] .tool-row[data-live="true"] .tool-row__verb,
:root[data-motion="reduced"] .tool-row[data-live="true"] .tool-row__summary {
  animation: none;
  background: none;
  color: var(--muted);
}
</style>
