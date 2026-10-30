import { describe, expect, it, vi, beforeEach } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick, ref } from 'vue'

const mockFetchContextWindow = vi.hoisted(() => vi.fn())

vi.mock('@/api/model', () => ({
  fetchContextWindow: mockFetchContextWindow,
}))

import { useContextWindow } from '@/composables/useContextWindow'

const info = {
  model: 'deepseek-flash',
  provider: 'xehuri-api',
  contextWindow: 1_000_000,
}

describe('useContextWindow', () => {
  beforeEach(() => {
    mockFetchContextWindow.mockReset()
  })

  it('does not fetch while disabled', async () => {
    const enabled = ref(false)
    const state = useContextWindow(enabled)
    await flushPromises()

    expect(mockFetchContextWindow).not.toHaveBeenCalled()
    expect(state.contextWindow.value).toBeNull()
    expect(state.loading.value).toBe(false)

    await state.refresh()
    expect(mockFetchContextWindow).not.toHaveBeenCalled()
  })

  it('loads when enabled and exposes model, provider and window', async () => {
    mockFetchContextWindow.mockResolvedValue(info)
    const enabled = ref(false)
    const state = useContextWindow(enabled)
    await flushPromises()

    enabled.value = true
    await flushPromises()

    expect(mockFetchContextWindow).toHaveBeenCalledTimes(1)
    expect(state.loading.value).toBe(false)
    expect(state.contextWindow.value).toBe(1_000_000)
    expect(state.model.value).toBe('deepseek-flash')
    expect(state.provider.value).toBe('xehuri-api')
  })

  it('keeps the window null when the API returns null', async () => {
    mockFetchContextWindow.mockResolvedValue(null)
    const state = useContextWindow(ref(true))
    await flushPromises()

    expect(state.contextWindow.value).toBeNull()
    expect(state.model.value).toBeNull()
    expect(state.provider.value).toBeNull()
  })

  it('rejects non-positive or non-integer windows instead of guessing', async () => {
    mockFetchContextWindow.mockResolvedValue({
      model: 'deepseek-flash',
      provider: 'xehuri-api',
      contextWindow: 1.5,
    })
    const state = useContextWindow(ref(true))
    await flushPromises()

    expect(state.contextWindow.value).toBeNull()
    expect(state.model.value).toBe('deepseek-flash')
  })

  it('refresh reloads the window even after a cached or empty state', async () => {
    mockFetchContextWindow.mockResolvedValueOnce(info)
    const state = useContextWindow(ref(true))
    await flushPromises()

    mockFetchContextWindow.mockResolvedValueOnce({ ...info, contextWindow: 200_000 })
    await state.refresh()

    expect(mockFetchContextWindow).toHaveBeenCalledTimes(2)
    expect(state.contextWindow.value).toBe(200_000)
  })

  it('clears the loading flag when disabled mid-flight', async () => {
    let resolveFetch: ((value: unknown) => void) | undefined
    mockFetchContextWindow.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve
      }),
    )
    const enabled = ref(false)
    const state = useContextWindow(enabled)
    await flushPromises()

    enabled.value = true
    await nextTick()
    expect(state.loading.value).toBe(true)

    enabled.value = false
    await nextTick()
    expect(state.loading.value).toBe(false)

    resolveFetch?.(info)
    await flushPromises()
    expect(state.contextWindow.value).toBeNull()
  })
})
