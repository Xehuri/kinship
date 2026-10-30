/**
 * /api/system 响应边界归一化 (N15)
 *
 * 把后端 JSON 解析为 systemTypes.ts 的类型; 不满足最小契约时返回 null,
 * 由 system.ts 转换成 SystemApiError('invalid_response')。
 */

import type {
  ConfigCategory,
  ConfigField,
  ConfigSnapshot,
  ConfigWarning,
  OnboardingState,
  OnboardingStatus,
  OnboardingStepInfo,
  OnboardingStepState,
  OnboardingActivation,
  OnboardingActivationError,
  PreflightCheck,
  PreflightResult,
  PreflightStatus,
  ProviderInfo,
  RestartScope,
  SaveConfigResult,
  SchemaResponse,
  ValidationError,
} from './systemTypes'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

export function asStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') result[key] = item
  }
  return result
}

export function normalizeValidationErrors(value: unknown): ValidationError[] {
  if (!Array.isArray(value)) return []
  const errors: ValidationError[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    errors.push({
      path: asString(item.path),
      code: asString(item.code),
      message: asString(item.message),
      severity: asString(item.severity, 'error'),
    })
  }
  return errors
}

export function normalizeWarnings(value: unknown): ConfigWarning[] {
  if (!Array.isArray(value)) return []
  const warnings: ConfigWarning[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      warnings.push({
        path: '',
        code: '',
        message: item,
        severity: 'warning',
      })
      continue
    }
    if (!isRecord(item)) continue
    warnings.push({
      path: asString(item.path),
      code: asString(item.code),
      message: asString(item.message),
      severity: asString(item.severity, 'warning'),
    })
  }
  return warnings
}

function normalizeProvider(value: unknown): ProviderInfo {
  const record = isRecord(value) ? value : {}
  return {
    kind: asString(record.kind),
    location: asString(record.location),
    writable: asBoolean(record.writable),
    detail: asString(record.detail),
  }
}

export function normalizeSnapshot(value: unknown): ConfigSnapshot | null {
  if (!isRecord(value)) return null
  const revision = asString(value.revision)
  if (!revision) return null
  return {
    revision,
    path: asString(value.path),
    provider: normalizeProvider(value.provider),
    config: isRecord(value.config) ? value.config : {},
    degraded: asStringArray(value.degraded),
    apply_failures: asStringRecord(value.apply_failures),
    schema_version: asString(value.schema_version),
  }
}

function normalizeCategory(value: unknown): ConfigCategory | null {
  if (!isRecord(value)) return null
  const id = asString(value.id)
  if (!id) return null
  return {
    id,
    title: asString(value.title),
    description: asString(value.description),
    advanced: asBoolean(value.advanced),
  }
}

function normalizeField(value: unknown): ConfigField | null {
  if (!isRecord(value)) return null
  const path = asString(value.path)
  if (!path) return null
  const field: ConfigField = {
    path,
    type: asString(value.type),
    default: value.default,
    sensitive: asBoolean(value.sensitive),
    apply_strategy: asString(value.apply_strategy),
    category: asString(value.category),
    title: asString(value.title),
    help: asString(value.help),
    deprecated: asBoolean(value.deprecated),
    advanced: asBoolean(value.advanced),
    core: asBoolean(value.core),
  }
  if (Array.isArray(value.enum)) field.enum = value.enum
  const min = asFiniteNumber(value.min)
  const max = asFiniteNumber(value.max)
  if (min !== undefined) field.min = min
  if (max !== undefined) field.max = max
  return field
}

export function normalizeSchema(value: unknown): SchemaResponse | null {
  if (!isRecord(value)) return null
  const categories = Array.isArray(value.categories)
    ? value.categories
        .map(normalizeCategory)
        .filter((item): item is ConfigCategory => item !== null)
    : []
  const fields = Array.isArray(value.fields)
    ? value.fields
        .map(normalizeField)
        .filter((item): item is ConfigField => item !== null)
    : []
  return {
    schema_version: asString(value.schema_version),
    categories,
    fields,
  }
}

export function normalizeSaveResult(value: unknown): SaveConfigResult | null {
  if (!isRecord(value)) return null
  const revision = asString(value.revision)
  if (!revision) return null
  const result: SaveConfigResult = {
    ok: true,
    revision,
    changed: asStringArray(value.changed),
    applied: asStringArray(value.applied),
    failed: asStringRecord(value.failed),
    degraded: asStringArray(value.degraded),
    dry_run: asBoolean(value.dry_run),
  }
  if (typeof value.backup === 'string') result.backup = value.backup
  return result
}

