/**
 * 聊天会话 API
 *
 * 对应 /api/screen/session/* 接口:
 *   - list     GET  /api/screen/session/list
 *   - messages GET  /api/screen/session/{id}/messages
 *   - message  POST /api/screen/session/message
 *   - create   POST /api/screen/session/create
 *   - switch   POST /api/screen/session/switch
 *
 * FE-M9: 后端在不同版本/不同路由下可能返回裸数组、包装对象或不同的状态字段,
 * 这里统一做容错归一化, 避免前端因字段名差异而读到空列表。
 *
 * 使用方式:
 *   import { listSessions, sendMessage, ... } from '@/api/session'
 */

import { apiGet, apiPost } from '@/api/client';
import type { WebBackendId } from '@/api/backend';
import type { SessionInfo, ChatMessage } from '@/types';

// ==================== 类型 (内部使用, 不暴露给 types 层) ====================

interface SessionListApiResponse {
  local_sessions?: SessionInfo[];
  sessions?: SessionInfo[];
  current_session?: string;
  currentSession?: string;
  active_session?: string;
}

interface MessagesApiResponse {
  messages?: ChatMessage[];
  data?: ChatMessage[];
}

interface CreateSessionApiResponse {
  session_id?: string;
  id?: string;
  sessionId?: string;
  title?: string;
}

interface SendMessageApiResponse {
  status: string;
  [key: string]: unknown;
}

// ==================== 工具函数 ====================

/** 从字符串数组中取第一个非空字符串 */
function firstString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

/**
 * 归一化时间字段为可解析字符串
 *
 * 后端会话时间可能是 ISO 字符串, 也可能是 Unix 时间戳数字 (秒或毫秒,
 * 来自 Python time.time()), 统一转为 ISO 字符串供 formatRelativeTime 使用。
 * 空值/非法值返回 ''。
 */
function toTimeString(v: unknown): string {
  if (typeof v === 'string' && v) return v;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15) {
    return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  }
  return '';
}

/** 取第一个可解析的时间字段 (兼容字符串/数字) */
function firstTime(...values: unknown[]): string {
  for (const v of values) {
    const t = toTimeString(v);
    if (t) return t;
  }
  return '';
}

/**
 * 归一化单条会话对象 (C8: 会话 ID 归一化的唯一入口)
 *
 * 兼容 id/session_id/sessionId/uuid 等字段名, 统一对外输出规范字段 `id`,
 * 并保留 `session_id` 作为后端别名。所有会话对象的归一化都必须复用本函数,
 * 禁止在调用方内联重复映射, 避免 sessionID/session_id 处理不一致。
 */
export function normalizeSession(raw: unknown): SessionInfo {
  const s = (raw || {}) as Record<string, unknown>;
  const id = firstString(s.id, s.session_id, s.sessionId, s.uuid);
  const title = firstString(s.title, s.name, s.summary) || '新会话';
  // 时间优先取最近活动时间 (last_accessed/updated_at), 回退创建时间;
  // 后端为 Unix 时间戳数字, 经 firstTime 归一化为 ISO 字符串。
  const date = firstTime(
    s.date,
    s.last_accessed,
    s.lastAccessed,
    s.updated_at,
    s.updatedAt,
    s.created_at,
    s.createdAt,
  );
  const preview = firstString(s.preview, s.description, s.last_message);
  // W45: 通道归属标签——仅接受协议冻结的精确取值, 缺失/未知一律归 undefined
  // (视为未标注: 老后端条目继续走默认路由, 前端不会把猜测值带上请求线)。
  const rawBackend = s.backend;
  const backend = rawBackend === 'loom' || rawBackend === 'opencode' ? rawBackend : undefined;
  return {
    id,
    title,
    date,
    preview,
    active: s.active === true,
    session_id: firstString(s.session_id, s.id, s.sessionId) || undefined,
    created_at: firstTime(s.created_at, s.createdAt) || undefined,
    backend,
  };
}

/**
 * 从多种可能的响应形态中提取会话数组
 *
 * W45: 优先 sessions 键 (新契约: 双通道合并列表, 每条自带 backend 标签);
 * 无 sessions 键时回退 local_sessions (老后端仅 opencode, 响应无通道字段)。
 */
function extractSessions(result: unknown): SessionInfo[] {
  if (Array.isArray(result)) {
    return result.map(normalizeSession);
  }
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    const arr = r.sessions ?? r.local_sessions ?? r.data;
    if (Array.isArray(arr)) {
      return arr.map(normalizeSession);
    }
  }
  return [];
}

/** 判断"成功"类状态字符串 */
function isSuccessStatus(status: unknown): boolean {
  if (typeof status !== 'string') return false;
  return ['ok', 'success', 'updated', 'switched', 'created', 'done'].includes(status.toLowerCase());
}

// ==================== API 函数 ====================

/**
 * 获取会话列表 (容错: 裸数组 / local_sessions / sessions)
 * GET /api/screen/session/list
 */
