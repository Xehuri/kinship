/**
 * 聊天集成 Composable — App 级别的聊天初始化
 *
 * 在 App.vue 的 setup 中调用一次:
 *   useChatIntegration()
 *
 * 负责:
 * 1. 注册 SSE 事件路由 (useRealTime -> useStreamingMessage)
 * 2. 建立实时连接 (SSE + WebSocket)
 *
 * SSE 事件路由通过 useSendMessage.ensureSSEWired 完成,
 * 将 useRealTime 接收到的 SSE 消息解析为 JSON 后,
 * 转发到 useStreamingMessage.handleSSEEvent 进行流式渲染。
 *
 * 使用方式:
 *   // App.vue setup 中
 *   useChatIntegration()
 */

import { useRealTimeSingleton } from '@/composables/useRealTime';
import { ensureSSEWired } from '@/composables/useSendMessage';
import { wireTtsPlayer, stopTtsPlayback } from '@/composables/useTtsPlayer';
import { onLogout } from '@/composables/useApi';
import { useChatSingleton } from '@/composables/useChat';
import { useStreamingMessageSingleton } from '@/composables/useStreamingMessage';

// ==================== 登出清理注册 ====================

/** 是否已注册登出清理 (幂等, 防止重复调用 useChatIntegration 时重复注册) */
let _logoutWired = false;

/**
 * 注册登出清理回调 (功能层订阅认证层的登出事件)
 *
 * 依赖倒置: useApi 不再直接 import 功能 composable, 改由功能层在此订阅。
 * 登出时依次: 断开实时连接 -> 清空聊天消息 -> 重置流式状态 -> 停止 TTS。
 */
function wireLogoutCleanup(): void {
  if (_logoutWired) return;
  _logoutWired = true;
  onLogout(() => {
    // 断开实时连接 (SSE + WS), 并阻止内部重连
    try {
      useRealTimeSingleton().disconnect();
    } catch (e) {
      console.warn('[useChatIntegration] 登出断开实时连接失败:', e);
    }

    // 清空聊天消息
    try {
      useChatSingleton().clearMessages();
    } catch (e) {
      console.warn('[useChatIntegration] 登出清空消息失败:', e);
    }

    // 清空流式状态 (pending promise / sessionStatus / tokens)
    try {
      useStreamingMessageSingleton().resetStreamingState();
    } catch (e) {
      console.warn('[useChatIntegration] 登出清空流式状态失败:', e);
    }

    // 停止 TTS 播放并清空播放队列
    try {
      stopTtsPlayback();
    } catch (e) {
      console.warn('[useChatIntegration] 登出停止 TTS 失败:', e);
    }
  });
}

// ==================== Composable ====================

/**
 * 初始化聊天集成
 *
 * 在 App.vue setup 中调用一次即可。
 * 负责注册 SSE 事件路由、TTS 播放器并建立实时连接。
 */
export function useChatIntegration(): void {
  // 1. 注册 SSE 事件路由 (useRealTime -> useStreamingMessage)
  //    ensureSSEWired 使用模块级标记确保只注册一次
  ensureSSEWired();

  // 2. 注册 TTS WebSocket 音频播放器
  wireTtsPlayer();

  // 3. 注册登出清理回调 (依赖倒置: 功能层订阅认证层登出事件)
  wireLogoutCleanup();

  // 4. 建立实时连接 (SSE + WebSocket)
  const rt = useRealTimeSingleton();
  rt.connect();
}
