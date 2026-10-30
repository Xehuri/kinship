<script setup lang="ts">
import { computed } from 'vue'

const LIMIT = 160

const props = defineProps<{
  text: string
}>()

const emit = defineEmits<{ 'open-summary': [] }>()

const collapsed = computed(() => props.text.replace(/\s+/g, ' ').trim())
const truncated = computed(() => collapsed.value.length > LIMIT)
const summary = computed(() => {
  if (collapsed.value.length === 0) {
    return '摘要为空'
  }
  return truncated.value ? `${collapsed.value.slice(0, LIMIT)}…` : collapsed.value
})
</script>

<template>
  <div
    class="compaction"
    data-testid="compaction-divider"
  >
    <div class="compaction__head">
      <span class="compaction__title">上下文已压缩</span>
      <button
        v-if="truncated"
        class="compaction__more"
        type="button"
        @click="emit('open-summary')"
      >
        查看摘要
      </button>
    </div>
    <p
      class="compaction__summary"
      :title="text"
    >
      {{ summary }}
    </p>
  </div>
</template>

<style scoped>
.compaction {
  padding-block-start: var(--space-2);
  border-block-start: 1px solid var(--hairline);
}

.compaction__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.compaction__title {
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
}

.compaction__more {
  min-block-size: var(--tap);
  color: var(--muted);
  font-size: 12px;
}

.compaction__more:hover {
  color: var(--ink);
}

.compaction__summary {
  margin: 0;
  overflow: hidden;
  color: var(--muted);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
