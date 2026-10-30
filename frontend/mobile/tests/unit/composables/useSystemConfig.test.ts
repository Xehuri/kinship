/// <reference types="vitest/globals" />

/**
 * useSystemConfig 测试 (N15)
 *
 * 验证模块级配置编辑状态:
 *   1. load() 并行拉取 snapshot + schema, 失败时暴露 typed error;
 *   2. save() 用 snapshot.revision 做乐观锁, dry_run 不推进本地 revision;
 *   3. 409 revision_conflict 进入 conflict 态且 reload() 清空冲突;
 *   4. 密码只在调用栈内传递, 不进入模块状态 / localStorage / sessionStorage。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  getSystemConfig: vi.fn(),
  getSystemConfigSchema: vi.fn(),
  validateSystemConfig: vi.fn(),
  saveSystemConfig: vi.fn(),
  restartSystem: vi.fn(),
}))

vi.mock('@/api/system', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/system')>()
  return {
    ...actual,
    getSystemConfig: apiMocks.getSystemConfig,
    getSystemConfigSchema: apiMocks.getSystemConfigSchema,
    validateSystemConfig: apiMocks.validateSystemConfig,
    saveSystemConfig: apiMocks.saveSystemConfig,
    restartSystem: apiMocks.restartSystem,
  }
})

import { SystemApiError } from '@/api/system'
import type { ConfigSnapshot, SaveConfigResult, SchemaResponse } from '@/api/system'
import { useApi } from '@/composables/useApi'
import { useSystemConfig } from '@/composables/useSystemConfig'

function makeSnapshot(revision = 'rev-1'): ConfigSnapshot {
  return {
    revision,
    path: 'config.yaml',
    provider: {
      kind: 'yaml',
      location: '/srv/config.yaml',
      writable: true,
      detail: 'file provider',
    },
    config: { 'server.port': 8768, 'llm.api_key': '***' },
    degraded: [],
    apply_failures: {},
    schema_version: '1',
  }
}

const SCHEMA: SchemaResponse = {
  schema_version: '1',
  categories: [
    { id: 'server', title: '服务器', description: '', advanced: false },
  ],
  fields: [],
}

function makeSaveResult(overrides: Partial<SaveConfigResult> = {}): SaveConfigResult {
  return {
    ok: true,
    revision: 'rev-2',
    changed: ['server.port'],
    applied: ['server.port'],
    failed: {},
    degraded: [],
    dry_run: false,
    ...overrides,
  }
}

function storageDump(): string {
  const parts: string[] = []
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (key) parts.push(`${key}=${localStorage.getItem(key) ?? ''}`)
  }
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const key = sessionStorage.key(i)
    if (key) parts.push(`${key}=${sessionStorage.getItem(key) ?? ''}`)
  }
  return parts.join('\n')
}

const state = useSystemConfig()

describe('useSystemConfig', () => {
  beforeEach(() => {
    state.snapshot.value = null
    state.schema.value = null
    state.loading.value = false
    state.saving.value = false
    state.error.value = null
    state.revisionConflict.value = null
    state.lastApply.value = null
    localStorage.clear()
    sessionStorage.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('load 并行拉取 snapshot 与 schema', async () => {
    apiMocks.getSystemConfig.mockResolvedValue(makeSnapshot())
    apiMocks.getSystemConfigSchema.mockResolvedValue(SCHEMA)

    await state.load()

    expect(apiMocks.getSystemConfig).toHaveBeenCalledTimes(1)
    expect(apiMocks.getSystemConfigSchema).toHaveBeenCalledTimes(1)
    expect(state.snapshot.value).toEqual(makeSnapshot())
    expect(state.schema.value).toEqual(SCHEMA)
    expect(state.loading.value).toBe(false)
    expect(state.error.value).toBeNull()
  })

  it('load 失败时保留已成功的半边并暴露 typed error', async () => {
    apiMocks.getSystemConfig.mockRejectedValue(
      new SystemApiError(403, 'password_required', '需要当前密码'),
    )
    apiMocks.getSystemConfigSchema.mockResolvedValue(SCHEMA)

    await state.load()

    expect(state.snapshot.value).toBeNull()
    expect(state.schema.value).toEqual(SCHEMA)
    expect(state.error.value).toBeInstanceOf(SystemApiError)
    expect(state.error.value?.status).toBe(403)
    expect(state.error.value?.code).toBe('password_required')
    expect(state.loading.value).toBe(false)
  })

  it('save 用快照 revision 提交并回写新 revision', async () => {
    state.snapshot.value = makeSnapshot('rev-1')
    apiMocks.saveSystemConfig.mockResolvedValue(makeSaveResult())

    const result = await state.save({
      currentPassword: 'pw-1',
      changes: { 'server.port': 9000 },
      clearKeys: ['old.key'],
    })

    expect(apiMocks.saveSystemConfig).toHaveBeenCalledWith({
      revision: 'rev-1',
      current_password: 'pw-1',
      changes: { 'server.port': 9000 },
      clear_keys: ['old.key'],
      dry_run: false,
    })
    expect(result).toEqual(makeSaveResult())
    expect(state.lastApply.value).toEqual(makeSaveResult())
    expect(state.snapshot.value?.revision).toBe('rev-2')
    expect(state.snapshot.value?.config['server.port']).toBe(9000)
    expect(state.saving.value).toBe(false)
    expect(state.error.value).toBeNull()
  })

  it('save 成功后合并嵌套新值并保持敏感字段掩码', async () => {
    state.snapshot.value = {
      ...makeSnapshot('rev-1'),
      config: {
        audio: { stream: { silence_cut_s: 1.5 } },
        loom: { token: '***' },
      },
    }
    state.schema.value = {
      ...SCHEMA,
      fields: [
        {
          path: 'audio.stream.silence_cut_s',
          type: 'float',
          default: 1.5,
          sensitive: false,
          apply_strategy: 'hot',
          category: 'audio',
          title: '静音切分',
          help: '',
          deprecated: false,
          advanced: false,
          core: true,
        },
        {
          path: 'loom.token',
          type: 'secret',
          default: '',
          sensitive: true,
          apply_strategy: 'hot',
          category: 'ai',
          title: 'Loom Token',
          help: '',
          deprecated: false,
          advanced: false,
          core: true,
        },
      ],
    }
    apiMocks.saveSystemConfig.mockResolvedValue(
      makeSaveResult({
        changed: ['audio.stream.silence_cut_s', 'loom.token'],
        applied: ['audio'],
      }),
    )

    const result = await state.save({
      changes: {
        'audio.stream.silence_cut_s': 1.7,
        'loom.token': 'super-secret-token',
      },
    })

    expect(result).not.toBeNull()
    expect(state.snapshot.value?.config).toEqual({
      audio: { stream: { silence_cut_s: 1.7 } },
      loom: { token: '***' },
    })
    expect(JSON.stringify(state.snapshot.value)).not.toContain(
      'super-secret-token',
    )
  })

  it('dry_run 不推进本地 revision', async () => {
    state.snapshot.value = makeSnapshot('rev-1')
    apiMocks.saveSystemConfig.mockResolvedValue(
      makeSaveResult({ dry_run: true, revision: 'rev-2' }),
    )

    const result = await state.save({
      changes: { 'server.port': 9000 },
      dryRun: true,
    })

    expect(apiMocks.saveSystemConfig).toHaveBeenCalledWith({
      revision: 'rev-1',
      changes: { 'server.port': 9000 },
      dry_run: true,
    })
    expect(result?.dry_run).toBe(true)
    expect(state.snapshot.value?.revision).toBe('rev-1')
    expect(state.lastApply.value?.dry_run).toBe(true)
  })

  it('409 revision_conflict 设置 conflict 而非普通 error', async () => {
    state.snapshot.value = makeSnapshot('rev-1')
    apiMocks.saveSystemConfig.mockRejectedValue(
      new SystemApiError(
        409,
        'revision_conflict',
        '配置已被其他会话修改',
        [],
        { current_revision: 'rev-9' },
      ),
    )

    const result = await state.save({ changes: { 'server.port': 9000 } })

    expect(result).toBeNull()
    expect(state.revisionConflict.value).toEqual({
      code: 'revision_conflict',
      message: '配置已被其他会话修改',
      currentRevision: 'rev-9',
    })
    expect(state.error.value).toBeNull()
    expect(state.saving.value).toBe(false)
  })

  it('reload 清空冲突并重新拉取最新快照', async () => {
    state.revisionConflict.value = {
      code: 'revision_conflict',
      message: '冲突',
      currentRevision: 'rev-9',
    }
    apiMocks.getSystemConfig.mockResolvedValue(makeSnapshot('rev-9'))
    apiMocks.getSystemConfigSchema.mockResolvedValue(SCHEMA)

    await state.reload()

    expect(state.revisionConflict.value).toBeNull()
    expect(state.snapshot.value?.revision).toBe('rev-9')
  })

  it('未加载快照时 save 直接报 not_loaded, 不发请求', async () => {
    const result = await state.save({ changes: {} })

    expect(result).toBeNull()
    expect(apiMocks.saveSystemConfig).not.toHaveBeenCalled()
    expect(state.error.value?.code).toBe('not_loaded')
  })

  it('validate 的 422 校验明细进入 error 并返回 null', async () => {
    apiMocks.validateSystemConfig.mockRejectedValue(
      new SystemApiError(422, 'validation_failed', '配置校验失败', [
        {
          path: 'server.port',
          code: 'min',
          message: '端口必须大于 0',
          severity: 'error',
        },
      ]),
    )

    const result = await state.validate({ 'server.port': 0 })

    expect(result).toBeNull()
    expect(state.error.value?.code).toBe('validation_failed')
    expect(state.error.value?.errors[0]?.path).toBe('server.port')
  })

  it('restart 用快照 revision + 当次密码请求, 不驻留密码', async () => {
    state.snapshot.value = makeSnapshot('rev-5')
    apiMocks.restartSystem.mockResolvedValue({
      ok: true,
      scope: 'backend',
      restarting: true,
    })

    const result = await state.restart('restart-pw-1')

    expect(apiMocks.restartSystem).toHaveBeenCalledWith({
      revision: 'rev-5',
      current_password: 'restart-pw-1',
    })
    expect(result).toEqual({ ok: true, scope: 'backend', restarting: true })
    expect(JSON.stringify(state.snapshot.value)).not.toContain('restart-pw-1')
    expect(storageDump()).not.toContain('restart-pw-1')
  })

  it('保存密码不进入模块状态 / localStorage / sessionStorage', async () => {
    state.snapshot.value = makeSnapshot('rev-1')
    apiMocks.saveSystemConfig.mockResolvedValue(makeSaveResult())

    await state.save({
      currentPassword: 'never-store-me',
      changes: { 'server.port': 9000 },
    })

    expect(apiMocks.saveSystemConfig).toHaveBeenCalledWith(
      expect.objectContaining({ current_password: 'never-store-me' }),
    )

    const moduleState = JSON.stringify({
      snapshot: state.snapshot.value,
      schema: state.schema.value,
      error: state.error.value,
      revisionConflict: state.revisionConflict.value,
      lastApply: state.lastApply.value,
    })
    expect(moduleState).not.toContain('never-store-me')
    expect(storageDump()).not.toContain('never-store-me')
  })

  it('logout 清空 snapshot/schema/error 且不保留 QQ 与 WS 地址', () => {
    state.snapshot.value = {
      ...makeSnapshot(),
      config: {
        qq_gateway: {
          account: {
            self_qq: '12345678',
            ws_url: 'ws://127.0.0.1:3001',
          },
        },
      },
    }
    state.schema.value = SCHEMA
    state.error.value = new SystemApiError(401, 'auth_required', '请先登录')

    useApi().logout()

    expect(state.snapshot.value).toBeNull()
    expect(state.schema.value).toBeNull()
    expect(state.error.value).toBeNull()
    expect(JSON.stringify(state.snapshot.value)).not.toContain('12345678')
    expect(JSON.stringify(state.snapshot.value)).not.toContain('ws://127.0.0.1:3001')
  })

  it('status 计算属性暴露 revision/writable/degraded/apply_failures', async () => {
    state.snapshot.value = {
      ...makeSnapshot('rev-3'),
      degraded: ['legacy.key'],
      apply_failures: { 'audio.enabled': 'kernel unavailable' },
    }

    expect(state.status.value).toEqual({
      revision: 'rev-3',
      writable: true,
      degraded: ['legacy.key'],
      apply_failures: { 'audio.enabled': 'kernel unavailable' },
    })
  })
})
