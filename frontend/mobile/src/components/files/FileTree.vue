<template>
  <div
    class="ax-file-tree"
    data-testid="file-tree"
    :aria-busy="loading ? 'true' : undefined"
  >
    <div
      v-if="loading && rows.length === 0"
      class="ax-file-tree__loading"
      aria-label="正在加载目录"
    >
      <div v-for="index in 5" :key="index" class="ax-skeleton">
        <span class="skeleton ax-skeleton__line" />
      </div>
    </div>

    <div v-else-if="rows.length === 0" class="ax-state ax-file-tree__empty">
      <AppIcon name="Folder" :size="24" />
      <p class="ax-state__body">{{ emptyMessage }}</p>
    </div>

    <ul v-else class="ax-file-tree__list" role="tree">
      <FileTreeRowItem
        v-for="row in rows"
        :key="row.path"
        :row="row"
        :selected="selectedPath === row.path"
        @select="emit('select', $event)"
        @toggle="emit('toggle', $event)"
      />
    </ul>
  </div>
</template>

<script setup lang="ts">
import AppIcon from '@/components/common/AppIcon.vue'
import type { FileTreeRow } from '@/types/files'
import FileTreeRowItem from './FileTreeRow.vue'

withDefaults(
  defineProps<{
    rows: FileTreeRow[]
    loading?: boolean
    selectedPath?: string
    emptyMessage?: string
  }>(),
  {
    loading: false,
    selectedPath: '',
    emptyMessage: '当前目录为空',
  },
)

const emit = defineEmits<{
  select: [row: FileTreeRow]
  toggle: [row: FileTreeRow]
}>()
</script>

<style scoped>
.ax-file-tree {
  display: flex;
  flex-direction: column;
  min-block-size: 0;
}

.ax-file-tree__list {
  margin: 0;
  padding: 0;
}

.ax-file-tree__loading {
  display: flex;
  flex-direction: column;
}

.ax-file-tree__empty {
  align-items: center;
  padding-block: var(--space-6);
  text-align: center;
}

.ax-file-tree__empty :deep(.icon) {
  color: var(--muted);
}
</style>
