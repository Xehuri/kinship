<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { formatClockTime } from '@/utils/toolDisplay'

const props = withDefaults(
  defineProps<{
    label: string
    text: string
    at?: number | null
    source?: string
  }>(),
  {
    at: null,
    source: 'unknown',
  },
)

const expanded = ref(false)
const detailId = `system-event-${useId()}`

const summary = computed(() => {
  const collapsed = props.text.replace(/\s+/g, ' ').trim()
  if (collapsed.length === 0) {
    return '无详情'
  }
  return collapsed.length > 120 ? `${collapsed.slice(0, 120)}…` : collapsed
})
const timeText = computed(() => formatClockTime(props.at))
</script>

<template>
  <div
    class="system-event"
    data-testid="system-event"
    :data-source="source"
  >
    <span class="system-event__label">{{ label }}</span>
    <time
      v-if="timeText"
      class="system-event__time"
    >{{ timeText }}</time>
    <p class="system-event__summary">
      {{ summary }}
    </p>
    <button
      class="system-event__toggle"
      type="button"
      :aria-expanded="expanded ? 'true' : 'false'"
      :aria-controls="detailId"
      @click="expanded = !expanded"
    >
      <AppIcon
        class="system-event__chevron"
        name="CaretRight"
        :size="12"
        weight="bold"
      />
      <span>{{ expanded ? '收起' : '详情' }}</span>
    </button>
    <pre
      v-if="expanded"
      :id="detailId"
      class="system-event__detail"
    >{{ text }}</pre>
  </div>
</template>

<style scoped>
.system-event {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1) var(--space-3);
  min-inline-size: 0;
}

.system-event__label {
  flex: 0 0 auto;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.6;
}

.system-event__time {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1.6;
}

.system-event__summary {
  flex: 1 1 12ch;
  min-inline-size: 0;
  margin: 0;
  overflow: hidden;
  color: var(--ink);
  font-size: 13px;
  line-height: 1.6;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.system-event__toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-block-size: var(--tap);
  padding-inline: var(--space-1);
  color: var(--muted);
  font-size: 12px;
}

.system-event__toggle:hover {
  color: var(--ink);
}

.system-event__chevron {
  transition: transform var(--motion-fast) ease;
}

.system-event__toggle[aria-expanded="true"] .system-event__chevron {
  transform: rotate(90deg);
}

.system-event__detail {
  flex-basis: 100%;
  max-block-size: 280px;
  margin: 0;
  padding: var(--space-2) var(--space-3);
  overflow: auto;
  border-radius: var(--radius-sm);
  background: var(--inset);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.6;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

@media (prefers-reduced-motion: reduce) {
  .system-event__chevron {
    transition: none;
  }
}
</style>
