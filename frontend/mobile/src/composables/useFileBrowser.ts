/**
 * 文件浏览器 Composable — 懒加载目录树、当前目录搜索与文件选择
 *
 * 设计:
 *   - 目录按需加载 (打开/展开时才请求 API), 未展开目录不产生网络请求
 *   - 当前目录的直属条目用于搜索, 不在整个子树里递归搜索
 *   - 选中文件只记录路径, 内容加载与类型分发由预览组件负责
 */

import { computed, readonly, ref, type ComputedRef, type Ref } from 'vue'
import type { FileEntry, FileTreeRow, SelectedFile } from '@/types/files'
import { fetchDirectory } from '@/api/files'

/** scope 根目录显示名 (后端 scope=root 对应 ai/) */
const ROOT_LABEL = 'ai'

/** 目录树节点 */
export interface FileTreeNode {
  name: string
  /** 相对 scope 根目录的路径, 根节点为 '' */
  path: string
  type: 'dir' | 'file'
  size?: number
  modified_at?: string
  children: FileTreeNode[] | null
  loaded: boolean
  loading: boolean
  error: string | null
  expanded: boolean
  pending: Promise<boolean> | null
}

/** useFileBrowser 返回值 */
export interface UseFileBrowserReturn {
  rootLabel: string
  root: Ref<FileTreeNode>
  currentPath: Ref<string>
  currentEntries: ComputedRef<FileEntry[]>
  currentCount: ComputedRef<number>
  treeRows: ComputedRef<FileTreeRow[]>
  displayRows: ComputedRef<FileTreeRow[]>
  searchQuery: Ref<string>
  isSearching: ComputedRef<boolean>
  searchResults: ComputedRef<FileTreeRow[]>
  selectedFile: Ref<SelectedFile | null>
  /** 整页级加载 (仅 init / reload), 用于树骨架屏 */
  loading: Readonly<Ref<boolean>>
  /** 目录导航进行中 (不触发布局替换) */
  navigating: Readonly<Ref<boolean>>
  initialLoading: ComputedRef<boolean>
  error: Readonly<Ref<string | null>>
  /** 目录导航/刷新失败 (保留旧树, 内联提示) */
  navigationError: Readonly<Ref<string | null>>
  pathSegments: ComputedRef<string[]>
  headerPath: ComputedRef<string>
  init: () => Promise<void>
  selectDirectory: (path: string) => Promise<void>
  toggleDirectory: (path: string) => Promise<void>
  selectFile: (entry: FileEntry, path?: string) => SelectedFile | null
  clearSelection: () => void
  setSearchQuery: (query: string) => void
  clearSearch: () => void
  reload: () => Promise<void>
  retryNavigation: () => Promise<void>
  clearNavigationError: () => void
}

function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

function toEntry(node: FileTreeNode): FileEntry {
  return {
    name: node.name,
    type: node.type,
    size: node.size,
    modified_at: node.modified_at,
  }
}

function createNode(entry: FileEntry, path: string): FileTreeNode {
  return {
    name: entry.name,
    path,
    type: entry.type,
    size: entry.size,
    modified_at: entry.modified_at,
    children: null,
    loaded: false,
    loading: false,
    error: null,
    expanded: false,
    pending: null,
  }
}

function findNode(node: FileTreeNode, path: string): FileTreeNode | null {
  if (node.path === path) return node
  if (node.type !== 'dir' || !node.children) return null

  for (const child of node.children) {
    if (child.path === path) return child
    if (child.type === 'dir' && path.startsWith(`${child.path}/`)) {
      const found = findNode(child, path)
      if (found) return found
    }
  }
  return null
}

function collectRows(
  node: FileTreeNode,
  depth: number,
  currentPath: string,
  rows: FileTreeRow[],
): void {
  if (node.type !== 'dir' || !node.children) return

  for (const child of node.children) {
    rows.push({
      entry: toEntry(child),
      path: child.path,
      depth,
      expanded: child.expanded,
      loading: child.loading,
      current: child.type === 'dir' && child.path === currentPath,
      childCount:
        child.type === 'dir' && child.loaded
          ? (child.children?.length ?? 0)
          : undefined,
      error: child.error,
    })

    if (child.type === 'dir' && child.expanded) {
      collectRows(child, depth + 1, currentPath, rows)
    }
  }
}

