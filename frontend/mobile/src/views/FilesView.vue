<template>
  <AppShell title="文件" :meta="headerMeta">
    <template #actions>
      <button
        class="ax-files__refresh"
        type="button"
        aria-label="刷新当前目录"
        @click="refresh"
      >
        <AppIcon name="ArrowClockwise" :size="16" />
      </button>
    </template>

    <div class="ax-files" data-testid="files-page">
      <div v-if="error" class="ax-files__state ax-state" role="alert">
        <h2 class="ax-state__title">加载失败</h2>
        <p class="ax-state__body">{{ error }}</p>
        <button class="ax-state__action" type="button" @click="retry">重试</button>
      </div>

      <div
        v-else-if="initialLoading"
        class="ax-files__state ax-list"
        aria-busy="true"
        aria-label="正在加载文件目录"
      >
        <div v-for="index in 6" :key="index" class="ax-skeleton">
          <span class="skeleton ax-skeleton__line" />
          <span class="skeleton ax-skeleton__line ax-skeleton__line--short" />
        </div>
      </div>

      <template v-else>
        <section class="ax-files__browser" aria-label="文件目录">
          <div class="ax-files__search">
            <AppIcon name="MagnifyingGlass" :size="16" class="ax-files__search-icon" />
            <input
              v-model="searchQuery"
              data-testid="files-search"
              class="ax-files__search-input"
              type="text"
              placeholder="搜索当前目录"
              aria-label="搜索当前目录"
              autocomplete="off"
              @keydown.esc="clearSearch"
            />
            <button
              v-if="searchQuery"
              class="ax-files__search-clear"
              type="button"
              aria-label="清除搜索"
              @click="clearSearch"
            >
              <AppIcon name="X" :size="14" />
            </button>
          </div>

          <nav
            class="ax-files__breadcrumb"
            data-testid="files-breadcrumb"
            aria-label="目录路径"
          >
            <button
              class="ax-files__crumb"
              :class="{ 'ax-files__crumb--current': currentPath === '' }"
              type="button"
              :aria-current="currentPath === '' ? 'page' : undefined"
              @click="goTo('')"
            >
              <AppIcon name="Files" :size="14" />
              <span>{{ rootLabel }}</span>
            </button>
            <template v-for="(segment, index) in pathSegments" :key="`${index}-${segment}`">
              <AppIcon name="CaretRight" :size="10" class="ax-files__crumb-separator" />
              <button
                class="ax-files__crumb"
                :class="{ 'ax-files__crumb--current': index === pathSegments.length - 1 }"
                type="button"
                :aria-current="index === pathSegments.length - 1 ? 'page' : undefined"
                @click="goTo(segmentPath(index))"
              >
                {{ segment }}
              </button>
            </template>
          </nav>

          <div
            v-if="navigationError"
            class="ax-files__nav-error"
            data-testid="files-navigation-error"
            role="alert"
          >
            <AppIcon name="WarningCircle" :size="16" class="ax-files__nav-error-icon" />
            <p class="ax-files__nav-error-body">{{ navigationError }}</p>
            <button
              class="ax-files__nav-error-action"
              type="button"
              @click="retryNavigation"
            >
              重试
            </button>
            <button
              class="ax-files__nav-error-action"
              type="button"
              @click="clearNavigationError"
            >
              关闭
            </button>
          </div>

          <div class="ax-files__body">
            <div
              v-if="isSearching"
              class="ax-files__results"
              role="list"
              aria-label="当前目录搜索结果"
            >
              <div v-if="searchResults.length === 0" class="ax-state ax-files__empty">
                <AppIcon name="MagnifyingGlass" :size="24" />
                <p class="ax-state__body">当前目录没有匹配项</p>
                <button class="ax-state__action" type="button" @click="clearSearch">
                  清除搜索
                </button>
              </div>
              <SearchResultItem
                v-for="row in searchResults"
                :key="row.path"
                :entry="row.entry"
                :path="row.path"
                @click="handleSearchResultClick"
              />
            </div>

            <FileTree
              v-else
              :rows="treeRows"
              :loading="loading"
              :selected-path="selectedPath"
              @select="handleRowSelect"
              @toggle="handleRowToggle"
            />
          </div>
        </section>

        <aside
          v-if="!isMobile"
          class="ax-files__preview"
          data-testid="file-preview"
          aria-label="文件预览"
        >
          <FilePreviewPane
            v-if="selectedFile"
            :path="selectedFile.path"
            :name="selectedFile.entry.name"
            :kind="previewKind"
            @close="closePreview"
          />
          <div v-else class="ax-files__preview-empty">
            <AppIcon name="FileText" :size="24" />
            <p class="ax-files__preview-title">选择文件以预览</p>
            <p class="ax-files__preview-hint">
              支持图片、音频、Markdown、JSON、JSONL 与代码文本
            </p>
          </div>
        </aside>
      </template>
    </div>

    <PreviewOverlay
      v-if="isMobile && selectedFile"
      :visible="previewOpen"
      :path="selectedFile.path"
      :name="selectedFile.entry.name"
      :kind="previewKind"
      @close="closePreview"
    />
  </AppShell>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import AppShell from '@/components/shell/AppShell.vue'