export async function listSessions(): Promise<SessionInfo[] | null> {
  const result = await apiGet<SessionListApiResponse | SessionInfo[]>(
    '/api/screen/session/list',
  );
  if (result === null || result === undefined) return null;
  const sessions = extractSessions(result);
  // 裸数组或包装对象都视为成功 (空数组也返回 [], 便于调用方区分"空"与"失败")
  return sessions;
}

/**
 * 获取当前会话 ID (容错多种字段名)
 * GET /api/screen/session/list (复用同一个请求)
 */
export async function fetchCurrentSessionId(): Promise<string | null> {
  const result = await apiGet<SessionListApiResponse | SessionInfo[]>(
    '/api/screen/session/list',
  );
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const r = result as SessionListApiResponse;
    const cur = firstString(r.current_session, r.currentSession, r.active_session);
    if (cur) return cur;
  }
  return null;
}

/**
 * 获取会话历史消息 (容错: 裸数组 / {messages} / {data})
 * GET /api/screen/session/{sessionId}/messages
 *
 * @param sessionId 会话 ID
 * @param backend 可选, 会话归属通道 (W45: 有值时拼 ?backend=, 由后端路由到对应引擎)
 */
export async function getSessionMessages(
  sessionId: string,
  backend?: WebBackendId,
): Promise<ChatMessage[] | null> {
  const path =
    '/api/screen/session/' + encodeURIComponent(sessionId) + '/messages' +
    (backend ? '?backend=' + encodeURIComponent(backend) : '');
  const result = await apiGet<MessagesApiResponse | ChatMessage[]>(path);
  if (result === null || result === undefined) return null;
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.messages)) return result.messages;
  if (Array.isArray((result as MessagesApiResponse).data)) {
    return (result as MessagesApiResponse).data as ChatMessage[];
  }
  return null;
}

/**
 * 发送消息
 * POST /api/screen/session/message
 * body: { session_id, content, backend? }
 *
 * 注意: 原版使用 { message, session_id }, 这里统一为 content
 * W45: backend 来自调用方的 sid→通道 映射; undefined 时键完全不出现
 * (老后端/未标注会话保持原请求形态, 由后端按全局通道处理)。
 */
export async function sendMessage(body: {
  session_id: string;
  content: string;
  backend?: WebBackendId;
}): Promise<SendMessageApiResponse | null> {
  return apiPost<SendMessageApiResponse>('/api/screen/session/message', {
    message: body.content,
    session_id: body.session_id,
    ...(body.backend ? { backend: body.backend } : {}),
  });
}

/**
 * 创建新会话 (容错: session_id / id / sessionId)
 * POST /api/screen/session/create
 * body: { title }
 *
 * @returns 新会话 ID, 失败返回 null
 */
export async function createSession(
  title: string,
): Promise<string | null> {
  const result = await apiPost<CreateSessionApiResponse>(
    '/api/screen/session/create',
    { title },
  );
  if (result) {
    const id = firstString(result.session_id, result.id, result.sessionId);
    if (id) return id;
  }
  return null;
}

/**
 * 切换会话 (容错 status / success 字段)
 * POST /api/screen/session/switch
 * body: { session_id, backend? }
 *
 * W46: backend 来自调用方的 sid->通道 映射 (S3 盲区: engine 直建会话不在
 * 后端注册表, 纯 session_id 会被 404); undefined 时键完全不出现
 * (照 sendMessage 惯例, 未标注会话保持老请求形态, 后端按当前通道兜底)。
 *
 * @returns 是否成功
 */
export async function switchSession(
  sessionId: string,
  backend?: WebBackendId,
): Promise<boolean> {
  const result = await apiPost<Record<string, unknown>>(
    '/api/screen/session/switch',
    {
      session_id: sessionId,
      ...(backend ? { backend } : {}),
    },
  );
  if (result === null) return false;
  if (result.success === true || result.ok === true) return true;
  return isSuccessStatus(result.status);
}

/**
 * 重命名会话
 * POST /api/screen/session/update-title
 * body: { session_id, title }
 *
 * @returns 是否成功
 */
/**
 * 压缩会话（触发 OpenCode 上下文压缩）
 * POST /api/screen/session/{sessionId}/summarize
 *
 * @returns 成功返回 { status: 'compacting', session_id, message }, 失败返回 null
 */
export async function compactSession(
  sessionId: string,
  modelId?: string,
  providerId?: string,
  backend?: WebBackendId,
): Promise<Record<string, unknown> | null> {
  return apiPost<Record<string, unknown>>(
    '/api/screen/session/' + encodeURIComponent(sessionId) + '/summarize',
    {
      model_id: modelId,
      provider_id: providerId,
      ...(backend ? { backend } : {}),
    },
  );
}

export async function renameSession(
  sessionId: string,
  title: string,
): Promise<boolean> {
  const result = await apiPost<{ status?: string; success?: boolean }>(
    '/api/screen/session/update-title',
    { session_id: sessionId, title },
  );
  if (result === null) return false;
  if (result.success === true) return true;
  return isSuccessStatus(result.status);
}
