<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import type { ToolStatus } from '@/types/turn'
import { formatDurationMs } from '@/utils/toolDisplay'
import { toolDescriptor } from '@/utils/toolRegistry'

const props = withDefaults(
  defineProps<{
    id: string
    label: string
    agent?: string | null
    turns: number
    records: number
    durationMs?: number | null
    status?: ToolStatus | null
  }>(),
  {
    agent: null,
    durationMs: null,
    status: null,
  },
)

const emit = defineEmits<{
  'open-child': [id: string]
}>()

const STATUS_LABELS: Record<ToolStatus, string> = {
  pending: '待执行',
  running: '执行中',
  completed: '完成',
  error: '失败',
  abandoned: '已收束',
}

const descriptor = computed(() => toolDescriptor('task'))
const agentText = computed(() => props.agent ?? '未标注')
const statusText = computed(() =>
  props.status === null || props.status === undefined
    ? ''
    : STATUS_LABELS[props.status],
)
const tone = computed<'danger' | 'accent' | undefined>(() => {
  if (props.status === 'error') {
    return 'danger'
  }
  if (props.status === 'running') {
    return 'accent'
  }
  return undefined
})
const durationText = computed(() => formatDurationMs(props.durationMs))

function open(): void {
  emit('open-child', props.id)
}
</script>

<template>
  <button
    class="child-run-row"
    type="button"
    data-testid="child-run-row"
    :data-status="status ?? undefined"
    :data-tone="tone"
    @click="open"
  >
    <AppIcon
      class="child-run-row__icon"
      :name="descriptor.icon"
      :size="14"
    />
    <span class="child-run-row__verb">{{ descriptor.verb }}</span>
    <span class="child-run-row__dots" aria-hidden="true">
      <i /><i /><i /><i />
    </span>
    <span class="child-run-row__label">{{ label }}</span>
    <span class="child-run-row__agent">{{ agentText }}</span>
    <span class="child-run-row__trailing">
      <span v-if="statusText" class="child-run-row__status">{{ statusText }}</span>
      <span class="child-run-row__meta">{{ turns }} 轮</span>
      <span class="child-run-row__meta">{{ records }} 条记录</span>
      <span v-if="durationText" class="child-run-row__duration">{{ durationText }}</span>
      <AppIcon class="child-run-row__chevron" name="CaretRight" :size="12" weight="bold" />
    </span>
  </button>
</template>

<style scoped>
.child-run-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px var(--space-2);
  inline-size: 100%;
  min-block-size: var(--tap);
  padding-block: var(--space-1);
  border-block-end: 1px solid var(--hairline);
  color: var(--muted);
  font-size: 13px;
  text-align: start;
}

.child-run-row__icon {
  color: var(--muted);
}

.child-run-row__verb {
  flex: none;
  color: var(--ink);
  white-space: nowrap;
}

.child-run-row__dots {
  display: grid;
  flex: none;
  grid-template-columns: repeat(2, 2px);
  gap: 2px;
  align-content: center;
  color: var(--muted);
  opacity: 0.7;
}

.child-run-row__dots i {
  inline-size: 2px;
  block-size: 2px;
  border-radius: 50%;
  background: currentColor;
}

.child-run-row__label {
  min-inline-size: 0;
  color: var(--ink);
  font-weight: 500;
}

.child-run-row__agent {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
}

.child-run-row__trailing {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
  margin-inline-start: auto;
}

.child-run-row__status {
  color: var(--muted);
  font-size: 11.5px;
}

.child-run-row[data-tone="danger"] .child-run-row__status {
  color: var(--danger);
}

.child-run-row[data-tone="accent"] .child-run-row__status {
  color: var(--accent);
}

.child-run-row__meta {
  color: var(--muted);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.child-run-row__duration {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.child-run-row__chevron {
  flex: none;
  color: var(--muted);
  transition: color var(--motion-fast) ease;
}

.child-run-row:hover .child-run-row__label {
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

.child-run-row:hover .child-run-row__chevron {
  color: var(--ink);
}

@media (min-width: 768px) and (pointer: fine) {
  .child-run-row {
    min-block-size: 24px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .child-run-row__chevron {
    transition: none;
  }
}
</style>
