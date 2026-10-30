/**
 * 工具行 / 工具结果卡的纯展示工具。
 *
 * 只做参数摘要、结果截断、状态文案和时长格式化；不读取 API、不推断
 * 结果数据。所有输出都按文本渲染，调用方不得把返回值当 HTML。
 */

import type { ToolResultView, ToolStatus } from '@/types/turn'
import { toolDescriptor } from './toolRegistry'

/** 结果卡内联展示上限；超过后只提供"打开完整输出" */
export const INLINE_RESULT_LIMIT = 1200

/** 参数卡内联展示上限；只防御极端超大入参，不替代完整输出浮层 */
export const INLINE_ARGS_LIMIT = 4000

export const TOOL_STATUS_LABELS: Record<ToolStatus, string> = {
  pending: '待执行',
  running: '执行中',
  completed: '完成',
  error: '失败',
  abandoned: '未返回',
}

export function toolStatusLabel(status: ToolStatus): string {
  return TOOL_STATUS_LABELS[status]
}

/** 组件间传递的完整输出打开请求 */
export interface ToolFocusPayload {
  title: string
  content: string
  bytes?: number
  truncated?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const text = value.trim()
    return text.length > 0 ? text : undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return undefined
}

export function oneLineText(value: string, limit = 160): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = stringValue(record[key])
    if (value !== undefined) {
      return value
    }
  }
  return undefined
}

const SECRET_KEY_PATTERN = /token|secret|password|authorization|api[-_]?key|cookie/i

export const REDACTED = '[redacted]'

export function redactUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item))
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      result[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactUnknown(child)
    }
    return result
  }
  return value
}

export function formatToolArguments(value: unknown, limit = INLINE_ARGS_LIMIT): string {
  if (value === undefined || value === null) {
    return '无参数'
  }

  let serialized: string
  try {
    const redacted = redactUnknown(value)
    serialized =
      typeof redacted === 'string'
        ? redacted
        : (JSON.stringify(redacted) ?? String(redacted))
  } catch {
    serialized = String(value)
  }

  return serialized.length > limit ? `${serialized.slice(0, limit)}…` : serialized
}

export function toolArgumentSummary(
  name: string,
  args: unknown,
  limit = 160,
): string {
  if (!isRecord(args)) {
    if (typeof args === 'string' && args.trim().length > 0) {
      return oneLineText(args, limit)
    }
    return oneLineText(formatToolArguments(args, limit), limit)
  }

  const params = isRecord(args.params) ? args.params : undefined
  const family = toolDescriptor(name).family
  let candidate: string | undefined

  switch (family) {
    case 'terminal':
      candidate = firstString(args, ['command', 'cmd', 'script'])
      break
    case 'read':
    case 'write':
    case 'edit':
    case 'image':
      candidate = firstString(args, ['path', 'file_path', 'file', 'filename', 'filePath', 'filepath'])
      break
    case 'search':
      candidate = firstString(args, ['query', 'pattern', 'q'])
      break
    case 'web':
      candidate = firstString(args, ['url', 'href'])
      break
    case 'subagent':
      candidate = firstString(args, ['title', 'task', 'agent_type', 'agentType', 'description'])
      break
    case 'todo': {
      const todos = Array.isArray(args.todos) ? args.todos : undefined
      if (todos !== undefined) {
        const first = isRecord(todos[0]) ? todos[0] : undefined
        const content = first === undefined ? undefined : firstString(first, ['content'])
        candidate = content ?? `${todos.length} 项待办`
      }
      break
    }
    case 'skill':
      candidate = firstString(args, ['name', 'skill'])
      break
    case 'generic':
      candidate =
        params === undefined
          ? undefined
          : firstString(params, ['message', 'name', 'title', 'target_name', 'target_id'])
      break
  }

  if (candidate === undefined) {
    candidate = formatToolArguments(args, limit)
  }

  return oneLineText(candidate, limit)
}

export function isOmittedImageText(text: string): boolean {
  return /^data:image\/[^;,]+;base64,/i.test(text.trim())
}

export function inlineResultText(result: ToolResultView): string {
  if (isOmittedImageText(result.text)) {
    return '图片数据已省略（不渲染 base64）'
  }
  const text = result.text
  return text.length > INLINE_RESULT_LIMIT ? text.slice(0, INLINE_RESULT_LIMIT) : text
}

export function resultNeedsFocus(result: ToolResultView): boolean {
  return (
    result.truncated === true ||
    (result.totalChars !== undefined && result.totalChars >= INLINE_RESULT_LIMIT) ||
    result.text.length >= INLINE_RESULT_LIMIT
  )
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return ''
  }

  if (ms < 1000) {
    return '<1s'
  }

  const seconds = ms / 1000
  if (seconds < 60) {
    return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`
  }

  const totalSeconds = Math.floor(seconds)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const remainder = totalSeconds % 60

  if (hours > 0) {
    return remainder > 0
      ? `${hours}h ${minutes}m ${remainder}s`
      : minutes > 0
        ? `${hours}h ${minutes}m`
        : `${hours}h`
  }

  return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`
}

const clockFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

export function formatClockTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) {
    return ''
  }
  return clockFormatter.format(new Date(ms))
}

export function byteLength(text: string): number {
  if (typeof TextEncoder === 'undefined') {
    return text.length
  }
  return new TextEncoder().encode(text).length
}
