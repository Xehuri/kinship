/// <reference types="vitest/globals" />

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { computed, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { FileEntry, FileTreeRow, SelectedFile } from '@/types/files'

const mocks = vi.hoisted(() => ({
  browser: null as unknown as Record<string, unknown>,
}))

vi.mock('@/composables/useFileBrowser', () => ({
  useFileBrowserSingleton: () => mocks.browser,
}))

import FilesView from '@/views/FilesView.vue'

const mtime = '2026-10-24T10:00:00'

function dir(name: string): FileEntry {
  return { name, type: 'dir', size: 0, modified_at: mtime }
}

function file(name: string, size = 128): FileEntry {
  return { name, type: 'file', size, modified_at: mtime }
}

function row(entry: FileEntry, path: string, overrides: Partial<FileTreeRow> = {}): FileTreeRow {
  return {
    entry,
    path,
    depth: 0,
    expanded: false,
    loading: false,
    current: false,
    childCount: undefined,
    error: null,
    ...overrides,
  }
}

function createBrowser(initialRows: FileTreeRow[]) {
  const rows = ref<FileTreeRow[]>(initialRows)
  const currentPath = ref('')
  const searchQuery = ref('')
  const selectedFile = ref<SelectedFile | null>(null)
  const loading = ref(false)
  const navigating = ref(false)
  const error = ref<string | null>(null)
  const navigationError = ref<string | null>(null)
  const initialLoading = ref(false)

  const isSearching = computed(() => searchQuery.value.trim().length > 0)
  const searchResults = computed<FileTreeRow[]>(() => {
    const query = searchQuery.value.trim().toLowerCase()
    if (!query) return []
    return rows.value
      .filter((candidate) => candidate.entry.name.toLowerCase().includes(query))
      .map((candidate) => ({ ...candidate, depth: 0, current: false }))
  })
  const headerPath = computed(() =>
    currentPath.value ? `ai/${currentPath.value}` : 'ai/',
  )
  const pathSegments = computed(() =>
    currentPath.value.split('/').filter(Boolean),
  )

  const browser = {
    rootLabel: 'ai',
    currentPath,
    currentCount: computed(() => rows.value.length),
    treeRows: computed(() => rows.value),
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
    init: vi.fn(async () => {}),
    selectDirectory: vi.fn(async (path: string) => {
      currentPath.value = path
    }),
    toggleDirectory: vi.fn(async () => {}),
    selectFile: vi.fn((entry: FileEntry, path?: string) => {
      if (entry.type === 'dir') return null
      const selected: SelectedFile = {
        entry,
        path:
          path ?? (currentPath.value ? `${currentPath.value}/${entry.name}` : entry.name),
      }
      selectedFile.value = selected
      return selected
    }),
    clearSelection: vi.fn(() => {
      selectedFile.value = null
    }),
    clearSearch: vi.fn(() => {
      searchQuery.value = ''
    }),
    reload: vi.fn(async () => {}),
    retryNavigation: vi.fn(async () => {}),
    clearNavigationError: vi.fn(() => {
      navigationError.value = null
    }),
  }

  return {
    browser,
    rows,
    currentPath,
    searchQuery,
    selectedFile,
    loading,
    navigating,
    error,
    navigationError,
    initialLoading,
  }
}

const stubs = {
  AppShell: {
    name: 'AppShell',
    props: ['title', 'meta'],
    template: `
      <div class="shell-stub">
        <span class="shell-title">{{ title }}</span>
        <span class="shell-meta">{{ meta }}</span>
        <slot name="actions" />
        <slot />
      </div>
    `,
  },
  FilePreviewPane: {
    name: 'FilePreviewPane',
    props: ['path', 'name', 'kind'],
    emits: ['close'],
    template: `
      <div class="pane-stub" :data-kind="kind" :data-path="path">
        <button class="pane-close" type="button" @click="$emit('close')">close</button>
      </div>
    `,
  },
  PreviewOverlay: {
    name: 'PreviewOverlay',
    props: ['visible', 'path', 'name', 'kind'],
    template: '<div class="drawer-stub" :data-visible="String(visible)" :data-kind="kind" />',
  },
}

function setViewport(mobile: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: mobile && query.includes('max-width'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
}

const BASE_ROWS = [
  row(dir('daily'), 'daily', { childCount: 2 }),
  row(file('notes.md'), 'notes.md'),
  row(file('photo.png', 2048), 'photo.png'),
]

describe('FilesView', () => {
  beforeEach(() => {
    setViewport(false)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders the v2 shell with real path/count and file testids', async () => {
    const { browser } = createBrowser(BASE_ROWS)
    mocks.browser = browser

    const wrapper = mount(FilesView, { global: { stubs } })
    await flushPromises()

    expect(wrapper.find('.shell-title').text()).toBe('文件')
    expect(wrapper.find('.shell-meta').text()).toBe('ai/ · 3 项')
    expect(wrapper.find('[data-testid="files-page"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-tree"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="files-search"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="files-breadcrumb"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-preview"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="file-tree-row"]')).toHaveLength(3)
    expect(browser.init).toHaveBeenCalledTimes(1)
  })

  it('navigates into a folder row without opening a preview', async () => {
    const { browser } = createBrowser(BASE_ROWS)
    mocks.browser = browser

    const wrapper = mount(FilesView, { global: { stubs } })
    await flushPromises()

    await wrapper.findAll('.ax-file-row__main')[0].trigger('click')

    expect(browser.selectDirectory).toHaveBeenCalledWith('daily')
    expect(wrapper.find('.pane-stub').exists()).toBe(false)
  })

  it('opens the dispatched preview when a file row is selected', async () => {
    const { browser } = createBrowser(BASE_ROWS)
    mocks.browser = browser

    const wrapper = mount(FilesView, { global: { stubs } })
    await flushPromises()

    await wrapper.findAll('.ax-file-row__main')[1].trigger('click')

    const pane = wrapper.find('.pane-stub')
    expect(pane.exists()).toBe(true)
    expect(pane.attributes('data-kind')).toBe('md')
    expect(pane.attributes('data-path')).toBe('notes.md')
    expect(browser.selectFile).toHaveBeenCalledWith(BASE_ROWS[1].entry, 'notes.md')

    await wrapper.findAll('.ax-file-row__main')[2].trigger('click')

    expect(wrapper.find('.pane-stub').attributes('data-kind')).toBe('image')
  })

  it('passes the row full path even when the current directory is elsewhere', async () => {
    const nestedRows = [
      row(dir('data'), 'data'),
      row(file('opencode.json'), 'opencode.json'),
    ]
    const { browser, currentPath } = createBrowser(nestedRows)
    mocks.browser = browser
    currentPath.value = 'data'

    const wrapper = mount(FilesView, { global: { stubs } })
    await flushPromises()

    await wrapper.findAll('.ax-file-row__main')[1].trigger('click')

    expect(browser.selectFile).toHaveBeenCalledWith(
      nestedRows[1].entry,
      'opencode.json',
    )
    expect(wrapper.find('.pane-stub').attributes('data-path')).toBe('opencode.json')
  })

  it('passes the search result path when opening a file', async () => {
    const { browser } = createBrowser(BASE_ROWS)
    mocks.browser = browser

    const wrapper = mount(FilesView, { global: { stubs } })
    await flushPromises()

    await wrapper.find('[data-testid="files-search"]').setValue('notes')
    await wrapper.find('[data-testid="file-search-result"]').trigger('click')

    expect(browser.selectFile).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'notes.md' }),
      'notes.md',
    )
    expect(wrapper.find('.pane-stub').attributes('data-path')).toBe('notes.md')
  })

  it('closes the inline preview and clears the selection', async () => {
    const { browser } = createBrowser(BASE_ROWS)
    mocks.browser = browser

    const wrapper = mount(FilesView, { global: { stubs } })
    await flushPromises()

    await wrapper.findAll('.ax-file-row__main')[1].trigger('click')
    await wrapper.find('.pane-close').trigger('click')

    expect(browser.clearSelection).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.pane-stub').exists()).toBe(false)
  })

  it('searches the current directory, shows result rows, and clears', async () => {
    const { browser } = createBrowser(BASE_ROWS)
    mocks.browser = browser

    const wrapper = mount(FilesView, { global: { stubs } })
    await flushPromises()

    await wrapper.find('[data-testid="files-search"]').setValue('notes')

    expect(wrapper.findAll('[data-testid="file-search-result"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="file-tree"]').exists()).toBe(false)
    expect(wrapper.find('.shell-meta').text()).toBe('ai/ · 1/3 项')

    await wrapper.find('[aria-label="清除搜索"]').trigger('click')

    expect(browser.clearSearch).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('[data-testid="file-tree-row"]')).toHaveLength(3)
  })

  it('shows a search empty state that clears the query', async () => {
    const { browser } = createBrowser(BASE_ROWS)
    mocks.browser = browser

    const wrapper = mount(FilesView, { global: { stubs } })
    await flushPromises()

    await wrapper.find('[data-testid="files-search"]').setValue('zzz')

    expect(wrapper.text()).toContain('当前目录没有匹配项')
    await wrapper.find('.ax-state__action').trigger('click')

    expect(browser.clearSearch).toHaveBeenCalledTimes(1)
  })

  it('navigates through breadcrumb segments', async () => {
    const { browser, currentPath } = createBrowser(BASE_ROWS)
    mocks.browser = browser
    currentPath.value = 'daily/sub'
    browser.selectDirectory.mockClear()

    const wrapper = mount(FilesView, { global: { stubs } })
    await flushPromises()

    const crumbs = wrapper.findAll('.ax-files__crumb')
    expect(crumbs.map((crumb) => crumb.text())).toEqual(['ai', 'daily', 'sub'])

    await crumbs[1].trigger('click')
    await crumbs[0].trigger('click')

    expect(browser.selectDirectory).toHaveBeenNthCalledWith(1, 'daily')
    expect(browser.selectDirectory).toHaveBeenNthCalledWith(2, '')
  })

  it('uses the preview drawer on mobile and opens it on file selection', async () => {
    setViewport(true)
    const { browser } = createBrowser(BASE_ROWS)
    mocks.browser = browser

    const wrapper = mount(FilesView, { global: { stubs } })
    await flushPromises()

    expect(wrapper.find('[data-testid="file-preview"]').exists()).toBe(false)

    await wrapper.findAll('.ax-file-row__main')[1].trigger('click')

    const drawer = wrapper.find('.drawer-stub')
    expect(drawer.exists()).toBe(true)
    expect(drawer.attributes('data-visible')).toBe('true')
    expect(drawer.attributes('data-kind')).toBe('md')
  })

  it('renders the loading skeleton before the first directory load', () => {
    const { browser, initialLoading } = createBrowser(BASE_ROWS)
    mocks.browser = browser
    initialLoading.value = true

    const wrapper = mount(FilesView, { global: { stubs } })

    expect(wrapper.find('[aria-label="正在加载文件目录"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="file-tree"]').exists()).toBe(false)
  })

  it('keeps tree rows mounted and shows navigating in the header', async () => {
    const { browser, navigating } = createBrowser(BASE_ROWS)
    mocks.browser = browser

    const wrapper = mount(FilesView, { global: { stubs } })
    await flushPromises()
    navigating.value = true
    await flushPromises()

    expect(wrapper.find('.shell-meta').text()).toBe('ai/ · 正在加载')
    expect(wrapper.findAll('[data-testid="file-tree-row"]')).toHaveLength(3)
    expect(wrapper.find('.ax-file-tree__loading').exists()).toBe(false)
  })

  it('shows an inline navigation error with retry and dismiss actions', async () => {
    const { browser, navigationError } = createBrowser(BASE_ROWS)
    mocks.browser = browser

    const wrapper = mount(FilesView, { global: { stubs } })
    await flushPromises()

    navigationError.value = '加载目录失败'
    await flushPromises()

    const banner = wrapper.find('[data-testid="files-navigation-error"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('加载目录失败')
    expect(wrapper.findAll('[data-testid="file-tree-row"]')).toHaveLength(3)

    await banner.findAll('.ax-files__nav-error-action')[0].trigger('click')

    expect(browser.retryNavigation).toHaveBeenCalledTimes(1)

    await banner.findAll('.ax-files__nav-error-action')[1].trigger('click')

    expect(browser.clearNavigationError).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="files-navigation-error"]').exists()).toBe(false)
  })

  it('renders the error state and retries through reload', async () => {
    const { browser, error } = createBrowser(BASE_ROWS)
    mocks.browser = browser
    error.value = '加载目录失败'

    const wrapper = mount(FilesView, { global: { stubs } })
    await flushPromises()

    expect(wrapper.find('[role="alert"]').text()).toContain('加载失败')
    expect(wrapper.find('.shell-meta').text()).toBe('加载失败')

    await wrapper.find('.ax-state__action').trigger('click')

    expect(browser.reload).toHaveBeenCalledTimes(1)
  })
})
