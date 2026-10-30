import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useMediaQuery } from '@/composables/useMediaQuery'

type ChangeListener = (event: MediaQueryListEvent) => void

const originalMatchMedia = window.matchMedia
let listeners: ChangeListener[] = []
let removeEventListener: ReturnType<typeof vi.fn>

beforeEach(() => {
  listeners = []
  removeEventListener = vi.fn()

  const mediaQueryList = {
    matches: true,
    media: '(min-width: 900px)',
    onchange: null,
    addEventListener: (type: string, listener: ChangeListener) => {
      if (type === 'change') {
        listeners.push(listener)
      }
    },
    removeEventListener: (type: string, listener: ChangeListener) => {
      removeEventListener(type, listener)
      listeners = listeners.filter((item) => item !== listener)
    },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }

  window.matchMedia = vi.fn(() => mediaQueryList) as unknown as typeof window.matchMedia
})

afterEach(() => {
  window.matchMedia = originalMatchMedia
})

describe('useMediaQuery', () => {
  it('reports the initial match state', () => {
    const scope = effectScope()
    const matches = scope.run(() => useMediaQuery('(min-width: 900px)'))

    expect(matches?.value).toBe(true)
    scope.stop()
  })

  it('updates when the media query changes', () => {
    const scope = effectScope()
    const matches = scope.run(() => useMediaQuery('(min-width: 900px)'))
    const [listener] = listeners

    expect(listener).toBeDefined()
    listener?.({ matches: false } as MediaQueryListEvent)
    expect(matches?.value).toBe(false)

    listener?.({ matches: true } as MediaQueryListEvent)
    expect(matches?.value).toBe(true)

    scope.stop()
  })

  it('removes the listener when the scope is disposed', () => {
    const scope = effectScope()
    scope.run(() => useMediaQuery('(min-width: 900px)'))
    const [listener] = listeners

    scope.stop()

    expect(removeEventListener).toHaveBeenCalledWith('change', listener)
  })
})
