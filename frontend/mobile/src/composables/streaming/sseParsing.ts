/**
 * SSE 事件解析工具
 *
 * 从 useStreamingMessage 拆出的纯函数:
 *   - 会话状态解析 (session.status 的 status 字段形态不一)
 *   - 会话 ID 解析 (sessionID / session_id 双命名兼容, C8)
 *   - 错误消息提取
 *   - part 类型 / 索引查找
 *   - message.updated 的 token 用量提取 (复用共享归一化)
 */

import type { SSEProperties, MessagePart, TokenUsage } from '@/types'
import { normalizeTokenUsage } from '@/utils/tokenUsage'
import type { PartWithId } from './messageId'

/** 会话状态 */
export type SessionStatus = 'busy' | 'idle' | 'error'

/**
 * 解析会话状态 (T-C5)
 *
 * session.status 事件的 properties.status 实际为对象 { type: 'busy'|'idle'|'retry' },
 * 旧版事件可能直接传字符串。此处统一解析, 无法识别时安全回退 'idle'。
 */
export function parseSessionStatus(raw: unknown): SessionStatus {
  const value = raw && typeof raw === 'object'
    ? (raw as Record<string, unknown>).type
    : raw
  if (value === 'busy' || value === 'idle' || value === 'error') return value
  // retry 表示仍在处理, 映射为 busy (SessionStatus 无 retry)
  if (value === 'retry') return 'busy'
  return 'idle'
}

/**
 * 解析 SSE 事件所属会话 ID (C8: 会话 ID 解析的唯一入口)
 *
 * 兼容 sessionID (驼峰) 与 session_id (下划线) 两种命名, 统一返回单个字符串值。
 * 所有 SSE 事件读取会话 ID 都必须走此函数, 避免个别事件只认其中一种命名。
 */
export function resolveSessionId(props: SSEProperties | undefined): string {
  if (!props) return ''
  const value = props.sessionID ?? props.session_id
  return typeof value === 'string' ? value : ''
}

/** 从任意错误对象/字符串中提取可读错误消息 (T-C5) */
export function extractErrorMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>
    const data = e.data as Record<string, unknown> | undefined
    const candidate = e.message || data?.message || e.name
    if (typeof candidate === 'string' && candidate) return candidate
  }
  return ''
}

/** 判断是否为可渲染的 part 类型 (T-C5: 未知类型不创建占位符) */
export function isKnownPartType(partType: string): boolean {
  return (
    partType === 'reasoning' ||
    partType === 'thought' ||
    partType === 'text' ||
    partType === 'tool' ||
    partType === 'tool_call' ||
    partType === 'tool_result'
  )
}

/**
 * 在 parts 数组中按 _partId 查找索引 (线性查找，parts 通常 < 20 个)
 */
export function findPartIndex(parts: MessagePart[], partId: string): number {
  for (let i = 0; i < parts.length; i++) {
    if ((parts[i] as PartWithId)._partId === partId) return i
  }
  return -1
}

/**
 * 从 message.updated 事件中提取 token 用量 (C7)
 *
 * 使用共享归一化 (接受 total 或 input/output, 仅有分项时推导 total),
 * 无有效用量时返回 null。
 */
export function extractMessageTokens(props: SSEProperties): TokenUsage | null {
  const info = props.info as Record<string, unknown> | undefined
  if (!info?.tokens) return null
  return normalizeTokenUsage(info.tokens)
}
