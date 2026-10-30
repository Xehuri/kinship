/**
 * WebSocket 连接管理器 (主 /ws)
 *
 * 对应 wss://{host}/ws?ticket={ticket}
 * 用于实时数据推送 (如通知、状态更新)
 *
 * 使用方式:
 *   import { createWsConnection, disconnectWs } from '@/api/ws'
 *   const ws = await createWsConnection({ onMessage: (data) => ... })
 *   // 之后使用 disconnectWs(ws) 断开
 *
 * 设计约束 (FE-H4):
 *   - 重连定时器句柄必须被保存, 断开时清除, 防止"僵尸重连"在登出/卸载后
 *     重新建立连接。
 *   - 用 closed 标志保证 dispose 之后不再发起任何新连接。
 *   - 由于每次重连都会创建新的 WebSocket 实例, 对外返回一个稳定的连接句柄,
 *     其 close() 会关闭"当前活跃 socket"并停止后续重连。
 *
 * 安全约束 (FE-H2):
 *   WebSocket 握手可在 query 传一次性 ticket; ticket 用后即焚, 因此每次连接
 *   (含内部自动重连) 都重新调用 fetchWsTicket(), 严禁缓存复用。
 */

import { getToken } from '@/api/client';
import { getDeviceId } from '@/composables/useDeviceId';
import { fetchWsTicket } from '@/api/ticket';

// ==================== 类型 ====================

/** WS 消息回调 */
export type WSMessageHandler = (data: unknown) => void;

/** WS 状态回调 */
export type WSStatusHandler = (connected: boolean) => void;

/** WS 连接配置 */
export interface WSOptions {
  /** 消息处理回调 */
  onMessage?: WSMessageHandler;
  /** 连接状态变化回调 */
  onStatusChange?: WSStatusHandler;
  /** 最大重连间隔 (ms), 默认 30000 */
  maxDelay?: number;
  /** 初始重连延迟 (ms), 默认 3000 */
  initialDelay?: number;
}

/**
 * WebSocket 连接句柄
 *
 * 内部可能因重连而更换底层 socket, 对外用稳定的句柄暴露关闭能力,
 * 避免调用方持有的是某个已失效的 socket。
 */
export interface WsConnection {
  /** 关闭当前活跃连接并停止一切重连 */
  close(): void;
}

/** 内部连接管理器: 保存当前活跃 socket 与重连定时器 */
interface WsManager {
  current: WebSocket | null;
  dispose: () => void;
}

// ==================== 连接管理 ====================

/**
 * 创建 WebSocket 连接 (含指数退避自动重连)
 *
 * @param options 连接配置
 * @returns 连接句柄; 无 token 时返回 null
 */
export async function createWsConnection(
  options?: WSOptions,
): Promise<WsConnection | null> {
  if (!getToken()) {
    console.warn('[WS] 无 token, 无法建立 WebSocket 连接');
    return null;
  }

  const maxDelay = options?.maxDelay ?? 30000;
  const initialDelay = options?.initialDelay ?? 3000;
  let reconnectAttempt = 0;
  /** 重连定时器句柄 (断开时必须清除) */
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 是否已主动关闭 (置位后禁止一切新连接与重连) */
  let closed = false;

  const manager: WsManager = {
    current: null,
    dispose: () => {
      closed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const cur = manager.current;
      if (cur) {
        // 移除处理器, 防止 close 触发 onclose -> 重连
        cur.onclose = null;
        cur.onerror = null;
        cur.onmessage = null;
        cur.onopen = null;
        try {
          cur.close();
        } catch {
          // 已关闭时忽略
        }
        manager.current = null;
      }
    },
  };

  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  async function connect(): Promise<void> {
    if (closed) return;

    // 一次性 ticket: 每次 (重) 连都重新获取
    const ticket = await fetchWsTicket();
    // await 期间可能已被 dispose, 此时不得再建立连接
    if (closed) return;
    if (!ticket) {
      console.warn('[WS] 无法获取连接票据, 稍后重连');
      scheduleReconnect();
      return;
    }

    const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://';
    // 设备维度握手：device_id 用于 TTS 设备路由，client=web 标识 Web 端连接
    const wsUrl =
      protocol + location.host + '/ws?ticket=' + encodeURIComponent(ticket) +
      '&device_id=' + encodeURIComponent(getDeviceId()) + '&client=web';

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      console.warn('[WS] 连接失败:', e);
      scheduleReconnect();
      return;
    }

    manager.current = ws;

    ws.onopen = (): void => {
      console.log('[WS] 已连接');
      reconnectAttempt = 0;
      if (options?.onStatusChange) {
        options.onStatusChange(true);
      }
    };

    ws.onmessage = (event: MessageEvent): void => {
      try {
        const data = JSON.parse(event.data as string);
        if (options?.onMessage) {
          options.onMessage(data);
        }
      } catch (e) {
        console.warn('[WS] 消息解析失败:', e);
      }
    };

    ws.onclose = (): void => {
      console.log('[WS] 已断开');
      if (options?.onStatusChange) {
        options.onStatusChange(false);
      }
      scheduleReconnect();
    };

    ws.onerror = (e: Event): void => {
      console.warn('[WS] 错误:', e);
    };
  }

  function scheduleReconnect(): void {
    // 主动关闭后不再重连 (FE-H4: 防止登出/卸载后新建 WS)
    if (closed) return;
    const delay = Math.min(
      initialDelay * Math.pow(2, reconnectAttempt),
      maxDelay,
    );
    reconnectAttempt++;
    console.log('[WS] 将在 ' + delay + 'ms 后重连 (第' + reconnectAttempt + '次)');
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      void connect();
    }, delay);
  }

  // 立即建立首次连接
  await connect();

  return { close: () => manager.dispose() };
}

/**
 * 断开 WebSocket 连接 (清除重连定时器, 不触发重连)
 */
export function disconnectWs(ws: WsConnection | null): void {
  if (!ws) return;
  ws.close();
  console.log('[WS] 已断开 (主动)');
}
