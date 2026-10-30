/**
 * 服务编排状态 API
 *
 * 对应后端 GET /api/services (T9):
 *   200 { orchestrator: "on"|"off", services: [{ id, state, reason_code, detail,
 *         pid, started_at, retry_count, next_retry_at, requires, critical }] }
 *   401/404/500 { detail }
 *
 * 状态与 reason_code 一律原样透传后端值；前端不推断服务是否可用。
 * 契约见 backend/routers/services_status.py 文件头。
 */

import { apiGetVerbose, apiPostVerbose } from '@/api/client'

export const SERVICE_STATES = [
  'starting',
  'ready',
  'stopping',
  'blocked',
  'failed',
  'stopped',
] as const

export type ServiceState = (typeof SERVICE_STATES)[number]

export const SERVICE_REASON_CODES = [
  'missing_config',
  'disabled',
  'gate_failed',
  'spawn_failed',
  'crashed',
  'restart_exhausted',
  'stopped',
  'manually_paused',
] as const

export type ServiceReasonCode = (typeof SERVICE_REASON_CODES)[number]

export interface ServiceStatusEntry {
  id: string
  /** 后端状态原文；未知值由界面按未知展示，不映射成别的状态。 */
  state: string
  /** 后端 reason_code 原文；空串表示 starting/ready 等无原因状态。 */
  reason_code: string
  detail: string
  pid: number | null
  started_at: string | null
  retry_count: number
  next_retry_at: string | null
  requires: string[]
  critical: boolean
}

export interface ServicesStatusPayload {
  orchestrator: string
  services: ServiceStatusEntry[]
}

export type ServicesStatusFailureReason = 'unauthorized' | 'not_found' | 'unavailable'

export type ServicesStatusResult =
  | ({ ok: true } & ServicesStatusPayload)
  | { ok: false; reason: ServicesStatusFailureReason; status: number }

export type RetryApplyFailureReason =
  | ServicesStatusFailureReason
  | 'forbidden'
  | 'rejected'

export type RetryApplyResult =
  | { ok: true; partial: boolean; failed: string[] }
  | { ok: false; reason: RetryApplyFailureReason; status: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizePid(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null
}

function normalizeEntry(value: unknown): ServiceStatusEntry | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return null
  const requires = Array.isArray(value.requires)
    ? value.requires.filter((item): item is string => typeof item === 'string')
    : []
  return {
    id: value.id,
    state: asString(value.state),
    reason_code: asString(value.reason_code),
    detail: asString(value.detail),
    pid: normalizePid(value.pid),
    started_at: typeof value.started_at === 'string' ? value.started_at : null,
    retry_count:
      typeof value.retry_count === 'number' && Number.isFinite(value.retry_count)
        ? Math.max(0, Math.trunc(value.retry_count))
        : 0,
    next_retry_at: typeof value.next_retry_at === 'string' ? value.next_retry_at : null,
    requires,
    critical: value.critical === true,
  }
}

function normalizePayload(value: unknown): ServicesStatusPayload | null {
  if (!isRecord(value) || !Array.isArray(value.services)) return null
  const services = value.services
    .map(normalizeEntry)
    .filter((item): item is ServiceStatusEntry => item !== null)
  return {
    orchestrator: asString(value.orchestrator),
    services,
  }
}

/**
 * 读取编排器与各服务状态。
 * 失败不抛异常: 401 -> unauthorized, 404 -> not_found, 其余 -> unavailable。
 */
export async function fetchServicesStatus(): Promise<ServicesStatusResult> {
  const response = await apiGetVerbose<unknown>('/api/services')

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

/**
 * 重跑仍留在配置草稿里的失败项。
 *
 * 这是面板唯一允许的写操作；不提交任何配置内容本身。后端写授权与配置面
 * 同级（用户 Token + 密码二次校验 / 引导令牌），403 由界面翻译成人话。
 */
export async function retryConfigApply(): Promise<RetryApplyResult> {
  const response = await apiPostVerbose<unknown>('/api/config/apply/retry', {})

  if (response.status === 401) {
    return { ok: false, reason: 'unauthorized', status: 401 }
  }
  if (response.status === 404) {
    return { ok: false, reason: 'not_found', status: 404 }
  }
  if (response.status === 403) {
    return { ok: false, reason: 'forbidden', status: 403 }
  }
  if (!response.ok) {
    return { ok: false, reason: 'unavailable', status: response.status }
  }
  if (!isRecord(response.data) || response.data.ok !== true) {
    return { ok: false, reason: 'rejected', status: response.status }
  }

  const failed = Array.isArray(response.data.failed)
    ? response.data.failed.filter((item): item is string => typeof item === 'string')
    : []
  return {
    ok: true,
    partial: response.data.partial === true,
    failed,
  }
}