import AppIcon from '@/components/common/AppIcon.vue'
import FileTree from '@/components/files/FileTree.vue'
import SearchResultItem from '@/components/files/SearchResultItem.vue'
import FilePreviewPane from '@/components/files/FilePreviewPane.vue'
import PreviewOverlay from '@/components/files/PreviewOverlay.vue'
import { getFilePreviewKind } from '@/components/files/preview'
import { useFileBrowserSingleton } from '@/composables/useFileBrowser'
import { useMediaQuery } from '@/composables/useMediaQuery'
import type { FileEntry, FilePreviewKind, FileTreeRow } from '@/types/files'

const browser = useFileBrowserSingleton()

const {
  rootLabel,
  currentPath,
  currentCount,
  treeRows,
  searchQuery,
  isSearching,
  searchResults,
  selectedFile,
  loading,
  navigating,
  initialLoading,
  error,
  navigationError,
  pathSegments,
  headerPath,
  retryNavigation,
  clearNavigationError,
} = browser

const isMobile = useMediaQuery('(max-width: 767.98px)')
const previewOpen = ref(false)

const selectedPath = computed(() => selectedFile.value?.path ?? '')

const previewKind = computed<FilePreviewKind>(() => {
  if (!selectedFile.value) return 'unsupported'
  return getFilePreviewKind(selectedFile.value.entry.name)
})

const headerMeta = computed(() => {
  if (error.value) return '加载失败'
  if (initialLoading.value) return '正在加载'
  if (navigating.value || loading.value) {
    return `${headerPath.value} · 正在加载`
  }
  if (isSearching.value) {
    return `${headerPath.value} · ${searchResults.value.length}/${currentCount.value} 项`
  }
  return `${headerPath.value} · ${currentCount.value} 项`
})

function goTo(path: string): void {
  void browser.selectDirectory(path)
}

function segmentPath(index: number): string {
  return pathSegments.value.slice(0, index + 1).join('/')
}

function clearSearch(): void {
  browser.clearSearch()
}

function handleRowSelect(row: FileTreeRow): void {
  if (row.entry.type === 'dir') {
    goTo(row.path)
    return
  }
  openFile(row.entry, row.path)
}

function handleRowToggle(row: FileTreeRow): void {
  void browser.toggleDirectory(row.path)
}

function handleSearchResultClick(entry: FileEntry, path: string): void {
  if (entry.type === 'dir') {
    goTo(path)
    return
  }
  openFile(entry, path)
}

function openFile(entry: FileEntry, path?: string): void {
  const selected = browser.selectFile(entry, path)
  if (!selected) return
  previewOpen.value = true
}

function closePreview(): void {
  previewOpen.value = false
  browser.clearSelection()
}

