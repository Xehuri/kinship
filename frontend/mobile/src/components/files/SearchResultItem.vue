<template>
  <button
    class="ax-search-row"
    type="button"
    data-testid="file-search-result"
    @click="emit('click', entry, path)"
  >
    <AppIcon :name="iconName" :size="16" class="ax-search-row__icon" />
    <span class="ax-search-row__body">
      <span class="ax-search-row__name">{{ entry.name }}</span>
      <span class="ax-search-row__path">{{ displayPath }}</span>
    </span>
    <span
      v-if="entry.type !== 'dir' && entry.size != null"
      class="ax-search-row__meta"
    >
      {{ formatSize(entry.size) }}
    </span>
    <span v-if="entry.modified_at" class="ax-search-row__meta">
      {{ formatDate(entry.modified_at) }}
    </span>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { formatDate, formatSize } from '@/utils/format'
import type { FileEntry } from '@/types/files'
import { getFileIconName, getFilePreviewKind } from './preview'

const props = defineProps<{
  entry: FileEntry
  path: string
}>()

const emit = defineEmits<{
  click: [entry: FileEntry, path: string]
}>()

const iconName = computed(() =>
  getFileIconName(
    getFilePreviewKind(props.entry.name),
    props.entry.type === 'dir',
  ),
)

const displayPath = computed(() => {
  if (!props.path) return 'ai/'
  const parts = props.path.split('/')
  parts.pop()
  return parts.length ? `ai/${parts.join('/')}` : 'ai/'
})
</script>

<style scoped>
.ax-search-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  inline-size: 100%;
  min-block-size: var(--tap);
  padding: var(--space-1) var(--space-2);
  border: 0;
  border-block-end: 1px solid var(--hairline);
  background: none;
  color: var(--ink);
  font: inherit;
  text-align: start;
  cursor: pointer;
}

.ax-search-row:hover {
  background: var(--inset);
}

.ax-search-row__icon {
  flex: none;
  color: var(--muted);
}

.ax-search-row__body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-inline-size: 0;
}

.ax-search-row__name {
  overflow: hidden;
  font-size: 13.5px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ax-search-row__path {
  overflow: hidden;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ax-search-row__meta {
  flex: none;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
