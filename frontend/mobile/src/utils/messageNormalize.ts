/**
 * 历史消息归一化
 *
 * 后端 /api/screen/session/{id}/messages 直接返回 OpenCode 原生消息结构:
 *   { info: { id, role, time: { created }, tokens? }, parts: [...] }
 * 其中创建时间是毫秒时间戳 (info.time.created), 而 SSE 实时消息使用
 * ChatMessage.timestamp (ISO 字符串, 见 useStreamingMessage 占位符)。
 *
 * 若不归一化, 历史消息既没有 timestamp/created_at, 消费者只能显示"未知日期"。
 * 本模块把 OpenCode 原生消息映射为统一的 ChatMessage 形态, 使历史与实时
 * 两条路径的时间表示一致 (timestamp 为 ISO 字符串)。
 *
 * 归一化对已符合 ChatMessage 形态的输入 (顶层 role/content/timestamp) 同样
 * 兼容: 通过展开原消息保留已有字段, 只补充/覆盖 id、info、timestamp、
 * isStreaming, 不丢失任何既有字段。
 */

import type { ChatMessage, MessagePart, MessageRole, TokenUsage } from '@/types'

/**
 * OpenCode 原生消息 info (历史接口返回)
 *
 * 除声明字段外还会携带 sessionID/model/cost 等字段, 归一化时通过展开原样保留。
 */
export interface RawHistoryInfo {
  /** 消息 ID */
  id?: string
  /** 消息角色 */
  role?: MessageRole
  /** 时间信息 (created 为毫秒时间戳) */
  time?: {
    created?: number | string
    completed?: number
  }
  /** Token 用量统计 */
  tokens?: TokenUsage
  /** 压缩摘要消息标记 */
  summary?: boolean
  /** 消息模式；compaction 表示压缩摘要 */
  mode?: string
}

/**
 * 历史消息输入 (兼容两种形态)
 *
 * - OpenCode 原生: 字段在 info/parts 内, 时间戳在 info.time.created (毫秒)
 * - 已归一化:    字段在顶层 (role/content/timestamp/created_at)
 */
export interface RawHistoryMessage {
  /** 消息 ID (已归一化形态的顶层 id) */
  id?: string
  /** 消息元信息 (OpenCode 原生) */
  info?: RawHistoryInfo
  /** 结构化消息部分 (原样透传) */
  parts?: MessagePart[]
  /** 角色 (已归一化形态) */
  role?: MessageRole
  /** 时间戳 (已归一化形态, ISO 字符串) */
  timestamp?: string
  /** 创建时间 (已归一化形态, ISO 字符串) */
  created_at?: string
  /** 纯文本内容 (已归一化形态) */
  content?: string
  /** 纯文本内容备选字段 (已归一化形态) */
  text?: string
  /** 是否流式进行中 */
  isStreaming?: boolean
}

/**
 * 把毫秒时间戳 (或 ISO/日期字符串) 转为 ISO 字符串。
 *
 * @param created 原始创建时间 (通常为毫秒时间戳)
 * @returns ISO 字符串; 缺失或无法解析时返回 undefined
 */
function _toIsoTimestamp(created: number | string | undefined): string | undefined {
  if (typeof created === 'number') {
    if (!Number.isFinite(created)) return undefined
    const date = new Date(created)
    return isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  if (typeof created === 'string' && created) {
    const date = new Date(created)
    return isNaN(date.getTime()) ? undefined : date.toISOString()
  }
  return undefined
}

/**
 * 将一条历史消息归一化为 ChatMessage。
 *
 * 映射规则:
 *   - id: 优先取 raw.info.id, 回退顶层 raw.id
 *   - timestamp: 优先由 raw.info.time.created (毫秒) 转 ISO, 回退已有 timestamp/created_at
 *   - info / parts 及其余字段: 原样保留 (info 额外补全 role, 避免角色缺失)
 *   - isStreaming: 历史消息一律为 false (流式状态由 SSE 事件驱动)
 *
 * @param raw 历史消息 (OpenCode 原生或已归一化形态)
 * @returns 归一化后的 ChatMessage
 */
export function normalizeHistoryMessage(raw: RawHistoryMessage): ChatMessage {
  const rawInfo = raw.info
  const timestamp =
    _toIsoTimestamp(rawInfo?.time?.created) ?? raw.timestamp ?? raw.created_at

  return {
    // 展开原消息, 保留 content/text/created_at 等既有字段
    ...raw,
    id: rawInfo?.id ?? raw.id,
    info: rawInfo
      ? {
          ...rawInfo,
          role: rawInfo.role ?? 'assistant',
          // info.time.created 统一为数值 (毫秒), 与 ChatMessage.info 类型对齐
          time: rawInfo.time
            ? {
                created:
                  typeof rawInfo.time.created === 'number'
                    ? rawInfo.time.created
                    : undefined,
                completed: rawInfo.time.completed,
              }
            : undefined,
        }
      : undefined,
    timestamp,
    // parts 原样透传 (保留 OpenCode 原生字段, 不做裁剪)
    parts: raw.parts,
    isStreaming: false,
  }
}

/**
 * 批量归一化历史消息。
 *
 * @param rawList 历史消息数组 (OpenCode 原生或已归一化形态)
 * @returns 归一化后的 ChatMessage 数组 (与输入等长)
 */
export function normalizeHistoryMessages(rawList: RawHistoryMessage[]): ChatMessage[] {
  return rawList.map(normalizeHistoryMessage)
}
