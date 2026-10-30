/**
 * SSE 事件路由注册 (FE-M10 精简)
 *
 * 早期版本在此文件里还有一个未被任何组件调用的 `useSendMessage()` 发送组合式函数
 * (它自带一条发送 + pending promise 路径)。该路径与 useChat.sendMessage 重复,
 * 且会导致重复的 SSE 处理, 已删除。
 *
 * 本文件现在只保留唯一职责: 把 useRealTime 收到的 SSE 事件解析后转发给
 * useStreamingMessage.handleSSEEvent。由 useChatIntegration 在 App 初始化时调用一次。
 */

import { useRealTimeSingleton } from '@/composables/useRealTime';
import { useStreamingMessageSingleton } from '@/composables/useStreamingMessage';

// ==================== 模块级注册标志 ====================

let _sseWired = false;

/**
 * 注册 SSE 事件路由 (useRealTime -> useStreamingMessage)
 *
 * 幂等: 模块级标记确保整个应用生命周期只注册一次, 避免 handler 重复累积
 * (重复注册会造成同一事件被处理多次)。
 */
export function ensureSSEWired(): void {
  if (_sseWired) return;
  _sseWired = true;

  const rt = useRealTimeSingleton();
  rt.onSSEMessage((event: MessageEvent) => {
    try {
      const raw = event.data;
      if (!raw || typeof raw !== 'string') return;
      const data = JSON.parse(raw);
      useStreamingMessageSingleton().handleSSEEvent(data);
    } catch (e) {
      console.error('[useSendMessage] SSE 事件解析失败:', e);
    }
  });
}
