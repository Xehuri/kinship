/// <reference types="vitest/globals" />

import { describe, expect, it, vi, beforeEach } from 'vitest'

const apiGet = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  apiGet,
}))

import { fetchDirectory, normalizeFileEntry } from '@/api/files'

describe('normalizeFileEntry', () => {
  it('maps backend mtime to modified_at and collapses file subtypes', () => {
    const entry = normalizeFileEntry({
      name: 'perception.jsonl',
      type: 'json',
      size: 2048,
      mtime: '2026-10-24T08:30:00',
    })

    expect(entry).toEqual({
      name: 'perception.jsonl',
      type: 'file',
      size: 2048,
      modified_at: '2026-10-24T08:30:00',
    })
    expect(entry).not.toHaveProperty('mtime')
  })

  it('keeps directory type and preserves an explicit modified_at', () => {
    const entry = normalizeFileEntry({
      name: 'daily',
      type: 'dir',
      size: 0,
      mtime: '2026-10-23T09:00:00',
      modified_at: '2026-10-22T09:00:00',
    })

    expect(entry.type).toBe('dir')
    expect(entry.modified_at).toBe('2026-10-22T09:00:00')
  })
})

describe('fetchDirectory', () => {
  beforeEach(() => {
    apiGet.mockReset()
  })

  it('requests the root scope and normalizes every entry', async () => {
    apiGet.mockResolvedValue({
      entries: [
        { name: 'daily', type: 'dir', size: 0, mtime: '2026-10-24T10:00:00' },
        { name: 'note.md', type: 'md', size: 128, mtime: '2026-10-24T11:00:00' },
      ],
    })

    const result = await fetchDirectory('')

    expect(apiGet).toHaveBeenCalledWith('/api/mobile/files?scope=root&path=')
    expect(result?.entries).toEqual([
      {
        name: 'daily',
        type: 'dir',
        size: 0,
        modified_at: '2026-10-24T10:00:00',
      },
      {
        name: 'note.md',
        type: 'file',
        size: 128,
        modified_at: '2026-10-24T11:00:00',
      },
    ])
  })

  it('encodes the path and returns empty entries for a missing list', async () => {
    apiGet.mockResolvedValue({})

    const result = await fetchDirectory('daily/2026-10-24')

    expect(apiGet).toHaveBeenCalledWith(
      '/api/mobile/files?scope=root&path=daily%2F2026-10-24',
    )
    expect(result).toEqual({ entries: [] })
  })

  it('returns null when the API layer reports a failure', async () => {
    apiGet.mockResolvedValue(null)

    await expect(fetchDirectory('daily')).resolves.toBeNull()
  })

  it('drops malformed entries without inventing data', async () => {
    apiGet.mockResolvedValue({
      entries: [{ type: 'dir' }, { name: 'ok.txt', type: 'txt', size: 1 }],
    })

    const result = await fetchDirectory('')

    expect(result?.entries).toEqual([
      { name: 'ok.txt', type: 'file', size: 1, modified_at: undefined },
    ])
  })
})
