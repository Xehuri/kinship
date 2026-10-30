/**
 * 配置草稿 API（/api/config/*）
 *
 *   POST /api/config/draft    -> { ok, revision, staged_revision, changes, count }
 *   GET  /api/config/pending  -> { revision, staged_revision, changes[], count }
 *
 * 引导页的安全连接面板只“写草稿”，绝不 apply / restart：草稿在 finish 或设置
 * 页统一应用。GET /api/config/pending 走配置写授权（用户 Token + 密码，或
 * 引导令牌），密码只进入当次请求头，不写入任何存储。
 *
 * 失败不抛异常，统一返回 result union；界面据此展示后端 message。
 */

import { apiGetVerbose, apiPostVerbose } from '@/api/client'

export type ConfigDraftFailureReason =
  | 'unauthorized'
  | 'forbidden'
  | 'conflict'
  | 'validation'
  | 'unavailable'
  | 'network'

export interface ConfigDraftSchemaError {
  path: string
  code: string
  message: string
  severity: string
}

export interface ConfigDraftError {
  reason: ConfigDraftFailureReason
  status: number
  code: string
  message: string
  errors: ConfigDraftSchemaError[]
}

export interface ConfigPendingChange {
  path: string
  from: unknown
  to: unknown
  strategy: string
  requires_restart: boolean
}

export interface ConfigPendingSnapshot {
  revision: string
  stagedRevision: string | null
  changes: ConfigPendingChange[]
  count: number
}

export interface StageDraftOptions {
  currentPassword?: string
}

export interface PendingOptions {
  currentPassword?: string
}

export type StageDraftResult =
  | {
      ok: true
      count: number
      changes: Record<string, unknown>
      stagedRevision: string | null
    }
  | ({ ok: false } & ConfigDraftError)

export type PendingResult =
  | { ok: true; pending: ConfigPendingSnapshot }
  | ({ ok: false } & ConfigDraftError)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0
}

function failureReason(status: number): ConfigDraftFailureReason {
  if (status === 0) return 'network'
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 409) return 'conflict'
  if (status === 422) return 'validation'
  return 'unavailable'
}

function normalizeSchemaErrors(value: unknown): ConfigDraftSchemaError[] {
  if (!Array.isArray(value)) return []
  const errors: ConfigDraftSchemaError[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const path = asString(entry.path)
    const message = asString(entry.message)
    if (!path && !message) continue
    errors.push({
      path,
      code: asString(entry.code),
      message,
      severity: asString(entry.severity),
    })
  }
  return errors
}

function draftFailure(
  status: number,
  data: unknown,
  fallbackMessage: string,
): ConfigDraftError {
  const body = isRecord(data) ? data : {}
  const reason = failureReason(status)
  return {
    reason,
    status,
    code: asString(body.code) || (reason === 'network' ? 'network_error' : `http_${status}`),
    message: asString(body.message) || asString(body.detail) || fallbackMessage,
    errors: normalizeSchemaErrors(body.errors),
  }
}

function normalizePendingChange(value: unknown): ConfigPendingChange | null {
  if (!isRecord(value) || typeof value.path !== 'string' || !value.path) {
    return null
  }
  return {
    path: value.path,
    from: value.from,
    to: value.to,
    strategy: asString(value.strategy),
    requires_restart: value.requires_restart === true,
  }
}

function normalizePending(
  data: unknown,
): ConfigPendingSnapshot | null {
  if (!isRecord(data) || !Array.isArray(data.changes)) return null
  const changes = data.changes
    .map(normalizePendingChange)
    .filter((item): item is ConfigPendingChange => item !== null)
  return {
    revision: asString(data.revision),
    stagedRevision:
      typeof data.staged_revision === 'string' ? data.staged_revision : null,
    changes,
    count: asCount(data.count) || changes.length,
  }
}

function passwordHeaders(
  password: string | undefined,
): Record<string, string> | undefined {
  const value = password?.trim()
  return value ? { 'X-Config-Password': value } : undefined
}

/**
 * 把变更写入配置草稿（不落 config.yaml、不 apply、不重启）。
 */
export async function stageConfigDraft(
  changes: Record<string, unknown>,
  options: StageDraftOptions = {},
): Promise<StageDraftResult> {
  const password = options.currentPassword?.trim()
  const body: Record<string, unknown> = { changes }
  if (password) body.current_password = password

  const response = await apiPostVerbose<unknown>('/api/config/draft', body)
  if (!response.ok) {
    return {
      ok: false,
      ...draftFailure(response.status, response.data, '写入配置草稿失败'),
    }
  }
  if (!isRecord(response.data) || response.data.ok !== true) {
    return {
      ok: false,
      ...draftFailure(response.status, response.data, '写入配置草稿失败'),
    }
  }
  const rawChanges = isRecord(response.data.changes) ? response.data.changes : {}
  return {
    ok: true,
    count: asCount(response.data.count) || Object.keys(rawChanges).length,
    changes: rawChanges,
    stagedRevision:
      typeof response.data.staged_revision === 'string'
        ? response.data.staged_revision
        : null,
  }
}

/**
 * 读取待应用草稿清单；requires_restart 直接透传后端策略判定。
 */
export async function fetchConfigPending(
  options: PendingOptions = {},
): Promise<PendingResult> {
  const response = await apiGetVerbose<unknown>(
    '/api/config/pending',
    false,
    passwordHeaders(options.currentPassword),
  )
  if (!response.ok) {
    return {
      ok: false,
      ...draftFailure(response.status, response.data, '读取待应用配置失败'),
    }
  }
  const pending = normalizePending(response.data)
  if (!pending) {
    return {
      ok: false,
      ...draftFailure(response.status, response.data, '待应用配置响应格式无效'),
    }
  }
  return { ok: true, pending }
}
