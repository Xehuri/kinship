/**
 * 聊天会话 Composable — 会话列表、当前会话、消息管理
 *
 * 管理会话列表 (sessions)、当前会话 ID、消息历史。
 * 与 useStreamingMessage 配合处理 SSE 流式回复。
 *
 * 使用方式:
 *   const { sessions, currentSessionId, messages, sendMessage, switchSession } = useChat()
 *   await loadSessions()
 *   await switchSession('session-id')
 *   await sendMessage('你好')
 *
 * 结构: 历史合并 / 历史响应解析 / 会话列表归一化 已拆分到 ./chat/ 下,
 * 本文件保留会话状态与对外 API。
 */

import { ref, computed, readonly, type Ref, type ComputedRef } from 'vue';
import type { SessionInfo, ChatMessage } from '@/types';
import {
  sendMessage as apiSendMessage,
  createSession as apiCreateSession,
  switchSession as apiSwitchSession,
  renameSession as apiRenameSession,
  compactSession as apiCompactSession,
} from '@/api/session';
import { apiGet, apiGetVerbose, apiUpload } from '@/api/client';
import { fetchWebBackend, type WebBackendId } from '@/api/backend';
import { useStreamingMessageSingleton, createLocalMessageId, getStableMessageId } from '@/composables/useStreamingMessage';
import { normalizeHistoryMessages } from '@/utils/messageNormalize';
import { mergeChatMessages, prependChatMessages } from './chat/historyMerge';
import { extractLatestHistoryTokens, parseHistoryResponse, type HistoryResponseData } from './chat/historyParsing';
import { normalizeSessionList, resolveCurrentSessionId } from './chat/sessionList';

// 供 ChatView 生成稳定列表 key (C4)
export { getStableMessageId };

// ==================== 类型定义 ====================

/** useChat 返回值 */
export interface UseChatReturn {
  /** 会话列表 */
  sessions: Ref<SessionInfo[]>;
  /** 当前会话 ID */
  currentSessionId: Ref<string>;
  /** 当前会话标题 (computed) */
  currentSessionTitle: ComputedRef<string>;
  /** 当前会话消息列表 */
  messages: Ref<ChatMessage[]>;
  /** 正在加载消息历史 */
  loadingMessages: Readonly<Ref<boolean>>;
  /** 正在发送消息 */
  sendingMessage: Readonly<Ref<boolean>>;
  /** 正在加载更早的消息历史 (分页) */
  loadingMoreMessages: Readonly<Ref<boolean>>;
  /** 更早一页的翻页游标 (null 表示没有更早消息) */
  nextCursor: Readonly<Ref<string | null>>;
  /** 是否还有更早历史可加载 (nextCursor 非空) */
  hasMoreHistory: ComputedRef<boolean>;
  /**
   * 加载会话列表
   * 自动设置 currentSessionId 为 API 返回的当前会话
   */
  loadSessions: () => Promise<void>;
  /**
   * 切换会话
   * 清理流式状态, 加载会话历史
   * @param sessionId 目标会话 ID
   */
  switchSession: (sessionId: string) => Promise<void>;
  /**
   * 创建新会话
   * @param title 会话标题 (默认 '新会话')
   * @returns 新会话 ID, 失败返回 null
   */
  createNewSession: (title?: string) => Promise<string | null>;
  /**
   * 加载会话历史消息
   * @param sessionId 会话 ID
   * @param before 可选, 更早一页的翻页游标 (传入时前插更早消息, 不显示骨架屏)
   */
  loadChatHistory: (sessionId: string, before?: string) => Promise<void>;
  /**
   * 加载更早的消息历史 (分页)
   * 使用 nextCursor 作为 before 游标, 将更早消息前插到列表头部
   */
  loadMoreHistory: () => Promise<void>;
  /**
   * 发送消息（可选附带多个文件）
   * 发送后等待 SSE 流式回复, 完成后重新加载历史
   * @param text 消息文本
   * @param files 可选的文件数组
   * @returns 是否发送成功
   */
  sendMessage: (text: string, files?: File[]) => Promise<boolean>;
  /**
   * 清除聊天消息 (本地)
   */
  clearMessages: () => void;
  /**
   * 重命名当前会话
   * @param sessionId 会话 ID
   * @param newTitle 新标题
   * @returns 是否成功
   */
  renameSession: (sessionId: string, newTitle: string) => Promise<boolean>;
  /**
   * 压缩会话 (触发 OpenCode 上下文压缩)
   * 供 ChatView 经 composable 调用, 避免组件直接依赖 api 层
   * @param sessionId 会话 ID
   * @param modelId 可选模型 ID
   * @param providerId 可选提供方 ID
   * @returns 成功返回状态对象, 失败返回 null
   */
  compactSession: (
    sessionId: string,
    modelId?: string,
    providerId?: string,
  ) => Promise<Record<string, unknown> | null>;
  /**
   * 初始化流式消息系统 (注入 messages/activeSessionId refs)
   * 在 ChatView onMounted 中调用
   */
  initStreaming: () => void;
}

