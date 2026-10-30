<script setup lang="ts">
import { computed } from 'vue'
import type { TurnTerminal, TurnTerminalReason } from '@/types/turn'
import { formatClockTime, formatDurationMs } from '@/utils/toolDisplay'

const props = withDefaults(
  defineProps<{
    terminal: TurnTerminal
    durationMs?: number | null
  }>(),
  {
    durationMs: null,
  },
)

const LABELS: Record<TurnTerminalReason, string> = {
  done: '已完成',
  aborted: '已停止',
  error: '执行失败',
}

const label = computed(() => LABELS[props.terminal.reason])
const tone = computed<'error' | 'warning' | undefined>(() => {
  if (props.terminal.reason === 'error') {
    return 'error'
  }
  if (props.terminal.reason === 'aborted') {
    return 'warning'
  }
  return undefined
})
const durationText = computed(() => formatDurationMs(props.durationMs))
const timeText = computed(() => formatClockTime(props.terminal.at))
</script>

<template>
  <div
    class="terminal-row"
    data-testid="terminal-row"
    :data-reason="terminal.reason"
    :data-tone="tone"
  >
    <span class="terminal-row__label">{{ label }}</span>
    <span
      v-if="durationText"
      class="terminal-row__meta"
    >用时 {{ durationText }}</span>
    <time
      v-if="timeText"
      class="terminal-row__time"
    >{{ timeText }}</time>
  </div>
</template>

<style scoped>
.terminal-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1) var(--space-4);
  padding-block-start: var(--space-2);
  border-block-start: 1px solid var(--hairline);
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
}

.terminal-row__label {
  color: var(--muted);
  font-weight: 600;
}

.terminal-row[data-tone="error"] .terminal-row__label {
  color: var(--danger);
}

.terminal-row[data-tone="warning"] .terminal-row__label {
  color: var(--warning);
}

.terminal-row__meta,
.terminal-row__time {
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
</style>
