import { computed, type ComputedRef, type Ref } from 'vue'
import type { ChatMessage } from '@/types'
import type { TurnView } from '@/types/turn'
import { toTurnViews } from '@/utils/turnAdapter'

/** 消息的稳定 id (与适配器一致: 顶层 id 优先, 其次 info.id) */
function stableMessageId(message: ChatMessage): string {
  if (typeof message.id === 'string' && message.id) return message.id
  const infoId = message.info?.id
  return typeof infoId === 'string' && infoId ? infoId : ''
}

/**
 * ChatMessage[] -> TurnView[] 的响应式视图。
 *
 * 适配器保持纯函数; 本 composable 只负责把实时消息列表映射为轮次视图,
 * 并把当前流式消息 id 传给适配器 (isStreaming 标记缺失时的兜底)。
 */
export function useTurnViews(
  messages: Readonly<Ref<ChatMessage[]>>,
): ComputedRef<TurnView[]> {
  const streamingId = computed<string>(() => {
    const list = messages.value
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index]
      if (message?.isStreaming === true) {
        return stableMessageId(message)
      }
    }
    return ''
  })

  return computed(() =>
    toTurnViews(messages.value, {
      streamingId: streamingId.value || undefined,
    }),
  )
}