export function useFileBrowser(): UseFileBrowserReturn {
  const root = ref<FileTreeNode>({
    name: ROOT_LABEL,
    path: '',
    type: 'dir',
    children: null,
    loaded: false,
    loading: false,
    error: null,
    expanded: true,
    pending: null,
  })

  const currentPath = ref('')
  const searchQuery = ref('')
  const selectedFile = ref<SelectedFile | null>(null)
  const loading = ref(false)
  const navigating = ref(false)
  const error = ref<string | null>(null)
  const navigationError = ref<string | null>(null)

  let selectSeq = 0
  let pendingNavigation: string | null = null
  let pendingReload = false

  function mergeChildren(
    node: FileTreeNode,
    entries: FileEntry[],
  ): FileTreeNode[] {
    const previous = new Map(
      (node.children ?? []).map((child) => [child.path, child]),
    )

    return entries.map((entry) => {
      const path = joinPath(node.path, entry.name)
      const existing = previous.get(path)
      if (!existing) return createNode(entry, path)

      if (existing.type !== entry.type) {
        existing.children = null
        existing.loaded = false
        existing.expanded = false
        existing.pending = null
      }
      existing.name = entry.name
      existing.type = entry.type
      existing.size = entry.size
      existing.modified_at = entry.modified_at
      existing.error = null
      return existing
    })
  }

  function loadNode(node: FileTreeNode): Promise<boolean> {
    if (node.type !== 'dir') return Promise.resolve(false)
    if (node.pending) return node.pending

    node.loading = true
    node.error = null

    const pending = (async (): Promise<boolean> => {
      try {
        const result = await fetchDirectory(node.path)
        if (!result) {
          node.error = '加载目录失败'
          return false
        }

        node.children = mergeChildren(node, result.entries)
        node.loaded = true
        return true
      } catch (e) {
        node.error = e instanceof Error ? e.message : '加载目录失败'
        return false
      }
    })()

    node.pending = pending
    void pending.finally(() => {
      node.pending = null
      node.loading = false
    })
    return pending
  }

  interface EnsureDirectoryResult {
    node: FileTreeNode | null
    error: string | null
  }

  async function ensureDirectory(path: string): Promise<EnsureDirectoryResult> {
    let node = root.value

    if (!node.loaded) {
      const ok = await loadNode(node)
      if (!ok) return { node: null, error: node.error ?? '加载目录失败' }
    }

    const target = normalizePath(path)
    if (!target) return { node, error: null }

    for (const segment of target.split('/').filter(Boolean)) {
      node.expanded = true
      if (!node.loaded) {
        const ok = await loadNode(node)
        if (!ok) return { node: null, error: node.error ?? '加载目录失败' }
      }

      const next =
        node.children?.find(
          (child) => child.name === segment && child.type === 'dir',
        ) ?? null
      if (!next) {
        return { node: null, error: `目录不存在：${target}` }
      }
      node = next
    }

    return { node, error: null }
  }

  async function init(): Promise<void> {
    if (root.value.loaded) return

    loading.value = true
    error.value = null
    const ok = await loadNode(root.value)
    if (ok) {
      root.value.expanded = true
      error.value = null
    } else {
      error.value = root.value.error ?? '加载目录失败'
    }
    loading.value = false
  }

  async function selectDirectory(path: string): Promise<void> {
    const target = normalizePath(path)
    const seq = ++selectSeq
    pendingNavigation = target
    pendingReload = false

    navigating.value = true
    loading.value = false
    navigationError.value = null

    const ensured = await ensureDirectory(target)
    if (seq !== selectSeq) return

    if (!ensured.node) {
      navigationError.value = ensured.error ?? '目录不可用'
      navigating.value = false
      return
    }

    const node = ensured.node
    node.expanded = true
    if (!node.loaded) {
      const ok = await loadNode(node)
      if (seq !== selectSeq) return
      if (!ok) {
        navigationError.value = node.error ?? '加载目录失败'
        navigating.value = false
        return
      }
    }

    currentPath.value = node.path
    error.value = null
    navigationError.value = null
    pendingNavigation = null
    navigating.value = false
  }

  async function toggleDirectory(path: string): Promise<void> {
    const node = findNode(root.value, normalizePath(path))
    if (!node || node.type !== 'dir') return

    if (node.expanded) {
      node.expanded = false
      return
    }

    node.expanded = true
    if (!node.loaded) {
      await loadNode(node)
    }
  }

  function selectFile(entry: FileEntry, path?: string): SelectedFile | null {
    if (entry.type === 'dir') return null
    const selected: SelectedFile = {
      entry,
      path:
        path === undefined
          ? joinPath(currentPath.value, entry.name)
          : normalizePath(path),
    }
    selectedFile.value = selected
    return selected
  }

  function clearSelection(): void {
    selectedFile.value = null
  }

  function setSearchQuery(query: string): void {
    searchQuery.value = query
  }

  function clearSearch(): void {
    searchQuery.value = ''
  }

  async function reload(): Promise<void> {
    const target = normalizePath(currentPath.value)
    const node = findNode(root.value, target) ?? root.value
    const seq = ++selectSeq
    pendingNavigation = target
    pendingReload = false

    navigating.value = false
    navigationError.value = null
    loading.value = true

    const ok = await loadNode(node)
    if (seq !== selectSeq) return
    loading.value = false

    if (!ok) {
      navigationError.value = node.error ?? '加载目录失败'
      pendingReload = true
      if (!root.value.loaded) error.value = navigationError.value
      return
    }

    node.expanded = true
    error.value = null
    navigationError.value = null
    pendingNavigation = null
  }

  async function retryNavigation(): Promise<void> {
    if (pendingReload) {
      await reload()
      return
    }
    await selectDirectory(pendingNavigation ?? currentPath.value)
  }

  function clearNavigationError(): void {
    navigationError.value = null
    pendingNavigation = null
    pendingReload = false
  }

  const currentNode = computed<FileTreeNode>(() => {
    return findNode(root.value, currentPath.value) ?? root.value
  })

  const currentEntries = computed<FileEntry[]>(() => {
    const children = currentNode.value.children
    return children ? children.map(toEntry) : []
  })

  const currentCount = computed(() => currentEntries.value.length)

  const treeRows = computed<FileTreeRow[]>(() => {
    const rows: FileTreeRow[] = []
    collectRows(root.value, 0, currentPath.value, rows)
    return rows
  })

  const isSearching = computed(() => searchQuery.value.trim().length > 0)

  const searchResults = computed<FileTreeRow[]>(() => {
    const query = searchQuery.value.trim().toLowerCase()
    if (!query) return []

    return currentEntries.value
      .filter((entry) => entry.name.toLowerCase().includes(query))
      .map((entry) => ({
        entry,
        path: joinPath(currentPath.value, entry.name),
        depth: 0,
        expanded: false,
        loading: false,
        current: false,
        childCount: undefined,
        error: null,
      }))
  })

  const displayRows = computed<FileTreeRow[]>(() =>
    isSearching.value ? searchResults.value : treeRows.value,
  )

  const initialLoading = computed(() => loading.value && !root.value.loaded)

  const pathSegments = computed(() =>
    currentPath.value.split('/').filter(Boolean),
  )

  const headerPath = computed(() =>
    currentPath.value ? `${ROOT_LABEL}/${currentPath.value}` : `${ROOT_LABEL}/`,
  )

  return {
    rootLabel: ROOT_LABEL,
    root,
    currentPath,
    currentEntries,
    currentCount,
    treeRows,
    displayRows,
    searchQuery,
    isSearching,
    searchResults,
    selectedFile,
    loading: readonly(loading),
    navigating: readonly(navigating),
    initialLoading,
    error: readonly(error),
    navigationError: readonly(navigationError),
    pathSegments,
    headerPath,
    init,
    selectDirectory,
    toggleDirectory,
    selectFile,
    clearSelection,
    setSearchQuery,
    clearSearch,
    reload,
    retryNavigation,
    clearNavigationError,
  }
}

let _singleton: UseFileBrowserReturn | null = null

/** 全局单例 useFileBrowser (跨组件共享同一个文件浏览状态) */
export function useFileBrowserSingleton(): UseFileBrowserReturn {
  if (!_singleton) {
    _singleton = useFileBrowser()
  }
  return _singleton
}
