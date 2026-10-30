/**
 * 系统配置编辑 Composable (N15)
 *
 * 模块级单例: 设置页系统配置卡与测试模式入口共享同一份 snapshot/schema/冲突状态。
 * 密码按调用传入, 只进入当次请求体, 不写入模块状态 / localStorage / sessionStorage。
 *
 * 使用方式:
 *   const { snapshot, schema, revisionConflict, load, save, reload } = useSystemConfig()
 *   await load()
 *   const result = await save({ currentPassword, changes, dryRun })
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { onLogout } from '@/composables/useApi'
import {
  SystemApiError,
  getSystemConfig,
  getSystemConfigSchema,
  restartSystem,
  saveSystemConfig,
  validateSystemConfig,
} from '@/api/system'
import type {
  ConfigSnapshot,
  ConfigStatus,
  RestartResult,
  SaveConfigResult,
  SchemaResponse,
  ValidateResult,
} from '@/api/system'

export interface RevisionConflict {
  code: string
  message: string
  currentRevision: string | null
}

export interface SaveSystemConfigOptions {
  currentPassword?: string
  setupToken?: string
  changes: Record<string, unknown>
  clearKeys?: string[]
  dryRun?: boolean
}

export interface UseSystemConfigReturn {
  snapshot: Ref<ConfigSnapshot | null>
  schema: Ref<SchemaResponse | null>
  status: ComputedRef<ConfigStatus | null>
  loading: Ref<boolean>
  saving: Ref<boolean>
  error: Ref<SystemApiError | null>
  revisionConflict: Ref<RevisionConflict | null>
  lastApply: Ref<SaveConfigResult | null>
  clear: () => void
  load: () => Promise<void>
  reload: () => Promise<void>
  validate: (
    changes: Record<string, unknown>,
    clearKeys?: string[],
  ) => Promise<ValidateResult | null>
  save: (options: SaveSystemConfigOptions) => Promise<SaveConfigResult | null>
  restart: (currentPassword: string) => Promise<RestartResult | null>
}

// ==================== 模块级状态 ====================

const snapshot = ref<ConfigSnapshot | null>(null)
const schema = ref<SchemaResponse | null>(null)
const loading = ref(false)
const saving = ref(false)
const error = ref<SystemApiError | null>(null)
const revisionConflict = ref<RevisionConflict | null>(null)
const lastApply = ref<SaveConfigResult | null>(null)

function clear(): void {
  snapshot.value = null
  schema.value = null
  loading.value = false
  saving.value = false
  error.value = null
  revisionConflict.value = null
  lastApply.value = null
}

onLogout(clear)

const status = computed<ConfigStatus | null>(() => {
  const current = snapshot.value
  if (!current) return null
  return {
    revision: current.revision,
    writable: current.provider.writable,
    degraded: current.degraded,
    apply_failures: current.apply_failures,
  }
})

// ==================== 内部工具 ====================

function toSystemApiError(value: unknown): SystemApiError {
  if (value instanceof SystemApiError) return value
  return new SystemApiError(
    0,
    'unknown_error',
    value instanceof Error ? value.message : String(value),
  )
}

function notLoadedError(): SystemApiError {
  return new SystemApiError(0, 'not_loaded', '配置尚未加载')
}

function cloneConfig(config: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>
}

function setConfigPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  if (Object.prototype.hasOwnProperty.call(target, path)) {
    target[path] = value
    return
  }
  const parts = path.split('.')
  let node = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index]
    const next = node[key]
    if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
      node = next as Record<string, unknown>
    } else {
      const created: Record<string, unknown> = {}
      node[key] = created
      node = created
    }
  }
  node[parts[parts.length - 1]] = value
}

function deleteConfigPath(
  target: Record<string, unknown>,
  path: string,
): void {
  if (Object.prototype.hasOwnProperty.call(target, path)) {
    delete target[path]
    return
  }
  const parts = path.split('.')
  let node = target
  for (let index = 0; index < parts.length - 1; index += 1) {
    const next = node[parts[index]]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      return
    }
    node = next as Record<string, unknown>
  }
  delete node[parts[parts.length - 1]]
}

function mergeSavedConfig(
  config: Record<string, unknown>,
  changes: Record<string, unknown>,
  clearKeys: string[] | undefined,
  fields: readonly { path: string; sensitive: boolean }[],
): Record<string, unknown> {
  const next = cloneConfig(config)
  const sensitivePaths = new Set(
    fields.filter((field) => field.sensitive).map((field) => field.path),
  )
  for (const [path, value] of Object.entries(changes)) {
    if (sensitivePaths.has(path)) {
      if (value === '***') continue
      setConfigPath(
        next,
        path,
        value === '' || value === null || value === undefined ? '' : '***',
      )
      continue
    }
    setConfigPath(next, path, value)
  }
  for (const path of clearKeys ?? []) {
    deleteConfigPath(next, path)
    if (sensitivePaths.has(path)) setConfigPath(next, path, '')
  }
  return next
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null

  try {
    const [configResult, schemaResult] = await Promise.allSettled([
      getSystemConfig(),
      getSystemConfigSchema(),
    ])

    if (configResult.status === 'fulfilled') {
      snapshot.value = configResult.value
    } else {
      error.value = toSystemApiError(configResult.reason)
    }

    if (schemaResult.status === 'fulfilled') {
      schema.value = schemaResult.value
    } else if (error.value === null) {
      error.value = toSystemApiError(schemaResult.reason)
    }
  } finally {
    loading.value = false
  }
}

async function reload(): Promise<void> {
  revisionConflict.value = null
  await load()
}

async function validate(
  changes: Record<string, unknown>,
  clearKeys?: string[],
): Promise<ValidateResult | null> {
  error.value = null
  try {
    return await validateSystemConfig(changes, clearKeys)
  } catch (e) {
    error.value = toSystemApiError(e)
    return null
  }
}

async function save(
  options: SaveSystemConfigOptions,
): Promise<SaveConfigResult | null> {
  const current = snapshot.value
  if (!current) {
    error.value = notLoadedError()
    return null
  }

  saving.value = true
  error.value = null
  revisionConflict.value = null

  try {
    const request = {
      revision: current.revision,
      ...(options.currentPassword
        ? { current_password: options.currentPassword }
        : {}),
      changes: options.changes,
      ...(options.clearKeys && options.clearKeys.length > 0
        ? { clear_keys: options.clearKeys }
        : {}),
      dry_run: options.dryRun === true,
    }

    const result = options.setupToken
      ? await saveSystemConfig(request, options.setupToken)
      : await saveSystemConfig(request)

    lastApply.value = result

    if (!result.dry_run) {
      snapshot.value = {
        ...current,
        config: mergeSavedConfig(
          current.config,
          options.changes,
          options.clearKeys,
          schema.value?.fields ?? [],
        ),
        revision: result.revision,
        degraded: result.degraded,
        apply_failures: result.failed,
      }
    }

    return result
  } catch (e) {
    const apiError = toSystemApiError(e)
    if (apiError.status === 409 && apiError.code === 'revision_conflict') {
      revisionConflict.value = {
        code: apiError.code,
        message: apiError.message,
        currentRevision:
          typeof apiError.data.current_revision === 'string'
            ? apiError.data.current_revision
            : null,
      }
    } else {
      error.value = apiError
    }
    return null
  } finally {
    saving.value = false
  }
}

async function restart(
  currentPassword: string,
): Promise<RestartResult | null> {
  const current = snapshot.value
  if (!current) {
    error.value = notLoadedError()
    return null
  }

  error.value = null
  try {
    return await restartSystem({
      revision: current.revision,
      current_password: currentPassword,
    })
  } catch (e) {
    error.value = toSystemApiError(e)
    return null
  }
}

export function useSystemConfig(): UseSystemConfigReturn {
  return {
    snapshot,
    schema,
    status,
    loading,
    saving,
    error,
    revisionConflict,
    lastApply,
    clear,
    load,
    reload,
    validate,
    save,
    restart,
  }
}
