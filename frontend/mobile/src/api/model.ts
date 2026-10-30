/**
 * 模型上下文窗口 API
 *
 * GET /api/screen/model/context-window
 *   200 { success, backend, model, provider, contextWindow|null }
 *
 * 后端任何失败都返回 200 + 全 null, 因此前端不猜测窗口大小:
 * 只有有限正整数才作为有效 contextWindow, 其余一律 null。
 * 结果模块级缓存 60s, 请求失败时清空缓存供下次重试。
 */

import { apiGet } from '@/api/client'

/** 上下文窗口信息 (仅保留展示所需字段) */
export interface ContextWindowInfo {
  model: string | null
  provider: string | null
  contextWindow: number | null
}

/** 缓存有效期 */
const CACHE_TTL_MS = 60_000

interface CacheEntry {
  data: ContextWindowInfo
  fetchedAt: number
}

let cache: CacheEntry | null = null

/** 清除缓存 (测试或需要强制刷新时使用) */
export function resetContextWindowCache(): void {
  cache = null
}

function normalizeText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function normalizeWindow(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : null
}

function normalizeInfo(raw: unknown): ContextWindowInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  return {
    model: normalizeText(record.model),
    provider: normalizeText(record.provider),
    contextWindow: normalizeWindow(record.contextWindow),
  }
}

/**
 * 查询当前 Web 通道主模型的上下文窗口。
 *
 * @returns 归一化结果; 请求失败或响应无法解析时 null (并清空缓存)
 */
export async function fetchContextWindow(): Promise<ContextWindowInfo | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data
  }

  try {
    const raw = await apiGet<Record<string, unknown>>('/api/screen/model/context-window')
    const info = normalizeInfo(raw)
    if (!info) {
      cache = null
      return null
    }
    cache = { data: info, fetchedAt: Date.now() }
    return info
  } catch (e) {
    console.warn('[model] 查询上下文窗口失败:', e)
    cache = null
    return null
  }
}