// ==================== 双通道分账路由 (W45) ====================

/**
 * sid -> 会话归属后端 的模块级映射 (双通道分账的路由唯一真源)。
 *
 * 会话一旦从 list 条目 / 乐观新建确认归属, 发消息/历史/children 请求都按此
 * 带 backend 参, 不再受"当前开关"影响——通道被翻后旧 sid 打错后端 404 的
 * 事故线 (07-15 07:17) 的正面修法。未登记 (undefined) = 未标注: 请求不带
 * backend, 由后端按全局通道处理 (老后端行为不变)。
 */
const sessionBackends = new Map<string, WebBackendId>();

/** 新建会话的默认通道; null=尚未种上 (GET /backend 失败或还没查过) */
let defaultBackend: WebBackendId | null = null;

/** 读取会话归属通道 (useSubAgents 等邻居模块的唯一访问面) */
export function getSessionBackend(sessionId: string): WebBackendId | undefined {
  return sessionBackends.get(sessionId);
}

/** 登记会话归属通道 (backend 为空时忽略, 不做删除——归属只会确认不会退回未知) */
export function setSessionBackend(sessionId: string, backend: WebBackendId | undefined): void {
  if (sessionId && backend) sessionBackends.set(sessionId, backend);
}

/**
 * 种一次默认通道: GET /api/screen/backend (api/backend.ts 的只读查询)。
 *
 * 绝不 POST——切换通道只能由用户在设置页显式发起; 这里只读当前值,
 * 供新建会话乐观标注。种上后不再重复请求。
 */
async function ensureDefaultBackendSeeded(): Promise<void> {
  if (defaultBackend !== null) return;
  const state = await fetchWebBackend();
  if (state) defaultBackend = state.backend;
}

// ==================== Composable ====================

/**
 * 聊天会话 Composable — 会话列表、当前会话、消息管理
 *
 * 封装会话 CRUD 和消息发送, 与 useStreamingMessage 配合处理流式回复。
 */