function retry(): void {
  void browser.reload()
}

function refresh(): void {
  void browser.reload()
}

onMounted(() => {
  void browser.init()
})
</script>

<style scoped>
.ax-files__refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  inline-size: var(--tap);
  block-size: var(--tap);
  border-radius: var(--radius-sm);
  color: var(--muted);
}

.ax-files__refresh:hover {
  background: var(--inset);
  color: var(--ink);
}

.ax-files {
  display: flex;
  flex: 1 0 auto;
  flex-direction: column;
  gap: var(--space-3);
  inline-size: 100%;
  min-block-size: 0;
  max-inline-size: 1100px;
  margin-inline: auto;
  padding: var(--space-3) var(--space-3) var(--space-5);
}

.ax-files__state {
  grid-column: 1 / -1;
  align-items: flex-start;
}

.ax-files__browser {
  display: flex;
  flex-direction: column;
  min-block-size: 0;
}

.ax-files__search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-block-size: var(--tap);
  padding-inline: var(--space-3);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  background: var(--surface);
}

.ax-files__search-icon {
  flex: none;
  color: var(--muted);
}

.ax-files__search-input {
  flex: 1 1 auto;
  min-inline-size: 0;
  border: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: 13.5px;
  outline: none;
}

.ax-files__search-input::placeholder {
  color: var(--muted);
}

.ax-files__search-clear {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  inline-size: var(--tap);
  block-size: var(--tap);
  border-radius: var(--radius-sm);
  color: var(--muted);
}

.ax-files__search-clear:hover {
  background: var(--inset);
  color: var(--ink);
}

.ax-files__breadcrumb {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
  padding-block: var(--space-2);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
}

.ax-files__crumb {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-block-size: 32px;
  padding-inline: var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--muted);
  white-space: nowrap;
}

.ax-files__crumb:hover {
  background: var(--inset);
  color: var(--ink);
}

.ax-files__crumb--current {
  color: var(--ink);
}

.ax-files__crumb-separator {
  flex: none;
  color: var(--muted);
}

.ax-files__nav-error {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-block-end: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--danger) 10%, var(--surface));
  color: var(--danger);
}

.ax-files__nav-error-icon {
  flex: none;
}

.ax-files__nav-error-body {
  flex: 1 1 auto;
  min-inline-size: 0;
  font-size: 12.5px;
  line-height: 1.4;
}

.ax-files__nav-error-action {
  flex: none;
  min-block-size: 32px;
  padding-inline: var(--space-2);
  border-radius: var(--radius-sm);
  color: var(--danger);
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
}

.ax-files__nav-error-action:hover {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
}

.ax-files__body {
  flex: 1 1 auto;
  min-block-size: 0;
}

.ax-files__results {
  display: flex;
  flex-direction: column;
  border-block-start: 1px solid var(--hairline);
}

.ax-files__empty {
  align-items: center;
  padding-block: var(--space-6);
  text-align: center;
}

.ax-files__empty :deep(.icon) {
  color: var(--muted);
}

.ax-files__preview {
  display: none;
}

.ax-files__preview-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  block-size: 100%;
  padding: var(--space-6) var(--space-4);
  color: var(--muted);
  text-align: center;
}

.ax-files__preview-title {
  color: var(--ink);
  font-size: 13.5px;
  font-weight: 500;
}

.ax-files__preview-hint {
  max-inline-size: 30ch;
  font-size: 12px;
  line-height: 1.6;
}

@media (min-width: 768px) {
  .ax-files {
    display: grid;
    flex: 1 1 auto;
    grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
    gap: var(--space-4);
    overflow: hidden;
    padding: var(--space-4) var(--space-5) var(--space-5);
  }

  .ax-files__body {
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .ax-files__preview {
    display: flex;
    flex-direction: column;
    min-block-size: 0;
    padding-inline-start: var(--space-4);
    border-inline-start: 1px solid var(--hairline);
    overflow: hidden;
  }
}
</style>
