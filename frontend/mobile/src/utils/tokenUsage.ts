/**
 * Token 用量归一化
 *
 * OpenCode 的 info.tokens 在不同来源 (SSE 实时事件 / 历史消息接口) 下形态不一致:
 *   - 有的只提供 total;
 *   - 有的只提供 input/output (未提供 total);
 *   - 可能附带 reasoning / cache 明细。
 *
 * SSE 实时路径与历史/API 路径必须使用同一归一化逻辑, 否则两条路径写入
 * currentTokens 的形状不一致, 导致 UI 显示行为随数据来源而变化。本模块提供
 * 唯一的归一化入口: 接受 total 或 input/output, 在仅有分项时推导 total, 并
 * 统一输出 TokenUsage 规范形状。
 */

import type { TokenUsage } from '@/types'

/**
 * 将任意来源的原始 token 数据归一化为 TokenUsage。
 *
 * 规则:
 *   - 非对象 / 全 0 / 无有效数值 → 返回 null (视为没有用量, 不更新显示);
 *   - 仅有 input/output 而无 total 时, total = input + output (兼容
 *     useStreamingMessage 原有的分项行为);
 *   - reasoning / cache 仅在存在时附带, cache 归一化为 { read, write }。
 *
 * @param raw 原始 token 数据 (OpenCode info.tokens 等, 可能为任意形态)
 * @returns 规范化后的 TokenUsage; 无有效用量时返回 null
 */
export function normalizeTokenUsage(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== 'object') return null

  const t = raw as Record<string, unknown>
  const total = Number(t.total) || 0
  const input = Number(t.input) || 0
  const output = Number(t.output) || 0

  // 全部为 0 (含缺失) 视为没有有效用量
  if (total <= 0 && input <= 0 && output <= 0) return null

  // 仅有分项 (input/output) 时推导 total, 与 SSE 路径保持一致
  const resolvedTotal = total > 0 ? total : input + output

  const reasoning = t.reasoning !== undefined ? Number(t.reasoning) : undefined

  let cache: TokenUsage['cache']
  const rawCache = t.cache
  if (rawCache && typeof rawCache === 'object') {
    const c = rawCache as Record<string, unknown>
    cache = { read: Number(c.read) || 0, write: Number(c.write) || 0 }
  }

  return {
    total: resolvedTotal,
    input,
    output,
    reasoning,
    cache,
  }
}
