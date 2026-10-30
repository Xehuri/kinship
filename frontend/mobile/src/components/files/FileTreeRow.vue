<template>
  <li
    class="ax-file-row"
    role="treeitem"
    :aria-expanded="isDirectory ? row.expanded : undefined"
    :aria-selected="selected || row.current"
    data-testid="file-tree-row"
  >
    <div
      class="ax-file-row__inner"
      :class="{
        'ax-file-row__inner--current': row.current,
        'ax-file-row__inner--selected': selected,
      }"
      :style="{ paddingInlineStart: `calc(${row.depth} * var(--space-4))` }"
    >
      <button class="ax-file-row__main" type="button" @click="emit('select', row)">
        <AppIcon :name="iconName" :size="16" class="ax-file-row__icon" />
        <span class="ax-file-row__name">{{ row.entry.name }}</span>
        <span class="ax-file-row__meta">
          <span v-if="row.error" class="ax-file-row__error">加载失败</span>
          <span v-else-if="isDirectory">
            {{
              row.loading
                ? '加载中'
                : row.childCount == null
                  ? '—'
                  : `${row.childCount} 项`
            }}
          </span>
          <template v-else>
            <span v-if="row.entry.size != null" class="ax-file-row__size">
              {{ formatSize(row.entry.size) }}
            </span>
            <span v-if="row.entry.modified_at" class="ax-file-row__date">
              {{ formatDate(row.entry.modified_at) }}
            </span>
          </template>
        </span>
      </button>

      <button
        v-if="isDirectory"
        class="ax-file-row__toggle"
        type="button"
        :aria-label="row.expanded ? '收起目录' : '展开目录'"
        :aria-expanded="row.expanded"
        @click.stop="emit('toggle', row)"
      >
        <AppIcon :name="row.expanded ? 'CaretDown' : 'CaretRight'" :size="12" />
      </button>
    </div>
  </li>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '@/components/common/AppIcon.vue'
import { formatDate, formatSize } from '@/utils/format'
import type { FileTreeRow } from '@/types/files'
import { getFileIconName, getFilePreviewKind } from './preview'

const props = defineProps<{
  row: FileTreeRow
  selected: boolean
}>()

const emit = defineEmits<{
  select: [row: FileTreeRow]
  toggle: [row: FileTreeRow]
}>()

const isDirectory = computed(() => props.row.entry.type === 'dir')

const iconName = computed(() =>
  getFileIconName(getFilePreviewKind(props.row.entry.name), isDirectory.value),
)
</script>

<style scoped>
.ax-file-row {
  list-style: none;
}

.ax-file-row__inner {
  display: flex;
  align-items: center;
  min-inline-size: 0;
  border-block-end: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
}

.ax-file-row__inner:hover {
  background: color-mix(in srgb, var(--inset) 72%, transparent);
}

.ax-file-row__inner--current {
  background: var(--inset);
}

.ax-file-row__inner--selected {
  background: var(--accent-soft);
}

.ax-file-row__main {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: var(--space-2);
  min-inline-size: 0;
  min-block-size: var(--tap);
  padding: var(--space-1) var(--space-2);
  border: 0;
  background: none;
  color: var(--ink);
  font: inherit;
  text-align: start;
  cursor: pointer;
}

.ax-file-row__icon {
  color: var(--muted);
}

.ax-file-row__name {
  flex: 1 1 auto;
  overflow: hidden;
  font-size: 13.5px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ax-file-row__meta {
  display: flex;
  flex: none;
  align-items: center;
  gap: var(--space-2);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.ax-file-row__error {
  color: var(--danger);
}

.ax-file-row__date {
  min-inline-size: 52px;
  text-align: end;
}

.ax-file-row__toggle {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  inline-size: var(--tap);
  block-size: var(--tap);
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--muted);
  font: inherit;
  cursor: pointer;
}

.ax-file-row__toggle:hover {
  background: var(--inset);
  color: var(--ink);
}
</style>
