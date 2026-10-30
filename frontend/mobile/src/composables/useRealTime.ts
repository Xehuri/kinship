/**
 * 实时连接 Composable — SSE + WebSocket 连接生命周期管理
 *
 * 统一管理 SSE (/api/screen/events/stream) 和 WebSocket (/ws) 连接,
 * 支持自动重连 (指数退避)。
 *
 * 使用方式:
 *   const { connectionState, connect, disconnect, onSSEMessage } = useRealTime()
 *   connect()  // 同时建立 SSE + WS
 *   // 监听 SSE 消息
 *   onSSEMessage((data) => console.log('SSE:', data))
 *   disconnect()  // 断开所有
 */

import { ref, readonly, type Ref } from 'vue';
import { createSSEConnection, disconnectSSE } from '@/api/sse';
import { createWsConnection, disconnectWs } from '@/api/ws';
import type { WSMessageHandler, WsConnection } from '@/api/ws';
import type { SSEMessageHandler } from '@/api/sse';
import { useChatSingleton } from '@/composables/useChat';

// ==================== 类型定义 ====================

/** 连接状态 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

/** useRealTime 返回值 */
export interface UseRealTimeReturn {
  /** 当前连接状态 */
  connectionState: Readonly<Ref<ConnectionState>>;
  /** SSE 是否已连接 */
  sseConnected: Readonly<Ref<boolean>>;
  /** WebSocket 是否已连接 */
  wsConnected: Readonly<Ref<boolean>>;
  /** 建立 SSE + WS 连接 (幂等) */
  connect: () => void;
  /** 断开 SSE + WS 连接 (同时停止重连) */
  disconnect: () => void;
  /** 仅断开并重连 SSE */
  reconnectSSE: () => void;
  /** 仅断开并重连 WS */
  reconnectWS: () => void;
  /** 注册 SSE 消息监听 */
  onSSEMessage: (handler: SSEMessageHandler) => void;
  /** 移除 SSE 消息监听 */
  offSSEMessage: (handler: SSEMessageHandler) => void;
  /** 注册 WS 消息监听 */
  onWSMessage: (handler: WSMessageHandler) => void;
  /** 移除 WS 消息监听 */
  offWSMessage: (handler: WSMessageHandler) => void;
}

// ==================== 共享常量 ====================

/** 默认 SSE 重连延迟 [s] — 递增退避 (T-C5: 提升重连持续能力) */
const DEFAULT_SSE_RECONNECT_DELAYS = [3, 5, 10, 15, 30];
/** 默认 SSE 最大重连次数 (T-C5: 由 3 提升到 30, 避免短暂断网后永久停止) */
const DEFAULT_SSE_MAX_ATTEMPTS = 30;
/** WS 重连参数 (秒) */
const WS_INITIAL_DELAY = 3;
/** WS 最大重连间隔 (ms) */
const WS_MAX_DELAY_MS = 30000;

// ---- 可全局配置的 SSE 重连策略 (T-C5) ----
/** SSE 重连延迟序列 [s] */
let _sseReconnectDelays: number[] = [...DEFAULT_SSE_RECONNECT_DELAYS];
/** SSE 最大重连次数 */
let _sseMaxReconnectAttempts = DEFAULT_SSE_MAX_ATTEMPTS;
/** 重连成功后是否重新同步当前会话历史 (补回断线期间丢失的增量) */
let _sseResyncOnReconnect = true;

/**
 * 配置 SSE 重连策略 (T-C5)
 *
 * 默认: 延迟 [3,5,10,15,30]s, 最多 30 次, 重连成功后重新同步当前会话。
 * 传入部分字段时仅覆盖对应项。
 */
