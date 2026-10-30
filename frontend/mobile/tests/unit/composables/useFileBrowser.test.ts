/// <reference types="vitest/globals" />

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { FileEntry } from '@/types/files'

const mockFetchDirectory = vi.hoisted(() => vi.fn())

vi.mock('@/api/files', () => ({
  fetchDirectory: mockFetchDirectory,
}))

import { useFileBrowser } from '@/composables/useFileBrowser'

const mtime = '2026-10-24T10:00:00'

function dir(name: string): FileEntry {
  return { name, type: 'dir', size: 0, modified_at: mtime }
}

function file(name: string, size = 128): FileEntry {
  return { name, type: 'file', size, modified_at: mtime }
}

function mockTree(): void {
  mockFetchDirectory.mockImplementation(async (path: string) => {
    if (path === '') {
      return { entries: [dir('daily'), file('notes.md'), file('image.png', 2048)] }
    }
    if (path === 'daily') {
      return { entries: [dir('sub'), file('perception.jsonl', 4096)] }
    }
    if (path === 'daily/sub') {
      return { entries: [file('deep.md')] }
    }
    return { entries: [] }
  })
}

describe('useFileBrowser', () => {
  beforeEach(() => {
    mockFetchDirectory.mockReset()
    mockTree()
  })

  it('loads the root once and derives tree rows from real entries', async () => {
    const browser = useFileBrowser()

    await browser.init()

    expect(mockFetchDirectory).toHaveBeenCalledTimes(1)
    expect(mockFetchDirectory).toHaveBeenCalledWith('')
    expect(browser.currentPath.value).toBe('')
    expect(browser.currentCount.value).toBe(3)
    expect(browser.headerPath.value).toBe('ai/')
    expect(browser.treeRows.value.map((row) => row.entry.name)).toEqual([
      'daily',
      'notes.md',
      'image.png',
    ])
    expect(browser.treeRows.value[0].childCount).toBeUndefined()
  })

  it('loads a directory subtree lazily only when it is expanded', async () => {
    const browser = useFileBrowser()
    await browser.init()

    await browser.toggleDirectory('daily')

    expect(mockFetchDirectory).toHaveBeenCalledTimes(2)
    expect(mockFetchDirectory).toHaveBeenCalledWith('daily')
    expect(mockFetchDirectory).not.toHaveBeenCalledWith('daily/sub')
    expect(browser.treeRows.value.map((row) => row.entry.name)).toEqual([
      'daily',
      'sub',
      'perception.jsonl',
      'notes.md',
      'image.png',
    ])
    expect(browser.treeRows.value.find((row) => row.entry.name === 'sub')?.depth).toBe(1)

    await browser.toggleDirectory('daily')

    expect(browser.treeRows.value.map((row) => row.entry.name)).toEqual([
      'daily',
      'notes.md',
      'image.png',
    ])
    expect(mockFetchDirectory).toHaveBeenCalledTimes(2)
  })

  it('selects a directory, loads it lazily, and exposes breadcrumb segments', async () => {
    const browser = useFileBrowser()
    await browser.init()

    await browser.selectDirectory('daily/sub')

    expect(mockFetchDirectory.mock.calls.map((call) => call[0])).toEqual([
      '',
      'daily',
      'daily/sub',
    ])
    expect(browser.currentPath.value).toBe('daily/sub')
    expect(browser.currentCount.value).toBe(1)
    expect(browser.currentEntries.value[0].name).toBe('deep.md')
    expect(browser.pathSegments.value).toEqual(['daily', 'sub'])
    expect(browser.headerPath.value).toBe('ai/daily/sub')
    expect(
      browser.treeRows.value.find((row) => row.path === 'daily/sub')?.current,
    ).toBe(true)
  })

  it('searches only the current directory and clears back to the tree', async () => {
    const browser = useFileBrowser()
    await browser.init()

    browser.setSearchQuery('notes')

    expect(browser.isSearching.value).toBe(true)
    expect(browser.searchResults.value.map((row) => row.path)).toEqual(['notes.md'])
    expect(browser.displayRows.value.map((row) => row.entry.name)).toEqual(['notes.md'])

    browser.setSearchQuery('deep')

    expect(browser.searchResults.value).toEqual([])

    browser.clearSearch()

    expect(browser.isSearching.value).toBe(false)
    expect(browser.displayRows.value).toHaveLength(3)
  })

  it('keeps the search query and selection when navigating another directory', async () => {
    const browser = useFileBrowser()
    await browser.init()
    await browser.selectDirectory('daily')
    const entry = browser.currentEntries.value.find(
      (candidate) => candidate.name === 'perception.jsonl',
    )!
    browser.selectFile(entry, 'daily/perception.jsonl')
    browser.setSearchQuery('perception')

    await browser.selectDirectory('daily/sub')

    expect(browser.currentPath.value).toBe('daily/sub')
    expect(browser.searchQuery.value).toBe('perception')
    expect(browser.selectedFile.value?.path).toBe('daily/perception.jsonl')
  })

  it('selects files by explicit full path and falls back to the current directory', async () => {
    const browser = useFileBrowser()
    await browser.init()
    await browser.selectDirectory('daily')

    const entry = browser.currentEntries.value.find(
      (candidate) => candidate.name === 'perception.jsonl',
    )!
    const explicit = browser.selectFile(entry, 'daily/perception.jsonl')
    expect(explicit?.path).toBe('daily/perception.jsonl')

    const fallback = browser.selectFile(entry)
    expect(fallback?.path).toBe('daily/perception.jsonl')

    const rootEntry = file('opencode.json')
    browser.selectFile(rootEntry, 'opencode.json')
    expect(browser.selectedFile.value?.path).toBe('opencode.json')

    expect(browser.selectFile(dir('sub'))).toBeNull()

    browser.clearSelection()
    expect(browser.selectedFile.value).toBeNull()
  })

  it('keeps the old path and rows and reports an inline error when navigation fails', async () => {
    const browser = useFileBrowser()
    await browser.init()
    const before = browser.treeRows.value.map((row) => row.path)

    mockFetchDirectory.mockRejectedValueOnce(new Error('network down'))
    const navigation = browser.selectDirectory('daily')

    expect(browser.navigating.value).toBe(true)
    await navigation

    expect(browser.navigating.value).toBe(false)
    expect(browser.currentPath.value).toBe('')
    expect(browser.navigationError.value).toBe('network down')
    expect(browser.error.value).toBeNull()
    expect(browser.treeRows.value.map((row) => row.path)).toEqual(before)

    mockFetchDirectory.mockResolvedValueOnce({
      entries: [dir('sub'), file('perception.jsonl', 4096)],
    })
    await browser.retryNavigation()

    expect(browser.navigationError.value).toBeNull()
    expect(browser.currentPath.value).toBe('daily')
    expect(browser.currentEntries.value[0].name).toBe('sub')
  })

  it('keeps expanded children when a directory refresh fails', async () => {
    const browser = useFileBrowser()
    await browser.init()
    await browser.toggleDirectory('daily')
    await browser.toggleDirectory('daily/sub')
    await browser.selectDirectory('daily')
    browser.selectFile(file('perception.jsonl'), 'daily/perception.jsonl')
    const before = browser.treeRows.value.map((row) => row.path)

    mockFetchDirectory.mockRejectedValueOnce(new Error('network down'))
    await browser.reload()

    expect(browser.navigationError.value).toBe('network down')
    expect(browser.currentPath.value).toBe('daily')
    expect(browser.selectedFile.value?.path).toBe('daily/perception.jsonl')
    expect(browser.treeRows.value.map((row) => row.path)).toEqual(before)
    expect(browser.treeRows.value.find((row) => row.path === 'daily/sub')?.expanded).toBe(
      true,
    )
  })

  it('reloads the current node without wiping expanded subtrees or selection', async () => {
    const browser = useFileBrowser()
    await browser.init()
    await browser.toggleDirectory('daily')
    await browser.toggleDirectory('daily/sub')
    await browser.selectDirectory('daily')
    browser.selectFile(file('perception.jsonl'), 'daily/perception.jsonl')

    mockFetchDirectory.mockResolvedValueOnce({
      entries: [dir('sub'), file('perception.jsonl', 8192), file('fresh.md')],
    })
    await browser.reload()

    expect(mockFetchDirectory).toHaveBeenCalledWith('daily')
    expect(browser.currentPath.value).toBe('daily')
    expect(browser.selectedFile.value?.path).toBe('daily/perception.jsonl')
    expect(browser.navigationError.value).toBeNull()
    expect(browser.treeRows.value.map((row) => row.path)).toEqual([
      'daily',
      'daily/sub',
      'daily/sub/deep.md',
      'daily/perception.jsonl',
      'daily/fresh.md',
      'notes.md',
      'image.png',
    ])
  })

  it('clears the inline navigation error on demand', async () => {
    const browser = useFileBrowser()
    await browser.init()

    mockFetchDirectory.mockRejectedValueOnce(new Error('network down'))
    await browser.selectDirectory('daily')

    expect(browser.navigationError.value).toBe('network down')

    browser.clearNavigationError()

    expect(browser.navigationError.value).toBeNull()
    expect(browser.currentPath.value).toBe('')
  })

  it('surfaces a root load error and can retry through reload', async () => {
    const browser = useFileBrowser()
    mockFetchDirectory.mockResolvedValueOnce(null)

    await browser.init()

    expect(browser.error.value).toBe('加载目录失败')
    expect(browser.root.value.loaded).toBe(false)
    expect(browser.initialLoading.value).toBe(false)

    mockFetchDirectory.mockResolvedValueOnce({ entries: [file('recovered.md')] })
    await browser.reload()

    expect(browser.error.value).toBeNull()
    expect(browser.currentCount.value).toBe(1)
    expect(browser.currentEntries.value[0].name).toBe('recovered.md')
  })

  it('keeps the row error when a lazy load fails', async () => {
    const browser = useFileBrowser()
    await browser.init()

    mockFetchDirectory.mockRejectedValueOnce(new Error('network down'))
    await browser.toggleDirectory('daily')

    const row = browser.treeRows.value.find((candidate) => candidate.path === 'daily')
    expect(row?.error).toBe('network down')
    expect(browser.currentPath.value).toBe('')
  })
})
