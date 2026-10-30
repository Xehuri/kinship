import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockApiGet = vi.hoisted(() => vi.fn())

vi.mock('@/api/client', () => ({
  apiGet: mockApiGet,
}))

import { fetchContextWindow, resetContextWindowCache } from '@/api/model'

const successResponse = {
  success: true,
  backend: 'loom',
  model: 'deepseek-flash',
  provider: 'xehuri-api',
  contextWindow: 1_000_000,
}

describe('fetchContextWindow', () => {
  beforeEach(() => {
    resetContextWindowCache()
    mockApiGet.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetContextWindowCache()
  })

  it('calls the model context-window endpoint and normalizes the payload', async () => {
    mockApiGet.mockResolvedValue(successResponse)

    await expect(fetchContextWindow()).resolves.toEqual({
      model: 'deepseek-flash',
      provider: 'xehuri-api',
      contextWindow: 1_000_000,
    })
    expect(mockApiGet).toHaveBeenCalledWith('/api/screen/model/context-window')
  })

  it('caches the result for 60 seconds', async () => {
    mockApiGet.mockResolvedValue(successResponse)

    await fetchContextWindow()
    await fetchContextWindow()

    expect(mockApiGet).toHaveBeenCalledTimes(1)
  })

  it('refetches after the 60 second cache expires', async () => {
    vi.useFakeTimers()
    mockApiGet.mockResolvedValue(successResponse)

    await fetchContextWindow()
    vi.advanceTimersByTime(60_001)
    await fetchContextWindow()

    expect(mockApiGet).toHaveBeenCalledTimes(2)
  })

  it('returns null and resets the cache when the request fails', async () => {
    mockApiGet.mockResolvedValueOnce(successResponse)
    await fetchContextWindow()

    vi.useFakeTimers()
    vi.advanceTimersByTime(60_001)
    mockApiGet.mockResolvedValueOnce(null)
    await expect(fetchContextWindow()).resolves.toBeNull()

    mockApiGet.mockResolvedValueOnce({
      ...successResponse,
      contextWindow: 200_000,
    })
    await expect(fetchContextWindow()).resolves.toEqual({
      model: 'deepseek-flash',
      provider: 'xehuri-api',
      contextWindow: 200_000,
    })
    expect(mockApiGet).toHaveBeenCalledTimes(3)
  })

  it('returns null for a non-object response and resets the cache', async () => {
    mockApiGet.mockResolvedValue('nope')

    await expect(fetchContextWindow()).resolves.toBeNull()

    mockApiGet.mockResolvedValue(successResponse)
    await expect(fetchContextWindow()).resolves.toEqual({
      model: 'deepseek-flash',
      provider: 'xehuri-api',
      contextWindow: 1_000_000,
    })
    expect(mockApiGet).toHaveBeenCalledTimes(2)
  })

  it('keeps the response but nulls non-positive or non-integer windows', async () => {
    mockApiGet.mockResolvedValue({
      success: true,
      backend: 'loom',
      model: 'deepseek-flash',
      provider: null,
      contextWindow: 1.5,
    })

    await expect(fetchContextWindow()).resolves.toEqual({
      model: 'deepseek-flash',
      provider: null,
      contextWindow: null,
    })
  })

  it('returns null when the API client throws and keeps the cache empty', async () => {
    mockApiGet.mockRejectedValue(new Error('boom'))

    await expect(fetchContextWindow()).resolves.toBeNull()

    mockApiGet.mockResolvedValue(successResponse)
    await expect(fetchContextWindow()).resolves.toEqual({
      model: 'deepseek-flash',
      provider: 'xehuri-api',
      contextWindow: 1_000_000,
    })
  })
})
