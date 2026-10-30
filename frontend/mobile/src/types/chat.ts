/**
 * 聊天会话/消息/SSE 流式类型
 *
 * 对应 /api/screen/session/* API 及 SSE /api/screen/events/stream
 */

import type { WebBackendId } from '@/api/backend'

// ==================== 会话类型 ====================

/** 单个会话信息 */
export interface SessionInfo {
  /**
   * 会话 ID (内部规范字段)
   *
   * C8: 会话归一化统一以 `id` 作为规范字段; 无论后端返回 id/session_id/sessionId,
   * normalizeSession 都会将其映射到此字段。
   */
  id: string;
  /** 会话标题 */
  title: string;
  /** 日期文本 (已格式化) */
  date: string;
  /** 预览文本 */
  preview: string;
  /** 当前是否激活 */
  active?: boolean;
  /** 服务端原始 session_id (兼容别名, 与 id 同值或来自后端的下划线字段) */
  session_id?: string;
  /** 创建时间 (ISO 字符串) */
  created_at?: string;
  /**
   * 会话归属的后端通道 (W45 双通道分账)
   *
   * 来自后端 list 条目的 backend 标签, 经 normalizeSession 精确匹配
   * 'opencode' | 'loom' 后透传; 缺失/未知取值 = undefined (老后端条目,
   * 视为未标注, 路由请求时不带 backend 参)。
   */
  backend?: WebBackendId;
}

/** /api/screen/session/list 响应 */
export interface SessionListResponse {
  local_sessions: SessionInfo[];
  current_session?: string;
}

/** 创建会话请求体 */
export interface CreateSessionRequest {
  title: string;
}

/** 创建会话响应 */
export interface CreateSessionResponse {
  session_id: string;
  title?: string;
}

/** 切换会话请求体 */
export interface SwitchSessionRequest {
  session_id: string;
}

// ==================== 消息类型 ====================

/** Token 用量统计 (来自 OpenCode info.tokens) */
export interface TokenUsage {
  total: number
  input: number
  output: number
  reasoning?: number
  cache?: {
    read: number
    write: number
  }
}

/** 消息角色 */
export type MessageRole = 'user' | 'assistant';

/** 消息 part 类型 */
export type MessagePartType =
  | 'text'
  | 'reasoning'
  | 'thought'
  | 'tool'
  | 'tool_call'
  | 'tool_result'
  | 'compaction';

/** 消息中的单个 part (用于结构化消息) */
export interface MessagePart {
  type: MessagePartType;
  /** part ID (OpenCode 原生, 用于流式更新/去重) */
  id?: string;
  /** 所属会话 ID */
  sessionID?: string;
  /** 所属消息 ID */
  messageID?: string;
  /** 工具调用 ID (tool part) */
  callID?: string;
  /** part 时间信息 (毫秒时间戳) */
  time?: {
    start?: number;
    end?: number;
  };
  text?: string;
  /** 工具名称 (tool/tool_call 类型) */
  tool?: string;
  /** 工具调用状态 */
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: string;
  };
  /** Loom 压缩分隔线携带的摘要正文 */
  summaryText?: string;
}

/** 单条聊天消息 */
export interface ChatMessage {
  /** 消息 ID (OpenCode message id, 用于稳定 key) */
  id?: string;
  /** 消息元信息 */
  info?: {
    role: MessageRole;
    /** 消息 ID (OpenCode message id) */
    id?: string;
    /** 时间信息 (OpenCode 原生, created 为毫秒时间戳) */
    time?: {
      created?: number;
      completed?: number;
    };
    /** Token 用量统计 (OpenCode info.tokens) */
    tokens?: TokenUsage;
    /** OpenCode 压缩摘要消息标记 */
    summary?: boolean;
    /** 消息模式；compaction 表示压缩摘要 */
    mode?: string;
  };
  /** 角色 (无 info 时使用此字段) */
  role?: MessageRole;
  /** 时间戳 (ISO 字符串) */
  timestamp?: string;
  /** 创建时间 (ISO 字符串) */
  created_at?: string;
  /** 纯文本内容 (无 parts 时使用) */
  content?: string;
  /** 纯文本内容 (备选字段) */
  text?: string;
  /** 结构化消息部分 */
  parts?: MessagePart[];
  /** 是否为流式进行中 (新架构: 占位符消息的标记) */
  isStreaming?: boolean;
  /** Token 用量统计 (来自 OpenCode SSE info.tokens) */
  tokens?: TokenUsage;
}

/** /api/screen/session/{id}/messages 响应 */
export interface MessagesResponse {
  messages: ChatMessage[];
}

// ==================== 流式折叠状态 ====================

/** 流式折叠状态映射 (partId -> boolean) */
export type StreamCollapsedMap = Record<string, boolean>;