export function configureSSEReconnect(options: {
  delays?: number[];
  maxAttempts?: number;
  resyncOnReconnect?: boolean;
}): void {
  if (options.delays && options.delays.length > 0) {
    _sseReconnectDelays = [...options.delays];
  }
  if (typeof options.maxAttempts === 'number') {
    _sseMaxReconnectAttempts = options.maxAttempts;
  }
  if (typeof options.resyncOnReconnect === 'boolean') {
    _sseResyncOnReconnect = options.resyncOnReconnect;
  }
}

// 注意 (FE-L1): 连接状态 (EventSource / WebSocket 句柄、重连计数与定时器、
// 连接代次、断开标志) 全部定义在 useRealTime() 函数作用域内 —— 每次调用都会
// 创建独立闭包, 保证多个 useRealTime() 实例之间状态完全隔离, 互不干扰。
// 需要跨组件共享同一条连接时, 请改用 useRealTimeSingleton()。

// ==================== Composable ====================

/**
 * 实时连接 Composable — SSE + WebSocket 连接生命周期管理
 *
 * 管理连接建立、断开、自动重连 (递增退避)。
 * SSE 默认最多重连 30 次 (延迟 [3,5,10,15,30]s), 可通过 configureSSEReconnect 配置,
 * 且重连成功后自动重新同步当前会话历史 (T-C5);
 * WS 无限重连 (指数退避 3s, 6s, 12s, ... 最大 30s)。
 */