export function useChat(): UseChatReturn {
  const sessions = ref<SessionInfo[]>([]);
  const currentSessionId = ref<string>('');
  const messages = ref<ChatMessage[]>([]);
  const loadingMessages = ref(false);
  const sendingMessage = ref(false);
  const loadingMoreMessages = ref(false);
  /** 更早一页的翻页游标 (null 表示没有更早消息) */
  const nextCursor = ref<string | null>(null);

  /** 是否还有更早历史可加载 */
  const hasMoreHistory = computed<boolean>(
    () => nextCursor.value !== null && nextCursor.value !== '',
  );

  /** 当前会话标题 */
  const currentSessionTitle = computed<string>(() => {
    const cur = sessions.value.find((s) => s.id === currentSessionId.value);
    return cur?.title || '';
  });

  // ==================== 会话管理 ====================

  /**
   * 加载会话列表
   *
   * 调用 /api/screen/session/list
   * 自动设置当前会话 ID
   *
   * W45: 初始化链里顺带种一次默认通道 (仅 GET); 每次列表的全部条目
   * 按 backend 标签填 sid->通道 映射 (无标条目不动已有登记)。
   */
  async function loadSessions(): Promise<void> {
    try {
      await ensureDefaultBackendSeeded()
      const payload = await apiGet<{
        sessions?: SessionInfo[]
        local_sessions?: SessionInfo[]
        current_session?: string
      }>('/api/screen/session/list')
      // W45: 优先 sessions 键 (新契约合并列表), 无则回退 local_sessions (老后端)
      const list = payload?.sessions ?? payload?.local_sessions
      if (list && list.length > 0) {
        // C8: 复用 api/session 的 normalizeSession 作为唯一归一化来源
        // (后端可能返回 session_id 或 id, 统一映射为内部规范字段 id)
        const normalized = normalizeSessionList(list)
        sessions.value = normalized
        // W45: 全部带标条目写入 sid->backend 映射 (会话归属真源)
        for (const s of normalized) {
          setSessionBackend(s.id, s.backend)
        }
        // 优先使用后端返回的 current_session
        currentSessionId.value = resolveCurrentSessionId(
          sessions.value,
          payload?.current_session,
          currentSessionId.value,
        )
        // 同步 SSE 活跃会话过滤
        if (currentSessionId.value) {
          const sm = useStreamingMessageSingleton()
          sm.setActiveSessionId(currentSessionId.value)
        }
      }
    } catch (e) {
      console.error('[useChat] 加载会话列表失败:', e)
    }
  }

  /**
   * 切换会话
   *
   * 1. 请求 API switch (失败则保留当前状态, 不做任何本地变更)
   * 2. 清理流式状态 (useStreamingMessage) 并清空旧消息
   * 3. 加载会话历史
   *
   * @param sessionId 目标会话 ID
   */
  async function switchSession(sessionId: string): Promise<void> {
    if (!sessionId) return

    // 1. 先请求后端切换 (C4): 失败则直接返回, 不改变任何本地状态,
    //    避免把 currentSessionId/消息列表改成与后端不一致的"半切换"状态。
    //    W46: 统一转发映射查询结果——命中则带该 sid 归属通道 (engine 直建
    //    会话靠它让后端核验/收编), 未命中传 undefined, api 层键不出现=老形状。
    let switched = false
    try {
      switched = await apiSwitchSession(sessionId, getSessionBackend(sessionId))
    } catch (e) {
      console.error('[useChat] API 切换会话失败:', e);
    }
    if (!switched) {
      console.warn('[useChat] 切换会话失败, 保留当前会话状态');
      return;
    }

    // 2. 切换成功: 标记现有流式消息完成并设置活跃会话
    const streamingMsg = messages.value.find(m => m.isStreaming === true)
    if (streamingMsg) streamingMsg.isStreaming = false
    const sm = useStreamingMessageSingleton();
    // 切会话时 resolve 掉旧的 pending promise (FE-H5), 避免旧请求永久悬挂
    sm.finalizeStreaming();
    sm.setActiveSessionId(sessionId);
    // C7: 重置 token 显示, 避免上一个会话的用量泄漏到新会话
    // (若新会话历史含 tokens, loadChatHistory 会立即用其覆盖)
    sm.updateTokens(null);

    // 3. 清空旧会话消息, 避免旧消息残留/与新会话历史混合
    messages.value = [];
    nextCursor.value = null;

    // 4. 更新本地状态
    currentSessionId.value = sessionId;
    sessions.value = sessions.value.map((s) => ({
      ...s,
      active: s.id === sessionId,
    }));

    // 5. 加载新会话历史
    await loadChatHistory(sessionId);
  }

  /**
   * 创建新会话
   *
   * 1. 清理流式状态
   * 2. 调用 API 创建
   * 3. 添加到会话列表头部
   * 4. 切换为新会话
   *
   * @param title 会话标题 (默认 '新会话')
   * @returns 新会话 ID, 失败返回 null
   */
  async function createNewSession(title = '新会话'): Promise<string | null> {
    // 标记现有流式消息完成
    const streamingMsg = messages.value.find(m => m.isStreaming === true)
    if (streamingMsg) streamingMsg.isStreaming = false
    const sm = useStreamingMessageSingleton();
    // 切到新会话前 resolve 旧 pending promise (FE-H5)
    sm.finalizeStreaming();

    try {
      const sessionId = await apiCreateSession(title);
      if (sessionId) {
        // W45: 乐观按默认通道标注新会话 (后端会在全局通道上创建它);
        // 列表刷新后由后端返回的 backend 标签对账修正。
        setSessionBackend(sessionId, defaultBackend ?? undefined)
        // 添加到列表头部
        sessions.value.unshift({
          id: sessionId,
          title,
          date: '今日',
          preview: '',
          active: true,
          backend: defaultBackend ?? undefined,
        });
        // 其他标记为非活跃
        sessions.value = sessions.value.map((s) => ({
          ...s,
          active: s.id === sessionId,
        }));
        currentSessionId.value = sessionId;
        sm.setActiveSessionId(sessionId);
        // C7: 新会话没有历史用量, 重置 token 显示避免沿用上一个会话
        sm.updateTokens(null);
        messages.value = [];
        nextCursor.value = null;
        return sessionId;
      }
    } catch (e) {
      console.error('[useChat] 创建会话失败:', e);
    }

    return null;
  }

  // ==================== 消息管理 ====================

  /**
   * 加载会话历史消息 (FE-M1)
   *
   * 使用带状态码的 apiGetVerbose 区分失败类型, 避免把临时故障当成"空会话"
   * 而清空用户已看到的历史:
   *   - 2xx + 合法数组: 与现有消息按 id 合并 (C4, 保留流式占位符, 避免重复);
   *     传入 before 时改为前插更早一页并去重 (分页)
   *   - 2xx 但结构异常: 视为空会话, 清空
   *   - 401: 保留旧数据 (由 auth fail 回调弹登录)
   *   - 404: 会话不存在/已删除, 清空
   *   - 5xx / 网络错误 (status=0): 保留旧数据
   *
   * @param sessionId 会话 ID
   * @param before 可选, 更早一页的翻页游标 (来自上一次响应的 next_cursor)
   */
  async function loadChatHistory(sessionId: string, before?: string): Promise<void> {
    if (!sessionId) return;

    // 只有首次加载 (无 before) 才显示骨架屏; 加载更早的历史不清空/遮挡当前消息
    const isInitialLoad = !before;
    if (isInitialLoad) loadingMessages.value = true;
    const sm = useStreamingMessageSingleton();
    try {
      const basePath = '/api/screen/session/' + encodeURIComponent(sessionId) + '/messages';
      // W45: 已知归属的会话带 ?backend= 出线; before 游标与 backend 统一经
      // URLSearchParams 拼接, 未映射时查询串自然为空 (老行为不变)。
      const params = new URLSearchParams();
      if (before) params.set('before', before);
      const historyBackend = getSessionBackend(sessionId);
      if (historyBackend) params.set('backend', historyBackend);
      const query = params.toString();
      const path = query ? basePath + '?' + query : basePath;
      const r = await apiGetVerbose<HistoryResponseData>(path);

      if (r.ok) {
        const parsed = parseHistoryResponse(r.data);
        if (parsed.messages) {
          // 归一化 OpenCode 原生历史消息: 时间戳在 info.time.created (毫秒),
          // 统一映射为与 SSE 实时消息一致的 ChatMessage 形态 (timestamp 为 ISO 字符串),
          // 并确保历史消息不携带 isStreaming 标志 (流式状态由 SSE 事件驱动)
          const normalized = normalizeHistoryMessages(parsed.messages);
          if (before) {
            // 分页: 前插更早消息到列表头部, 保持时间顺序并按 id 去重
            messages.value = prependChatMessages(normalized, messages.value);
          } else {
            // C4: 按稳定 id 合并 (而非整体覆盖), 保留仍在流式渲染的占位符, 避免历史 + SSE 重复
            messages.value = mergeChatMessages(normalized, messages.value);
          }
          // 记录翻页游标 (仅在成功解析时更新)
          nextCursor.value = parsed.cursor;

          // 路径2: 从消息历史中提取最新 assistant 消息的 tokens (仅首次加载)
          // C7: 使用共享归一化 (接受 total 或 input/output, 仅有分项时推导 total),
          //     与 SSE 实时路径保持一致, 不再要求 tokens.total > 0 才是唯一有效形态。
          if (isInitialLoad) {
            const tokens = extractLatestHistoryTokens(normalized);
            if (tokens) {
              sm.updateTokens(tokens);
            }
          }
        } else {
          // 200 但响应结构异常: 视为空会话, 清空
          messages.value = [];
          nextCursor.value = null;
          sm.updateTokens(null);
        }
      } else if (r.status === 401) {
        // 未认证: 保留旧数据, 交由 auth fail 回调处理
        console.warn('[useChat] 加载消息历史 401, 保留现有消息');
      } else if (r.status === 404) {
        // 会话不存在/已删除: 清空
        messages.value = [];
        nextCursor.value = null;
        sm.updateTokens(null);
      } else {
        // 5xx / 网络错误 (status=0): 保留旧数据
        console.warn('[useChat] 加载消息历史失败 (status=' + r.status + '), 保留现有消息');
      }
    } catch (e) {
      // 异常时保留旧数据, 避免清空
      console.error('[useChat] 加载消息历史异常:', e);
    } finally {
      if (isInitialLoad) loadingMessages.value = false;
    }
  }

  /**
   * 加载更早的消息历史 (分页)
   *
   * 使用当前 nextCursor 作为 before 游标, 拉取更早一页并前插到列表头部,
   * 加载期间不显示骨架屏 (避免遮挡/清空当前消息), 由调用方负责保持滚动位置。
   */
  async function loadMoreHistory(): Promise<void> {
    if (loadingMoreMessages.value) return;
    const before = nextCursor.value;
    const sessionId = currentSessionId.value;
    // 无游标 (没有更早消息) 或没有当前会话时不请求
    if (!before || !sessionId) return;

    loadingMoreMessages.value = true;
    try {
      await loadChatHistory(sessionId, before);
    } finally {
      loadingMoreMessages.value = false;
    }
  }

  /**
   * 发送消息（可选附带多个文件）
   *
   * 1. 如果有文件，先逐个上传获取路径
   * 2. 将所有文件路径拼入消息文本开头
   * 3. 调用 API 发送消息
   * 4. 等待 SSE 流式回复
   * 5. 完成后构建流式消息并追加到列表
   *
   * @param text 消息文本
   * @param files 可选的文件数组
   * @returns 是否发送成功
   */
  async function sendMessage(text: string, files?: File[]): Promise<boolean> {
    // 既没有文本也没有文件，不允许发送
    if (!text.trim() && (!files || files.length === 0)) return false;

    // 无当前会话时先自动创建, 避免发送静默失败
    if (!currentSessionId.value) {
      const createdId = await createNewSession();
      if (!createdId) return false;
    }

    const sm = useStreamingMessageSingleton();

    // 标记旧的流式消息完成
    const oldStreaming = messages.value.find(m => m.isStreaming === true)
    if (oldStreaming) oldStreaming.isStreaming = false

    sendingMessage.value = true;

    try {
      // 构建最终消息文本
      let finalText = text.trim();

      // 如果有文件，逐个上传
      if (files && files.length > 0) {
        const fileInfos: string[] = []
        for (const f of files) {
          const uploadResult = await apiUpload(f)
          if (uploadResult && uploadResult.status === 'ok') {
            fileInfos.push(uploadResult.file_path.replace(/\\/g, '/'))
          } else {
            sendingMessage.value = false
            return false
          }
        }
        const fileLines = fileInfos.map((p) => `- ${p}`).join('\n')
        finalText = `[用户上传了 ${files.length} 个文件:]\n${fileLines}\n` + (finalText || '(无文字)')
      }

      // 先将用户消息加入列表 (显示为 user 气泡)
      messages.value = [...messages.value, {
        role: 'user' as const,
        content: finalText,
        timestamp: new Date().toISOString(),
      }]

      // 创建 AI 占位符消息 (插入 messages，SSE 事件直接在 messages.value 中更新其 parts)
      const placeholder: ChatMessage = {
        id: createLocalMessageId(),
        role: 'assistant',
        parts: [],
        isStreaming: true,
        timestamp: new Date().toISOString(),
      }
      messages.value = [...messages.value, placeholder]

      // 创建 pending promise (SSE 完成时 resolve)
      const pending = sm.createPendingPromise();

      // 发送消息 (W45: 已知归属的会话带上 backend 通道参, 未标注时键不出现)
      const sendBackend = getSessionBackend(currentSessionId.value)
      const result = await apiSendMessage({
        session_id: currentSessionId.value,
        content: finalText,
        ...(sendBackend ? { backend: sendBackend } : {}),
      });

      if (!result) {
        placeholder.isStreaming = false
        sendingMessage.value = false;
        return false;
      }

      // 等待 SSE 流式回复完成 (SSE handler 直接在 messages.value 中更新 parts)
      await pending;

      // placeholder 已在 messages.value 中，finalizeStreaming 已标记 isStreaming=false
      return true;
    } catch (e) {
      console.error('[useChat] 发送消息失败:', e);
      // 标记流式消息完成
      const failMsg = messages.value.find(m => m.isStreaming === true)
      if (failMsg) failMsg.isStreaming = false
      return false;
    } finally {
      sendingMessage.value = false;
    }
  }

  /**
   * 清除聊天消息 (本地)
   */
  function clearMessages(): void {
    messages.value = [];
    nextCursor.value = null;
  }

  /**
   * 重命名会话
   */
  async function renameSession(sessionId: string, newTitle: string): Promise<boolean> {
    if (!sessionId || !newTitle.trim()) return false;
    try {
      const ok = await apiRenameSession(sessionId, newTitle.trim());
      if (ok) {
        sessions.value = sessions.value.map((s) =>
          s.id === sessionId ? { ...s, title: newTitle.trim() } : s,
        );
      }
      return ok;
    } catch (e) {
      console.error('[useChat] 重命名会话失败:', e);
      return false;
    }
  }

  /**
   * 压缩会话 (触发 OpenCode 上下文压缩)
   *
   * 供组件经 composable 调用, 保持 UI -> composable -> api 的依赖方向。
   */
  async function compactSession(
    sessionId: string,
    modelId?: string,
    providerId?: string,
  ): Promise<Record<string, unknown> | null> {
    return apiCompactSession(sessionId, modelId, providerId, getSessionBackend(sessionId));
  }

  // ==================== 流式消息系统初始化 ====================

  /**
   * 初始化流式消息系统
   * 注入 messages ref 和 currentSessionId ref，
   * 使 SSE 事件能直接在 messages.value 中找到并更新流式消息。
   */
  function initStreaming(): void {
    const sm = useStreamingMessageSingleton();
    sm.configure({
      messages,
      activeSessionId: currentSessionId,
    });
  }

  return {
    sessions,
    currentSessionId,
    currentSessionTitle,
    messages,
    loadingMessages: readonly(loadingMessages),
    sendingMessage: readonly(sendingMessage),
    loadingMoreMessages: readonly(loadingMoreMessages),
    nextCursor: readonly(nextCursor),
    hasMoreHistory,
    loadSessions,
    switchSession,
    createNewSession,
    loadChatHistory,
    loadMoreHistory,
    sendMessage,
    clearMessages,
    renameSession,
    compactSession,
    initStreaming,
  };
}

// ==================== 单例 ====================

let _singleton: UseChatReturn | null = null;

/**
 * 全局单例 useChat (跨组件共享同一个会话状态)
 *
 * 使用方式:
 *   const chat = useChatSingleton()
 *   await chat.loadSessions()
 */
export function useChatSingleton(): UseChatReturn {
  if (!_singleton) {
    _singleton = useChat();
  }
  return _singleton;
}
