/**
 * 数据源健康 API
 *
 * 对应后端 GET /api/sources/health (T2B):
 *   200 { generated_at, sources: [{ id, name, status, last_sync, records, detail }] }
 *   401/500 { detail }
 *
 * 单个来源的状态只来自后端可验证事实; 前端不补齐、不编造来源。
 * 401/404/网络异常归一化为带 reason 的失败结果, 供设置页显示"不可用"。
 */

import { apiGetVerbose } from '@/api/client'

export const SOURCE_STATUSES = ['ok', 'degraded', 'stale', 'offline', 'unknown'] as const

export type SourceStatus = (typeof SOURCE_STATUSES)[number]

export interface SourceHealthItem {
  id: string
  name: string
  status: SourceStatus
  last_sync: string | null
  records: number | null
  detail: string
}

export interface SourcesHealthPayload {
  generatedAt: string
  sources: SourceHealthItem[]
}

export type SourcesHealthFailureReason = 'unauthorized' | 'not_found' | 'unavailable'

export type SourcesHealthResult =
  | ({ ok: true } & SourcesHealthPayload)
  | { ok: false; reason: SourcesHealthFailureReason; status: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeStatus(value: unknown): SourceStatus {
  return (SOURCE_STATUSES as readonly string[]).includes(String(value))
    ? (value as SourceStatus)
    : 'unknown'
}

function normalizeItem(value: unknown): SourceHealthItem | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || !value.id) return null
  if (typeof value.name !== 'string' || !value.name) return null

  const records =
    typeof value.records === 'number' && Number.isFinite(value.records)
      ? value.records
      : null

  return {
    id: value.id,
    name: value.name,
    status: normalizeStatus(value.status),
    last_sync: typeof value.last_sync === 'string' ? value.last_sync : null,
    records,
    detail: typeof value.detail === 'string' ? value.detail : '',
  }
}

function normalizePayload(value: unknown): SourcesHealthPayload | null {
  if (!isRecord(value) || !Array.isArray(value.sources)) return null
  const sources = value.sources
    .map(normalizeItem)
    .filter((item): item is SourceHealthItem => item !== null)
  return {
    generatedAt: typeof value.generated_at === 'string' ? value.generated_at : '',
    sources,
  }
}

/**
 * 读取六个数据源的健康状态。
 * 失败不抛异常: 401 -> unauthorized, 404 -> not_found, 其他 -> unavailable。
 */
export async function fetchSourcesHealth(): Promise<SourcesHealthResult> {
  const response = await apiGetVerbose<unknown>('/api/sources/health')

  if (response.status === 401) {
    return { ok: false, reason: 'unauthorized', status: 401 }
  }
  if (response.status === 404) {
    return { ok: false, reason: 'not_found', status: 404 }
  }
  if (!response.ok) {
    return { ok: false, reason: 'unavailable', status: response.status }
  }

  const payload = normalizePayload(response.data)
  if (!payload) {
    return { ok: false, reason: 'unavailable', status: response.status }
  }

  return { ok: true, ...payload }
}
