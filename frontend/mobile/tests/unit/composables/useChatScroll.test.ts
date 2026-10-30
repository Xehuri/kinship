import { describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, type Ref } from 'vue'
import type { ChatMessage } from '@/types'
import { useChatScroll, type ChatScrollApi } from '@/composables/useChatScroll'

interface FakeScrollElement {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
  scrollTo: ReturnType<typeof vi.fn>
}

function makeElement(): FakeScrollElement {
  return {
    scrollHeight: 500,
    scrollTop: 0,
    clientHeight: 100,
    scrollTo: vi.fn(),
  }
}

function mountScroll(): {
  api: ChatScrollApi
  messages: Ref<ChatMessage[]>
  sessionId: Ref<string>
  isStreaming: Ref<boolean>
  contentLength: Ref<number>
  stop: () => void
} {
  const messages = ref<ChatMessage[]>([])
  const sessionId = ref('s1')
  const isStreaming = ref(false)
  const contentLength = ref(0)

  let api: ChatScrollApi | null = null
  const scope = effectScope()
  scope.run(() => {
    api = useChatScroll({ messages, sessionId, isStreaming, contentLength })
  })

  if (!api) throw new Error('useChatScroll did not initialise')

  return {
    api,
    messages,
    sessionId,
    isStreaming,
    contentLength,
    stop: () => scope.stop(),
  }
}

describe('useChatScroll', () => {
  it('tracks whether the user scrolled away from the bottom', () => {
    const { api, stop } = mountScroll()
    const element = makeElement()
    ;(api.scrollRef as unknown as { value: FakeScrollElement | null }).value = element

    element.scrollTop = 400
    api.onScroll()
    expect(api.userScrolledUp.value).toBe(false)

    element.scrollTop = 100
    api.onScroll()
    expect(api.userScrolledUp.value).toBe(true)

    stop()
  })

  it('scrolls to the bottom only while the user stays pinned', async () => {
    const { api, stop } = mountScroll()
    const element = makeElement()
    ;(api.scrollRef as unknown as { value: FakeScrollElement | null }).value = element

    api.scrollToBottom(false)
    await nextTick()
    expect(element.scrollTo).toHaveBeenCalledWith({ top: 500, behavior: 'instant' })

    element.scrollTop = 100
    api.onScroll()
    element.scrollTo.mockClear()

    api.scrollToBottom(false)
    await nextTick()
    expect(element.scrollTo).not.toHaveBeenCalled()

    stop()
  })

  it('compensates scrollTop when earlier history is prepended', async () => {
    const { api, stop } = mountScroll()
    const element = makeElement()
    element.scrollTop = 100
    ;(api.scrollRef as unknown as { value: FakeScrollElement | null }).value = element

    const result = await api.prepend(async () => {
      element.scrollHeight = 800
      return 'loaded'
    })

    expect(result).toBe('loaded')
    expect(element.scrollTop).toBe(400)

    stop()
  })

  it('resets the pinned state when the session changes', async () => {
    const { api, sessionId, stop } = mountScroll()
    const element = makeElement()
    element.scrollTop = 100
    ;(api.scrollRef as unknown as { value: FakeScrollElement | null }).value = element
    api.onScroll()
    expect(api.userScrolledUp.value).toBe(true)

    sessionId.value = 's2'
    await nextTick()

    expect(api.userScrolledUp.value).toBe(false)
    stop()
  })
})
