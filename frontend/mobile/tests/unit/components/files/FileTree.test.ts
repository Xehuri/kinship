/// <reference types="vitest/globals" />

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import FileTree from '@/components/files/FileTree.vue'
import type { FileEntry, FileTreeRow } from '@/types/files'

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

const ROWS = [
  row(dir('daily'), 'daily', { current: true, childCount: 2 }),
  row(file('notes.md'), 'notes.md'),
]

describe('FileTree', () => {
  it('renders lazy tree rows with testids and real metadata', () => {
    const wrapper = mount(FileTree, {
      props: { rows: ROWS, selectedPath: 'notes.md' },
    })

    expect(wrapper.find('[data-testid="file-tree"]').exists()).toBe(true)
    const rows = wrapper.findAll('[data-testid="file-tree-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('daily')
    expect(rows[0].text()).toContain('2 项')
    expect(rows[1].text()).toContain('notes.md')
    expect(rows[1].text()).toContain('128 B')
    expect(rows[1].classes()).toContain('ax-file-row')
    expect(wrapper.find('.ax-file-row__inner--selected').exists()).toBe(true)
    expect(wrapper.find('.fa-folder').exists()).toBe(false)
  })

  it('emits select for both directory and file rows', async () => {
    const wrapper = mount(FileTree, { props: { rows: ROWS } })

    await wrapper.findAll('button.ax-file-row__main')[0].trigger('click')
    await wrapper.findAll('button.ax-file-row__main')[1].trigger('click')

    expect(wrapper.emitted('select')?.[0][0]).toEqual(ROWS[0])
    expect(wrapper.emitted('select')?.[1][0]).toEqual(ROWS[1])
  })

  it('emits toggle only for directories', async () => {
    const wrapper = mount(FileTree, { props: { rows: ROWS } })

    expect(wrapper.findAll('.ax-file-row__toggle')).toHaveLength(1)
    await wrapper.find('.ax-file-row__toggle').trigger('click')

    expect(wrapper.emitted('toggle')?.[0][0]).toEqual(ROWS[0])
  })

  it('shows the empty state when the current directory has no entries', () => {
    const wrapper = mount(FileTree, {
      props: { rows: [], emptyMessage: '这个目录是空的' },
    })

    expect(wrapper.text()).toContain('这个目录是空的')
    expect(wrapper.findAll('[data-testid="file-tree-row"]')).toHaveLength(0)
  })

  it('shows loading skeletons instead of fake rows when no rows are available', () => {
    const wrapper = mount(FileTree, { props: { rows: [], loading: true } })

    expect(wrapper.findAll('.skeleton')).toHaveLength(5)
    expect(wrapper.findAll('[data-testid="file-tree-row"]')).toHaveLength(0)
    expect(wrapper.attributes('aria-busy')).toBe('true')
  })

  it('keeps existing rows mounted and marks the list busy while loading', () => {
    const wrapper = mount(FileTree, { props: { rows: ROWS, loading: true } })

    expect(wrapper.findAll('.skeleton')).toHaveLength(0)
    expect(wrapper.findAll('[data-testid="file-tree-row"]')).toHaveLength(2)
    expect(wrapper.attributes('aria-busy')).toBe('true')
  })

  it('omits aria-busy when idle', () => {
    const wrapper = mount(FileTree, { props: { rows: ROWS } })

    expect(wrapper.attributes('aria-busy')).toBeUndefined()
  })
})
