<script setup lang="ts">
import { formatClockTime } from '@/utils/toolDisplay'

type EntryKind = 'thinking' | 'tool' | 'assistant' | 'terminal'

interface EntryView {
  id: string
  kind: EntryKind
  text: string
  label?: string
  at?: number
}

defineProps<{
  entries: EntryView[]
}>()

const KIND_LABELS: Record<EntryKind, string> = {
  thinking: '思考',
  tool: '工具',
  assistant: '回复',
  terminal: '终端',
}

function kindLabel(kind: EntryKind): string {
  return KIND_LABELS[kind]
}

function timeOf(at: number | undefined): string {
  return formatClockTime(at)
}
</script>

<template>
  <ol class="child-transcript" data-testid="child-transcript">
    <li
      v-for="entry in entries"
      :key="entry.id"
      class="child-transcript__entry"
      :data-kind="entry.kind"
    >
      <div class="child-transcript__head">
        <time v-if="timeOf(entry.at)" class="child-transcript__time">{{ timeOf(entry.at) }}</time>
        <span class="child-transcript__kind">{{ kindLabel(entry.kind) }}</span>
        <span v-if="entry.label" class="child-transcript__label">{{ entry.label }}</span>
      </div>
      <p class="child-transcript__text">{{ entry.text }}</p>
    </li>
  </ol>
</template>

<style scoped>
.child-transcript {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.child-transcript__entry {
  padding-block: var(--space-2);
}

.child-transcript__entry + .child-transcript__entry {
  border-block-start: 1px solid var(--hairline);
}

.child-transcript__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1) var(--space-2);
}

.child-transcript__time,
.child-transcript__kind {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
}

.child-transcript__label {
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.5;
}

.child-transcript__text {
  margin-block-start: var(--space-1);
  color: var(--ink);
  font-size: 12.5px;
  line-height: 1.6;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.child-transcript__entry[data-kind="thinking"] .child-transcript__text {
  color: var(--muted);
}

.child-transcript__entry[data-kind="tool"] .child-transcript__text {
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.55;
}

.child-transcript__entry[data-kind="terminal"] .child-transcript__kind,
.child-transcript__entry[data-kind="terminal"] .child-transcript__text {
  color: var(--muted);
}
</style>