export function normalizeRestartScope(value: unknown): RestartScope | null {
  return value === 'backend' || value === 'listener' ? value : null
}

function normalizePreflightStatus(value: unknown): PreflightStatus {
  return value === 'pass' || value === 'warn' || value === 'fail'
    ? value
    : 'warn'
}

function normalizePreflightCheck(value: unknown): PreflightCheck | null {
  if (!isRecord(value)) return null
  const id = asString(value.id)
  if (!id) return null
  const status = normalizePreflightStatus(value.status)
  return {
    id,
    label: asString(value.label),
    status,
    blocking: asBoolean(value.blocking, status === 'fail'),
    category: asString(value.category),
    detail: asString(value.detail),
    fix: asString(value.fix),
  }
}

export function normalizePreflight(value: unknown): PreflightResult | null {
  if (!isRecord(value) || !Array.isArray(value.checks)) return null
  const checks = value.checks
    .map(normalizePreflightCheck)
    .filter((item): item is PreflightCheck => item !== null)
  const summary = isRecord(value.summary) ? value.summary : {}
  return {
    checks,
    can_proceed: asBoolean(value.can_proceed),
    blocking_failures: asStringArray(value.blocking_failures),
    soft_failures: asStringArray(value.soft_failures),
    summary: {
      pass: asFiniteNumber(summary.pass) ?? checks.filter((item) => item.status === 'pass').length,
      warn: asFiniteNumber(summary.warn) ?? checks.filter((item) => item.status === 'warn').length,
      fail: asFiniteNumber(summary.fail) ?? checks.filter((item) => item.status === 'fail').length,
    },
  }
}

export function normalizeOnboardingActivation(
  value: unknown,
): OnboardingActivation | null {
  if (!isRecord(value)) return null
  const rawErrors = Array.isArray(value.errors) ? value.errors : []
  const errors = rawErrors
    .filter(isRecord)
    .map<OnboardingActivationError>((item) => ({
      subsystem: asString(item.subsystem),
      error: asString(item.error),
    }))
  return {
    activated: asBoolean(value.activated),
    active: asBoolean(value.active),
    reason: asString(value.reason),
    subsystems: isRecord(value.subsystems) ? value.subsystems : {},
    errors,
    idempotent: asBoolean(value.idempotent),
  }
}

export function normalizeOnboardingState(
  value: unknown,
): OnboardingState | null {
  if (!isRecord(value)) return null
  return {
    version:
      typeof value.version === 'number' || typeof value.version === 'string'
        ? value.version
        : '',
    completed_steps: asStringArray(value.completed_steps),
    skipped_steps: asStringArray(value.skipped_steps),
    current_step: asString(value.current_step),
    completed: asBoolean(value.completed),
    started_at: typeof value.started_at === 'string' ? value.started_at : null,
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : null,
  }
}

function normalizeStepState(value: unknown): OnboardingStepState {
  return value === 'completed' || value === 'skipped' || value === 'current'
    ? value
    : 'pending'
}

function normalizeOnboardingStep(value: unknown): OnboardingStepInfo | null {
  if (!isRecord(value)) return null
  const id = asString(value.id)
  if (!id) return null
  return {
    id,
    title: asString(value.title),
    description: asString(value.description),
    required: asBoolean(value.required, true),
    skippable: asBoolean(value.skippable),
    state: normalizeStepState(value.state),
    auth: asString(value.auth, 'none'),
  }
}

export function normalizeOnboardingStatus(
  value: unknown,
): OnboardingStatus | null {
  if (!isRecord(value)) return null
  const state = normalizeOnboardingState(value.state)
  if (!state) return null
  const steps = Array.isArray(value.steps)
    ? value.steps
        .map(normalizeOnboardingStep)
        .filter((item): item is OnboardingStepInfo => item !== null)
    : []
  const version =
    asFiniteNumber(value.state_version) ??
    (typeof state.version === 'number' ? state.version : 1)
  return {
    state,
    needs_setup: asBoolean(value.needs_setup),
    degraded: asBoolean(value.degraded),
    onboarding_complete: asBoolean(value.onboarding_complete),
    config_revision: asString(value.config_revision),
    steps,
    bootstrap: asBoolean(value.bootstrap),
    state_version: version,
    legacy_upgraded: asBoolean(value.legacy_upgraded),
    degraded_reasons: asStringArray(value.degraded_reasons),
  }
}
