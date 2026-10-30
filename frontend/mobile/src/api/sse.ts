/**
 * SSE (Server-Sent Events) 连接管理器
 *
 * 对应 /api/screen/events/stream?ticket={ticket}
 * 接收 OpenCode AI 回复事件流
 *
 * 使用方式:
 *   import { createSSEConnection, disconnectSSE } from '@/api/sse'
 *   const sse = await createSSEConnection(onMessage, onStatus)
 *   // 之后使用 disconnectSSE(sse) 断开
 *
 * 设计约束 (FE-H3):
 *   本模块只负责建立/关闭单条 EventSource, 不承担任何重连职责。
 *   重连 (指数退避、次数上限、登出停止) 统一由 useRealTime 调度,
 *   避免内部重连与上层重连叠加导致"僵尸连接"或重复连接。
 *
 *   注意: 一旦发生错误, onerror 会主动 close(), 以关闭 EventSource 的原生
 *   自动重连, 把重连控制权完全交给上层。
 *
 * 安全约束 (FE-H2):
 *   EventSource 无法携带 Authorization 头, 故改用一次性 ticket 做 query 认证。
 *   ticket 用后即焚, 因此每次建连 (含上层重连) 都重新调用 fetchWsTicket()。
 */

import { fetchWsTicket } from '@/api/ticket';

/** SSE 消息处理回调 */
export type SSEMessageHandler = (event: MessageEvent) => void;

/** SSE 连接状态变化回调 */
export type SSEStatusHandler = (connected: boolean) => void;

/**
 * 创建 SSE 连接 (不自动重连)
 *
 * 先带 Bearer 头获取一次性 ticket, 再以 `?ticket=` 建立 EventSource。
 * ticket 获取失败时优雅降级: 返回 null 并通知状态为 false, 由上层调度重连。
 *
 * @param onMessage 消息处理回调
 * @param onStatusChange 连接状态变化回调 (可选)
 * @returns EventSource 实例; 票据获取失败或构造异常返回 null
 */
export async function createSSEConnection(
  onMessage?: SSEMessageHandler,
  onStatusChange?: SSEStatusHandler,
): Promise<EventSource | null> {
  // 一次性 ticket: 每次建连都必须重新获取, 禁止缓存
  const ticket = await fetchWsTicket();
  if (!ticket) {
    // 不在此处触发状态回调: 由上层 (useRealTime) 决定是否调度重连
    console.warn('[SSE] 无法获取连接票据, 放弃建立连接');
    return null;
  }

  const url = '/api/screen/events/stream?ticket=' + encodeURIComponent(ticket);

  let sse: EventSource;
  try {
    sse = new EventSource(url);
  } catch (e) {
    console.warn('[SSE] 连接失败:', e);
    if (onStatusChange) onStatusChange(false);
    return null;
  }

  sse.onopen = (): void => {
    console.log('[SSE] 已连接');
    if (onStatusChange) onStatusChange(true);
  };

  sse.onmessage = (event: MessageEvent): void => {
    if (onMessage) onMessage(event);
  };

  sse.onerror = (): void => {
    console.warn('[SSE] 连接错误');
    // 关闭底层连接, 阻止 EventSource 原生自动重连; 重连由 useRealTime 统一调度
    try {
      sse.close();
    } catch {
      // 已关闭时忽略
    }
    if (onStatusChange) onStatusChange(false);
  };

  return sse;
}

/**
 * 断开 SSE 连接
 */
export function disconnectSSE(sse: EventSource | null): void {
  if (sse) {
    sse.close();
    console.log('[SSE] 已断开');
  }
}
