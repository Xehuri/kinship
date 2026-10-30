import { nextTick, onScopeDispose, ref, watch, type Ref } from 'vue'
import type { ChatMessage } from '@/types'

export interface ChatScrollOptions {
  /** 真实消息列表 (演示消息不参与滚动跟随) */
  messages: Readonly<Ref<ChatMessage[]>>
  /** 当前会话 id; 变化时立即回到底部 */
  sessionId: Readonly<Ref<string>>
  /** 是否正在流式输出 */
  isStreaming: Readonly<Ref<boolean>>
  /** 流式消息的内容长度, 驱动逐帧跟随 */
  contentLength: Readonly<Ref<number>>
}

export interface ChatScrollApi {
  /** 绑定到滚动容器 */
  scrollRef: Ref<HTMLElement | null>
  /** 用户是否主动上滑离开了底部 */
  userScrolledUp: Readonly<Ref<boolean>>
  isNearBottom: () => boolean
  onScroll: () => void
  scrollToBottom: (smooth?: boolean) => void
  /**
   * 执行一次"顶部前插"任务 (加载更早历史), 前后按新增高度补偿 scrollTop,
   * 保持用户当前可视位置不跳动。
   */
  prepend: <T>(task: () => Promise<T>) => Promise<T>
}

/** 距底部小于该像素视为"在底部" */
const NEAR_BOTTOM_PX = 20

/**
 * 聊天滚动控制: 自动跟随流式输出、尊重用户上滑、分页前插补偿。
 */
export function useChatScroll(options: ChatScrollOptions): ChatScrollApi {
  const scrollRef = ref<HTMLElement | null>(null)
  const userScrolledUp = ref(false)

  /** 前插进行中: 禁止自动滚到底部, 由 prepend 自行恢复位置 */
  let prepending = false
  let raf = 0
  let lastSessionId = options.sessionId.value

  function isNearBottom(): boolean {
    const el = scrollRef.value
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX
  }

  function onScroll(): void {
    userScrolledUp.value = !isNearBottom()
  }

  function scrollToBottom(smooth = true): void {
    if (userScrolledUp.value || prepending) return
    void nextTick(() => {
      const el = scrollRef.value
      if (!el) return
      el.scrollTo({
        top: el.scrollHeight,
        behavior: smooth ? 'smooth' : 'instant',
      })
    })
  }

  function scheduleStreamingScroll(): void {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      if (!userScrolledUp.value && !prepending) scrollToBottom(false)
    })
  }

  watch(
    () => options.sessionId.value,
    (sessionId) => {
      if (sessionId === lastSessionId) return
      lastSessionId = sessionId
      userScrolledUp.value = false
      scrollToBottom(false)
    },
  )

  watch(
    () => options.messages.value.length,
    (length, previous) => {
      if (prepending) return
      if (previous === 0 && length > 0) {
        scrollToBottom(false)
      } else if (length > 0) {
        scrollToBottom()
      }
    },
  )

  watch(
    () => options.isStreaming.value,
    (streaming) => {
      if (streaming) scrollToBottom(false)
    },
  )

  watch(
    () => options.contentLength.value,
    () => {
      if (options.isStreaming.value) scheduleStreamingScroll()
    },
  )

  async function prepend<T>(task: () => Promise<T>): Promise<T> {
    const el = scrollRef.value
    const previousHeight = el ? el.scrollHeight : 0
    const previousTop = el ? el.scrollTop : 0

    prepending = true
    try {
      const result = await task()
      await nextTick()
      if (el) {
        el.scrollTop = el.scrollHeight - previousHeight + previousTop
      }
      return result
    } finally {
      prepending = false
    }
  }

  onScopeDispose(() => {
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  })

  return {
    scrollRef,
    userScrolledUp,
    isNearBottom,
    onScroll,
    scrollToBottom,
    prepend,
  }
}
