/// <reference types="vitest/globals" />

/**
 * api/system 契约测试 (N15)
 *
 * 验证冻结的 /api/system 契约:
 *   1. 成功响应按后端字段归一化 (snapshot / schema / onboarding);
 *   2. 403/409/422 映射为带 status/code/errors 的 SystemApiError;
 *   3. PUT 保存走 PUT + JSON body, dry_run 原样透传;
 *   4. X-Setup-Token 仅在显式提供时附加;
 *   5. 密码只进请求体, 不写 localStorage / sessionStorage。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  SystemApiError,
  getOnboardingPreflight,
  getOnboardingStatus,
  getSystemConfig,
  getSystemConfigSchema,
  postOnboardingState,
  restartSystem,
  runOnboardingAction,
  saveSystemConfig,
  validateSystemConfig,
} from '@/api/system'
import { clearToken, setToken } from '@/api/client'

const SNAPSHOT = {
  revision: 'rev-1',
  path: 'config.yaml',
  provider: {
    kind: 'yaml',
    location: '/srv/config.yaml',
    writable: true,
    detail: 'file provider',
  },
  config: {
    server: { port: 8768 },
    'auth.setup_require_token': false,
    'llm.api_key': '***',
  },
  degraded: ['legacy.key'],
  apply_failures: { 'audio.enabled': 'kernel unavailable' },
  schema_version: '1',
}

const SCHEMA = {
  schema_version: '1',
  categories: [
    {
      id: 'server',
      title: '服务器',
      description: '监听与端口',
      advanced: false,
    },
  ],
  fields: [
    {
      path: 'server.port',
      type: 'integer',
      default: 8768,
      enum: [8768, 9000],
      min: 1,
      max: 65535,
      sensitive: false,
      apply_strategy: 'listener',
      category: 'server',
      title: '端口',
      help: '监听端口',
      deprecated: false,
      advanced: false,
      core: true,
    },
  ],
}

const SAVE_RESULT = {
  ok: true,
  revision: 'rev-2',
  changed: ['server.port'],
  applied: ['server.port'],
  failed: {},
  degraded: [],
  backup: 'config.yaml.bak-20261026',
  dry_run: false,
}

const ONBOARDING_STATE = {
  version: 1,
  completed_steps: ['preflight'],
  skipped_steps: [],
  current_step: 'server',
  completed: false,
  started_at: '2026-10-26T00:00:00Z',
  updated_at: '2026-10-26T00:01:00Z',
}

const ONBOARDING_STATUS = {
  state: ONBOARDING_STATE,
  needs_setup: true,
  degraded: false,
  onboarding_complete: false,
  config_revision: 'rev-1',
  steps: [],
  bootstrap: false,
  state_version: 1,
  legacy_upgraded: false,
  degraded_reasons: [],
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function headersOf(
  fetchMock: ReturnType<typeof vi.fn>,
  index = 0,
): Record<string, string> {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined
  return (init?.headers as Record<string, string> | undefined) ?? {}
}

function bodyOf(
  fetchMock: ReturnType<typeof vi.fn>,
  index = 0,
): Record<string, unknown> {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined
  return typeof init?.body === 'string'
    ? (JSON.parse(init.body) as Record<string, unknown>)
    : {}
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

async function captureError(promise: Promise<unknown>): Promise<SystemApiError> {
  try {
    await promise
  } catch (e) {
    if (e instanceof SystemApiError) return e
    throw e
  }
  throw new Error('expected request to reject')
}

describe('system config API', () => {
  beforeEach(() => {
    setToken('')
    localStorage.clear()
    sessionStorage.clear()
  })

  afterEach(() => {
    clearToken()
    vi.unstubAllGlobals()
  })

  it('GET /api/system/config 归一化快照', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, SNAPSHOT))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getSystemConfig()).resolves.toEqual(SNAPSHOT)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/system/config',
      expect.objectContaining({ headers: expect.any(Object) }),
    )
  })

  it('GET /api/system/config/schema 归一化字段', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, SCHEMA))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getSystemConfigSchema()).resolves.toEqual(SCHEMA)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/system/config/schema',
      expect.anything(),
    )
  })

  it('GET 200 但响应体缺少 revision 时抛 invalid_response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { config: {} })),
    )

    const error = await captureError(getSystemConfig())

    expect(error.status).toBe(200)
    expect(error.code).toBe('invalid_response')
  })

  it('POST validate 传递 changes/clear_keys 并归一化 warnings', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        warnings: [
          'legacy key ignored',
          { path: 'server.port', code: 'range', message: '高位端口', severity: 'warning' },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await validateSystemConfig({ 'server.port': 9000 }, ['old.key'])

    expect(result).toEqual({
      ok: true,
      warnings: [
        { path: '', code: '', message: 'legacy key ignored', severity: 'warning' },
        { path: 'server.port', code: 'range', message: '高位端口', severity: 'warning' },
      ],
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/system/config/validate',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(bodyOf(fetchMock)).toEqual({
      changes: { 'server.port': 9000 },
      clear_keys: ['old.key'],
    })
  })

  it('PUT /api/system/config 保存配置并透传 dry_run', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, SAVE_RESULT))
    vi.stubGlobal('fetch', fetchMock)

    const result = await saveSystemConfig({
      revision: 'rev-1',
      current_password: 'pw-1',
      changes: { 'server.port': 8768 },
      clear_keys: ['old.key'],
      dry_run: false,
    })

    expect(result).toEqual(SAVE_RESULT)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/system/config',
      expect.objectContaining({ method: 'PUT' }),
    )
    expect(bodyOf(fetchMock)).toEqual({
      revision: 'rev-1',
      current_password: 'pw-1',
      changes: { 'server.port': 8768 },
      clear_keys: ['old.key'],
      dry_run: false,
    })
  })

  it('403 映射为带 status/code 的 SystemApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(403, {
          code: 'password_required',
          message: '需要当前密码',
        }),
      ),
    )

    const error = await captureError(
      saveSystemConfig({ revision: 'rev-1', changes: {} }),
    )

    expect(error).toBeInstanceOf(SystemApiError)
    expect(error.status).toBe(403)
    expect(error.code).toBe('password_required')
    expect(error.message).toBe('需要当前密码')
    expect(error.errors).toEqual([])
  })

  it('409 revision_conflict 保留错误码与 current_revision', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(409, {
          code: 'revision_conflict',
          message: '配置已被其他会话修改',
          current_revision: 'rev-9',
        }),
      ),
    )

    const error = await captureError(
      saveSystemConfig({ revision: 'rev-1', changes: {} }),
    )

    expect(error.status).toBe(409)
    expect(error.code).toBe('revision_conflict')
    expect(error.data.current_revision).toBe('rev-9')
  })

  it('422 validation_failed 暴露 errors 明细', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(422, {
          code: 'validation_failed',
          message: '配置校验失败',
          errors: [
            {
              path: 'server.port',
              code: 'min',
              message: '端口必须大于 0',
              severity: 'error',
            },
          ],
        }),
      ),
    )

    const error = await captureError(
      saveSystemConfig({ revision: 'rev-1', changes: { 'server.port': 0 } }),
    )

    expect(error.status).toBe(422)
    expect(error.code).toBe('validation_failed')
    expect(error.errors).toEqual([
      {
        path: 'server.port',
        code: 'min',
        message: '端口必须大于 0',
        severity: 'error',
      },
    ])
  })

  it('网络异常映射为 status=0 / code=network_error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

    const error = await captureError(getSystemConfig())

    expect(error.status).toBe(0)
    expect(error.code).toBe('network_error')
  })

  it('密码只进 PUT 请求体, 不写入 localStorage / sessionStorage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, SAVE_RESULT))
    vi.stubGlobal('fetch', fetchMock)

    await saveSystemConfig({
      revision: 'rev-1',
      current_password: 'never-store-this-password',
      changes: {},
    })

    expect(bodyOf(fetchMock).current_password).toBe('never-store-this-password')
    expect(storageDump()).not.toContain('never-store-this-password')
  })
})

describe('system restart API', () => {
  beforeEach(() => {
    setToken('')
  })

  afterEach(() => {
    clearToken()
    vi.unstubAllGlobals()
  })

  it('POST /api/system/config/restart 解析 202 响应', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(202, { ok: true, scope: 'listener', restarting: true }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      restartSystem({ revision: 'rev-1', current_password: 'pw-1' }),
    ).resolves.toEqual({ ok: true, scope: 'listener', restarting: true })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/system/config/restart',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(bodyOf(fetchMock)).toEqual({
      revision: 'rev-1',
      current_password: 'pw-1',
    })
  })

  it('409 deployment_required 映射为 typed error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(409, {
          code: 'deployment_required',
          message: '该变更需要重启 launcher',
          command: 'systemctl restart axeuh-health',
        }),
      ),
    )

    const error = await captureError(
      restartSystem({ revision: 'rev-1', current_password: 'pw-1' }),
    )

    expect(error.status).toBe(409)
    expect(error.code).toBe('deployment_required')
    expect(error.data.command).toBe('systemctl restart axeuh-health')
  })
})

describe('onboarding API', () => {
  beforeEach(() => {
    setToken('')
  })

  afterEach(() => {
    clearToken()
    vi.unstubAllGlobals()
  })

  it('GET preflight 归一化检查项', async () => {
    const payload = {
      checks: [
        {
          id: 'config',
          label: '配置载体',
          status: 'pass',
          blocking: false,
          category: 'config',
          detail: 'config.yaml 可写',
          fix: '',
        },
      ],
      can_proceed: true,
      blocking_failures: [],
      soft_failures: [],
      summary: { pass: 1, warn: 0, fail: 0 },
    }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, payload))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getOnboardingPreflight()).resolves.toEqual(payload)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/system/onboarding/preflight',
      expect.anything(),
    )
  })

  it('GET status 归一化状态', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, ONBOARDING_STATUS)),
    )

    await expect(getOnboardingStatus()).resolves.toEqual(ONBOARDING_STATUS)
  })

  it('recordStep 未提供 setup token 时不附加 X-Setup-Token', async () => {
    const payload = {
      state: {
        ...ONBOARDING_STATE,
        completed_steps: ['preflight', 'server'],
        current_step: 'ssl',
      },
      recorded: true,
    }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, payload))
    vi.stubGlobal('fetch', fetchMock)

    const result = await postOnboardingState({
      step_id: 'server',
      status: 'completed',
      data: { port: 8768 },
    })

    expect(result.recorded).toBe(true)
    expect(result.state.current_step).toBe('ssl')
    expect(headersOf(fetchMock)).not.toHaveProperty('X-Setup-Token')
    expect(bodyOf(fetchMock)).toEqual({
      step_id: 'server',
      status: 'completed',
      data: { port: 8768 },
    })
  })

  it('recordStep 归一化 finish 的 activation 结果', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        state: ONBOARDING_STATE,
        recorded: true,
        activation: {
          activated: true,
          active: true,
          reason: 'onboarding_finish',
          subsystems: { scheduler: 'running' },
          errors: [{ subsystem: 'loom', error: 'unreachable' }],
          idempotent: false,
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await postOnboardingState({
      step_id: 'finish',
      status: 'completed',
      data: { allow_degraded: true },
    })

    expect(result.activation).toEqual({
      activated: true,
      active: true,
      reason: 'onboarding_finish',
      subsystems: { scheduler: 'running' },
      errors: [{ subsystem: 'loom', error: 'unreachable' }],
      idempotent: false,
    })
  })

  it('recordStep 显式提供 setup token 时附加去空格后的头', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { state: ONBOARDING_STATE, recorded: true }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await postOnboardingState(
      { step_id: 'server', status: 'skipped' },
      '  setup-token-1  ',
    )

    expect(headersOf(fetchMock)['X-Setup-Token']).toBe('setup-token-1')
  })

  it('action 透传 action/overwrite 并在无 token 时不附加头', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { ok: true, result: { copied: 12 } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      runOnboardingAction({ action: 'copy_ai_template', overwrite: true }),
    ).resolves.toEqual({ ok: true, result: { copied: 12 } })

    expect(bodyOf(fetchMock)).toEqual({
      action: 'copy_ai_template',
      overwrite: true,
    })
    expect(headersOf(fetchMock)).not.toHaveProperty('X-Setup-Token')
  })

  it('action 提供 setup token 时附加 X-Setup-Token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { ok: true, result: {} }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await runOnboardingAction(
      { action: 'generate_self_signed_cert' },
      'setup-token-2',
    )

    expect(headersOf(fetchMock)['X-Setup-Token']).toBe('setup-token-2')
    expect(bodyOf(fetchMock)).toEqual({ action: 'generate_self_signed_cert' })
  })

  it('action 透传 current_password 到请求体', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { ok: true, result: {} }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await runOnboardingAction(
      { action: 'copy_ai_template', overwrite: false },
      undefined,
      'pw-123456',
    )

    expect(bodyOf(fetchMock)).toEqual({
      action: 'copy_ai_template',
      overwrite: false,
      current_password: 'pw-123456',
    })
  })
})