export function useRealTime(): UseRealTimeReturn {
  const connectionState = ref<ConnectionState>('disconnected');
  const sseConnected = ref(false);
  const wsConnected = ref(false);

  /** SSE 消息处理器列表 */
  const _sseHandlers: SSEMessageHandler[] = [];
  /** WS 消息处理器列表 */
  const _wsHandlers: WSMessageHandler[] = [];

  // ---- 实例级连接状态 (每实例独立闭包, 互不干扰) ----

  /** SSE EventSource 实例引用 */
  let _sse: EventSource | null = null;
  /** WebSocket 连接句柄引用 */
  let _ws: WsConnection | null = null;
  /** SSE 重连尝试次数 */
  let _sseReconnectAttempt = 0;
  /** 是否曾经成功建立过 SSE 连接 (用于区分"首次连接"与"重连") */
  let _sseHasConnectedOnce = false;
  /** SSE 重连定时器 ID */
  let _sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** SSE 连接代次: 用于丢弃"票据换取期间"已过期的异步建连结果 */
  let _sseEpoch = 0;
  /** WS 连接代次: 同上 */
  let _wsEpoch = 0;
  /** 是否已明确断开 (不再重连) */
  let _disconnectedByUser = false;

  // ==================== SSE 连接 ====================

  /**
   * 建立 SSE 连接
   * 使用 api/sse.ts 的 createSSEConnection (该模块不自动重连),
   * 连接状态/错误回调都会回到本 composable, 由这里统一调度重连。
   */
  async function connectSSE(): Promise<void> {
    if (_sse) {
      disconnectSSE(_sse);
      _sse = null;
    }

    connectionState.value = 'connecting';

    // 记录本次连接代次, 丢弃被更晚操作取代的过期结果
    const epoch = ++_sseEpoch;
    const created = await createSSEConnection(handleSSEMessage, handleSSEStatus);

    // 等待票据期间用户已断开或已发起新的连接: 关闭过期结果
    if (_disconnectedByUser || epoch !== _sseEpoch) {
      disconnectSSE(created);
      return;
    }

    _sse = created;

    // createSSEConnection 不自动重连; 若创建失败 (无 token / 票据失败 / 构造异常),
    // 由本 composable 调度重连。用户主动断开时 _disconnectedByUser 会阻止重连。
    if (!_sse) {
      handleSSEStatus(false);
    }
  }

  /**
   * 处理 SSE 消息 — 分发给所有注册的处理器
   */
  function handleSSEMessage(event: MessageEvent): void {
    for (const handler of _sseHandlers) {
      try {
        handler(event);
      } catch (e) {
        console.error('[useRealTime] SSE handler error:', e);
      }
    }
  }

  /**
   * 处理 SSE 连接状态变化
   */
  function handleSSEStatus(connected: boolean): void {
    sseConnected.value = connected;
    if (connected) {
      // T-C5: 记录本次是否为"重连成功", 用于重连后 resync
      const wasReconnect = _sseHasConnectedOnce && _sseReconnectAttempt > 0;
      _sseHasConnectedOnce = true;
      _sseReconnectAttempt = 0;
      if (wsConnected.value) {
        connectionState.value = 'connected';
      }
      if (wasReconnect && _sseResyncOnReconnect) {
        resyncActiveSession();
      }
    } else {
      if (!_disconnectedByUser) {
        scheduleSSEReconnect();
      }
      connectionState.value = 'disconnected';
    }
  }

  /**
   * 重连成功后重新同步当前会话历史 (T-C5)
   *
   * SSE 断线期间的 message.part.updated/delta 增量会丢失, 仅靠后续事件无法补齐,
   * 因此在重连成功时重新拉取当前会话历史, 避免消息永久缺失。
   */
  function resyncActiveSession(): void {
    try {
      const chat = useChatSingleton();
      const sessionId = chat.currentSessionId.value;
      if (!sessionId) return;
      console.log('[useRealTime] SSE 重连成功, 重新同步会话:', sessionId);
      void chat.loadChatHistory(sessionId);
    } catch (e) {
      console.error('[useRealTime] 重连后重新同步会话失败:', e);
    }
  }

  /**
   * SSE 重连调度 (递增退避: 默认 3s, 5s, 10s, 15s, 30s, 最多 30 次)
   * 延迟序列/次数/是否 resync 可通过 configureSSEReconnect 配置 (T-C5)。
   */
  function scheduleSSEReconnect(): void {
    if (_disconnectedByUser) return;
    if (_sseReconnectAttempt >= _sseMaxReconnectAttempts) {
      console.log('[useRealTime] SSE 已达最大重连次数 (' + _sseMaxReconnectAttempts + '), 停止重连');
      return;
    }
    const idx = Math.min(_sseReconnectAttempt, _sseReconnectDelays.length - 1);
    const delayMs = _sseReconnectDelays[idx] * 1000;
    _sseReconnectAttempt++;
    console.log(
      '[useRealTime] SSE 将在 ' + delayMs + 'ms 后重连 (第' +
      _sseReconnectAttempt + '次)',
    );
    _sseReconnectTimer = setTimeout(() => {
      void connectSSE();
    }, delayMs);
  }

  /**
   * 断开 SSE (不触发重连)
   */
  function destroySSE(): void {
    if (_sseReconnectTimer) {
      clearTimeout(_sseReconnectTimer);
      _sseReconnectTimer = null;
    }
    // 使任何"票据换取中"的异步建连结果失效
    _sseEpoch++;
    if (_sse) {
      disconnectSSE(_sse);
      _sse = null;
    }
    sseConnected.value = false;
    _sseReconnectAttempt = 0;
  }

  // ==================== WS 连接 ====================

  /**
   * 建立 WebSocket 连接
   * 使用 api/ws.ts 的 createWsConnection
   */
  async function connectWS(): Promise<void> {
    if (_ws) {
      destroyWSInternal();
    }

    connectionState.value = 'connecting';

    // 记录本次连接代次, 丢弃被更晚操作取代的过期结果
    const epoch = ++_wsEpoch;
    const created = await createWsConnection({
      onMessage: handleWSMessage,
      onStatusChange: handleWSStatus,
      initialDelay: WS_INITIAL_DELAY * 1000,
      maxDelay: WS_MAX_DELAY_MS,
    });

    // 等待票据期间用户已断开或已发起新的连接: 关闭过期结果
    if (_disconnectedByUser || epoch !== _wsEpoch) {
      disconnectWs(created);
      return;
    }

    _ws = created;
  }

  /**
   * 处理 WS 消息 — 分发给所有注册的处理器
   */
  function handleWSMessage(data: unknown): void {
    for (const handler of _wsHandlers) {
      try {
        handler(data);
      } catch (e) {
        console.error('[useRealTime] WS handler error:', e);
      }
    }
  }

  /**
   * 处理 WS 连接状态变化
   */
  function handleWSStatus(connected: boolean): void {
    wsConnected.value = connected;
    if (connected) {
      if (sseConnected.value) {
        connectionState.value = 'connected';
      }
    } else {
      connectionState.value = 'disconnected';
    }
  }

  /**
   * 内部断开 WS (不触发外部重连逻辑,
   * createWsConnection 内部已有重连)
   *
   * 注意: createWsConnection 返回的 ws 对象在内部管理重连,
   * 所以我们不在这里调用 ws.onclose = null (内部已处理),
   * 而是直接使用 disconnectWs
   */
  function destroyWSInternal(): void {
    // 使任何"票据换取中"的异步建连结果失效
    _wsEpoch++;
    if (_ws) {
      disconnectWs(_ws);
      _ws = null;
    }
    wsConnected.value = false;
  }

  // ==================== 公共 API ====================

  /**
   * 建立连接 (SSE + WS)
   * 如果已连接会先断开重连
   */
  function connect(): void {
    _disconnectedByUser = false;
    void connectSSE();
    void connectWS();
  }

  /**
   * 断开所有连接 (停止重连)
   */
  function disconnect(): void {
    _disconnectedByUser = true;
    destroySSE();
    destroyWSInternal();
    connectionState.value = 'disconnected';
  }

  /**
   * 仅重连 SSE
   */
  function reconnectSSE(): void {
    _disconnectedByUser = false;
    destroySSE();
    void connectSSE();
  }

  /**
   * 仅重连 WS
   */
  function reconnectWS(): void {
    _disconnectedByUser = false;
    destroyWSInternal();
    void connectWS();
  }

  /**
   * 注册 SSE 消息监听
   */
  function onSSEMessage(handler: SSEMessageHandler): void {
    if (!_sseHandlers.includes(handler)) {
      _sseHandlers.push(handler);
    }
  }

  /**
   * 移除 SSE 消息监听
   */
  function offSSEMessage(handler: SSEMessageHandler): void {
    const idx = _sseHandlers.indexOf(handler);
    if (idx >= 0) {
      _sseHandlers.splice(idx, 1);
    }
  }

  /**
   * 注册 WS 消息监听
   */
  function onWSMessage(handler: WSMessageHandler): void {
    if (!_wsHandlers.includes(handler)) {
      _wsHandlers.push(handler);
    }
  }

  /**
   * 移除 WS 消息监听
   */
  function offWSMessage(handler: WSMessageHandler): void {
    const idx = _wsHandlers.indexOf(handler);
    if (idx >= 0) {
      _wsHandlers.splice(idx, 1);
    }
  }

  return {
    connectionState: readonly(connectionState),
    sseConnected: readonly(sseConnected),
    wsConnected: readonly(wsConnected),
    connect,
    disconnect,
    reconnectSSE,
    reconnectWS,
    onSSEMessage,
    offSSEMessage,
    onWSMessage,
    offWSMessage,
  };
}

// ==================== 单例 ====================

let _singleton: UseRealTimeReturn | null = null;

/**
 * 全局单例 useRealTime (跨组件共享同一个连接)
 *
 * 使用方式:
 *   // App.vue setup 中调用一次
 *   const rt = useRealTimeSingleton()
 *   rt.connect()
 *
 *   // 任意子组件
 *   const rt = useRealTimeSingleton()
 *   rt.onSSEMessage(handleSSEEvent)
 */
export function useRealTimeSingleton(): UseRealTimeReturn {
  if (!_singleton) {
    _singleton = useRealTime();
  }
  return _singleton;
}
