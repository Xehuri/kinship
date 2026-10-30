/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  SystemApiError,
  abortStartup,
  applyLoomSelection,
  applyMossChoice,
  attemptStartup,
  cancelOnboardingJob,
  configureMoss,
  configureQq,
  configureXiaomi,
  createOtaTicket,
  ensureLoomConfig,
  ensureLoomToken,
  finishOnboarding,
  getClientCatalog,
  getLoomOnboarding,
  getLoomRuntime,
  getMossConfig,
  getMossOnboarding,
  getKernelModels,
  getOnboardingAssets,
  getOnboardingFinish,
  getOnboardingJob,
  getOnboardingPreflight,
  getOnboardingStatus,
  getOnboardingStorage,
  getQqOnboarding,
  getStartupOnboarding,
  getXiaomiOnboarding,
  pollXiaomiQr,
  requestXiaomiQr,
  restartLoomOnboarding,
  restartLoomRuntime,
  saveOnboardingStorage,
  setupLoom,
  startAssetDownload,
  startKernelModelsDownload,
  startLoomRuntime,
  stopLoomRuntime,
  validateLoomSelection,
  validateMossConfig,
  validateQqConfig,
  validateStartup,
} from '@/api/system'
import { normalizeStartupStatus } from '@/api/systemOnboardingNormalize'
import { clearToken, setToken } from '@/api/client'

const ONBOARDING_STATUS = {
  state: {
    version: 2,
    completed_steps: ['welcome'],
    skipped_steps: [],
    current_step: 'account',
    completed: false,
    started_at: null,
    updated_at: null,
  },
  needs_setup: true,
  degraded: false,
  onboarding_complete: false,
  config_revision: 'rev-1',
  steps: [
    {
      id: 'welcome',
      title: '欢迎',
      description: '开始',
      required: true,
      skippable: false,
      state: 'completed',
      auth: 'none',
    },
    {
      id: 'account',
      title: '管理员账号',
      description: '建号',
      required: true,
      skippable: false,
      state: 'current',
      auth: 'setup_token',
    },
  ],
  bootstrap: true,
  state_version: 2,
  legacy_upgraded: false,
  degraded_reasons: [],
}

const PREFLIGHT = {
  checks: [
    {
      id: 'frontend_dist',
      label: '前端产物',
      status: 'fail',
      blocking: true,
      category: 'frontend',
      detail: 'dist 缺失',
      fix: '重新构建',
    },
    {
      id: 'loom',
      label: 'Loom',
      status: 'warn',
      blocking: false,
      category: 'ai',
      detail: '未配置',
      fix: '',
    },
  ],
  can_proceed: false,
  blocking_failures: ['frontend_dist'],
  soft_failures: ['loom'],
  summary: { pass: 0, warn: 1, fail: 1 },
}

const DEPENDENCIES = {
  kernel: {
    dir: '/srv/kernel',
    present: false,
    source: null,
    version: null,
    marker: '/srv/kernel/.installed-from-release',
    installed_from_release: false,
    installable: true,
    install_blocked_reason: null,
  },
  python: {
    path: '/opt/kinship/.venv-kernel/bin/python',
    source: 'default',
    exists: true,
    configured: '',
    configured_exists: false,
    last_resort: false,
  },
  models: {
    model_dir: '/home/u/.cache/axeuh-kernel/models',
    configured: false,
    exists: false,
  },
  disk: {
    path: '/srv',
    free: 1000,
    required: 0,
    sufficient: true,
  },
  health: {
    pidfile: '/srv/backend/data/kernel_state/kernel.pid',
    found: false,
    pid: null,
    port: null,
    alive: false,
    healthy: false,
    api_version: null,
    base_url: null,
    error: 'pidfile_missing',
  },
}

const ASSETS_NOT_CONFIGURED = {
  configured: false,
  manifest: null,
  assets: {},
  dependencies: DEPENDENCIES,
  error: 'release_manifest_not_configured',
}

const ASSETS_CONFIGURED = {
  configured: true,
  schema: 1,
  product: 'kinship',
  version: '1.5.0',
  assets: {
    kernel: {
      name: 'kernel',
      file: 'axeuh-kernel-1.5.0.tar.gz',
      sha256: 'a'.repeat(64),
      size: 1024,
      url: 'https://example.com/kernel.tar.gz',
      api_version: '1',
      tiers: ['cpu'],
    },
    frontend: {
      name: 'frontend',
      file: 'axeuh-mobile-dist-1.5.0.tar.gz',
      sha256: 'b'.repeat(64),
      size: 2048,
      url: 'https://example.com/frontend.tar.gz',
      api_version: '',
      tiers: [],
    },
  },
  dependencies: DEPENDENCIES,
}

const JOB = {
  id: 'job-abc',
  kind: 'download:kernel',
  asset: 'kernel',
  state: 'running',
  progress: { bytes: 512, total: 1024, pct: 50 },
  current: 'kernel',
  logs_tail: ['[OnboardingAssets] phase=download asset=kernel result=progress'],
  result: null,
  error: null,
  cancel_requested: false,
  created_at: '2026-10-26T00:00:00Z',
  updated_at: '2026-10-26T00:00:01Z',
}

const LOOM_MODEL = {
  id: 'deepseek',
  provider: 'new-api',
  contextWindow: 128000,
  maxOutput: 4096,
  vision: false,
  timeout: 600000,
  reasoningEffort: 'high',
}

const LOOM_STATUS = {
  found: true,
  source: 'env',
  fingerprint: 'abcd1234',
  detail: '环境变量 LOOM_TOKEN',
  url: 'http://127.0.0.1:5100',
  managed: false,
  reachable: true,
  online: true,
  health: {
    status: 'ok',
    version: '1.0.0',
    uptime_ms: 100,
    started_at: '2026-10-26T00:00:00Z',
  },
  main_model: LOOM_MODEL,
  models: [LOOM_MODEL],
  channels: [
    {
      provider: 'new-api',
      model_count: 1,
      models: ['deepseek'],
      credential_ref: 'NEW_API_KEY',
    },
  ],
  providers: [
    {
      provider: 'new-api',
      model_count: 1,
      models: ['deepseek'],
      credential_ref: 'NEW_API_KEY',
    },
  ],
  credentials: [{ name: 'new-api', env_ref: 'ENV_REF' }],
  config: {
    workspace: '/srv/ai',
    model_ids: ['deepseek'],
    pricing_providers: ['new-api'],
    effective_version_sha256: 'c'.repeat(64),
  },
  managed_config: { path: '/srv/ai/.loom/config.yaml', exists: true },
  errors: [],
}

const LOOM_SELECTION = {
  provider: 'new-api',
  model: 'deepseek',
  base_url: null,
  context_window: null,
  max_output: null,
  vision: null,
  timeout: null,
  pricing: null,
}

const LOOM_VALIDATE = {
  ok: true,
  valid: true,
  managed: false,
  selection: LOOM_SELECTION,
  main_model: LOOM_MODEL,
  validation_mode: 'structural',
  errors: [],
  warnings: [],
}

const LOOM_RESTART = {
  ok: true,
  requested: true,
  performed: true,
  verified: true,
  manual_required: false,
  command: null,
  old_pid: 10,
  new_pid: 11,
  detail: '重启完成',
}

const LOOM_APPLY = {
  ok: true,
  managed: false,
  applied: false,
  manual_required: true,
  selection: LOOM_SELECTION,
  validation_mode: 'structural',
  backup: null,
  rollback: null,
  restart: LOOM_RESTART,
  errors: [],
  warnings: [],
}

const LOOM_RUNTIME_HEALTH = {
  reachable: true,
  ok: true,
  http_status: 200,
  status: 'ok',
  version: '1.2.3',
  error: null,
}

const LOOM_TOKEN_STATE = {
  found: true,
  source: 'provisioned',
  fingerprint: 'deadbeef',
  provisioned: true,
  token_file: '/srv/data/secrets/loom.env',
  persisted: true,
  detail: '已生成 /srv/data/secrets/loom.env',
  errors: [],
}

const LOOM_RUNTIME = {
  ok: true,
  mode: 'systemd',
  mode_detail: {
    systemd: {
      systemctl: true,
      unit: 'axeuh-loom',
      present: true,
      owned: true,
      load_state: 'loaded',
      active_state: 'active',
      sub_state: 'running',
      pid: 4321,
    },
    child: {
      node: true,
      cli_path: '/srv/loom-harness/packages/server/dist/cli.js',
      cli_present: true,
    },
    reasons: [],
  },
  managed: true,
  config_path: '/srv/ai/.loom/config.yaml',
  config_exists: true,
  token_state: LOOM_TOKEN_STATE,
  running: true,
  pid: 4321,
  pid_verified: true,
  adopted: false,
  reachable: true,
  health: LOOM_RUNTIME_HEALTH,
  port: 5100,
  detail: 'systemd 单元 axeuh-loom 状态 active',
}

const LOOM_CONFIG_ENSURE = {
  ok: true,
  managed: true,
  path: '/srv/ai/.loom/config.yaml',
  exists: true,
  created: true,
  overwritten: false,
  backup: null,
  manual_required: false,
  validation: 'structural',
  credential_ref: '${LOOM_KEY_NEW_API}',
  errors: [],
}

const LOOM_RUNTIME_ACTION = {
  ok: true,
  mode: 'systemd',
  requested: 'start',
  performed: true,
  verified: true,
  manual_required: false,
  adopted: false,
  pid: 4321,
  old_pid: null,
  new_pid: 4321,
  command: null,
  detail: 'systemd 启动完成',
  health: LOOM_RUNTIME_HEALTH,
  errors: [],
}

const MOSS_STATUS = {
  base_url: 'http://127.0.0.1:8100/v1',
  model: 'moss-audio-4b',
  manage_units: false,
  helper_configured: false,
  helper_reason: 'not_configured',
  managed_available: false,
  choice: null,
  last_choice: null,
  units: { enable: ['axeuh-moss', 'axeuh-moss-watch'], disable: [] },
  commands: { enable: ['sudo systemctl enable --now axeuh-moss'], disable: [] },
  warnings: [],
}

const MOSS_VALIDATION = {
  base_url: 'http://127.0.0.1:8100/v1',
  model: 'moss-audio-4b',
  reachable: true,
  model_found: true,
  models: ['moss-audio-4b'],
  matched_model: 'moss-audio-4b',
  latency_ms: 12,
  loopback: true,
  warnings: [],
  warning: null,
  error: null,
}

const MOSS_APPLY = {
  choice: 'skipped',
  ok: true,
  status: 'skipped',
  enabled: false,
  disabled: false,
  manual_required: false,
  managed: false,
  verified: true,
  service_reachable: false,
  verification_pending: false,
  base_url: null,
  model: 'moss-audio-4b',
  commands: [],
  manual_commands: [],
  units: { enable: [], disable: [] },
  helper: {
    configured: false,
    reason: 'not_configured',
    invoked: false,
    returncode: null,
  },
  validation: null,
  verification: null,
  errors: [],
  warnings: [],
  recorded: true,
  record_error: null,
}

const CLIENT_CATALOG = {
  android: {
    kind: 'android',
    available: true,
    action: 'download',
    source: 'local',
    url: '/api/ota/download',
    page_url: 'https://github.com/Xehuri/kinship/releases/tag/onboarding-v1.0.0',
    filename: 'app-debug.apk',
    download_filename: 'Kinship-Android.apk',
    expected_filename: 'Kinship-Android.apk',
    size: 100,
    sha256: 'd'.repeat(64),
    version: '1.4.2',
    variant: 'debug',
    debug: true,
    label: 'debug build',
    fallback_reason: null,
  },
  desktop: {
    kind: 'desktop',
    available: true,
    action: 'download',
    source: 'configured',
    url: 'https://example.com/setup.exe',
    page_url: 'https://github.com/Xehuri/kinship/releases/tag/onboarding-v1.0.0',
    filename: 'Kinship-Desktop-Setup-1.0.0-x64.exe',
    download_filename: 'Kinship-Desktop-Setup-1.0.0-x64.exe',
    expected_filename: 'Kinship-Desktop-Setup-1.0.0-x64.exe',
    size: null,
    sha256: null,
    version: '1.0.0',
    variant: 'release',
    debug: false,
    label: 'release build',
    fallback_reason: 'local_missing',
  },
  connection: {
    host: 'kinship.local',
    https: { enabled: true, port: 8768 },
    http: { enabled: true, port: 8769 },
  },
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

function urlOf(fetchMock: ReturnType<typeof vi.fn>, index = 0): string {
  return String(fetchMock.mock.calls[index]?.[0] ?? '')
}

function methodOf(fetchMock: ReturnType<typeof vi.fn>, index = 0): string {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined
  return init?.method ?? 'GET'
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

describe('onboarding status/preflight v2', () => {
  beforeEach(() => {
    setToken('')
  })

  afterEach(() => {
    clearToken()
    vi.unstubAllGlobals()
  })

  it('GET status 保留 steps/bootstrap/state_version/degraded_reasons', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, ONBOARDING_STATUS)),
    )

    await expect(getOnboardingStatus()).resolves.toEqual(ONBOARDING_STATUS)
  })

  it('GET preflight 归一化 blocking/category/soft_failures/summary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, PREFLIGHT))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getOnboardingPreflight()).resolves.toEqual(PREFLIGHT)
    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/preflight')
  })
})

describe('onboarding assets and jobs', () => {
  beforeEach(() => {
    setToken('')
    localStorage.clear()
    sessionStorage.clear()
  })

  afterEach(() => {
    clearToken()
    vi.unstubAllGlobals()
  })

  it('GET assets 未配置发行源时保留 dependencies 与 error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, ASSETS_NOT_CONFIGURED)),
    )

    const result = await getOnboardingAssets()

    expect(result.configured).toBe(false)
    expect(result.manifest).toBeNull()
    expect(result.assets).toEqual({})
    expect(result.dependencies?.kernel.present).toBe(false)
    expect(result.kernel?.installable).toBe(true)
    expect(result.health?.error).toBe('pidfile_missing')
    expect(result.error).toBe('release_manifest_not_configured')
  })

  it('GET assets 扁平 manifest 响应还原为 manifest 视图', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, ASSETS_CONFIGURED)),
    )

    const result = await getOnboardingAssets()

    expect(result.configured).toBe(true)
    expect(result.manifest?.version).toBe('1.5.0')
    expect(result.manifest?.assets.kernel.file).toBe(
      'axeuh-kernel-1.5.0.tar.gz',
    )
    expect(result.assets.frontend.size).toBe(2048)
    expect(result.dependencies?.disk.free).toBe(1000)
  })

  it('POST assets/download 返回 202 作业, setup token 进头/password 进体', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(202, { job: JOB }))
    vi.stubGlobal('fetch', fetchMock)

    const job = await startAssetDownload('kernel', ' setup-token-1 ', 'pw-1')

    expect(job).toEqual(JOB)
    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/assets/download')
    expect(headersOf(fetchMock)['X-Setup-Token']).toBe('setup-token-1')
    expect(bodyOf(fetchMock)).toEqual({ asset: 'kernel', password: 'pw-1' })
    expect(bodyOf(fetchMock)).not.toHaveProperty('token')
    expect(bodyOf(fetchMock)).not.toHaveProperty('current_password')
    expect(urlOf(fetchMock)).not.toContain('token')
  })

  it('POST assets/download 未提供 setup token/password 时不附加凭据', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(202, { job: JOB }))
    vi.stubGlobal('fetch', fetchMock)

    await startAssetDownload('frontend')

    expect(headersOf(fetchMock)).not.toHaveProperty('X-Setup-Token')
    expect(bodyOf(fetchMock)).toEqual({ asset: 'frontend' })
  })

  it('POST assets/download 409 映射为带 code 的 SystemApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(409, {
          code: 'download_in_progress',
          message: '已有下载作业在进行: abc',
        }),
      ),
    )

    const error = await captureError(startAssetDownload('kernel'))

    expect(error.status).toBe(409)
    expect(error.code).toBe('download_in_progress')
  })

  it('GET jobs/{id} 归一化作业快照', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { job: JOB }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getOnboardingJob('job-abc')).resolves.toEqual(JOB)
    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/jobs/job-abc')
  })

  it('GET jobs/{id} 404 映射为 job_not_found', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(404, { code: 'job_not_found', message: '下载作业不存在' }),
      ),
    )

    const error = await captureError(getOnboardingJob('missing'))

    expect(error.status).toBe(404)
    expect(error.code).toBe('job_not_found')
  })

  it('POST jobs/{id}/cancel 转发 password 与 setup token', async () => {
    const cancelled = { ...JOB, state: 'cancelled', cancel_requested: true }
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { job: cancelled }))
    vi.stubGlobal('fetch', fetchMock)

    const job = await cancelOnboardingJob('job-abc', 'setup-token-2', 'pw-2')

    expect(job.state).toBe('cancelled')
    expect(urlOf(fetchMock)).toBe(
      '/api/system/onboarding/jobs/job-abc/cancel',
    )
    expect(headersOf(fetchMock)['X-Setup-Token']).toBe('setup-token-2')
    expect(bodyOf(fetchMock)).toEqual({ password: 'pw-2' })
  })
})

describe('onboarding kernel models', () => {
  const MODELS_STATUS = {
    manifest_version: '2026.10.26',
    models: [
      {
        id: 'sensevoice',
        tier: 'required',
        source: 'modelscope',
        repo: 'iic/SenseVoiceSmall',
        target: '/models/sensevoice',
        kind: 'directory',
        size_bytes: 940019376,
        gated: false,
        present: false,
        missing_files: ['model.pt'],
        error: null,
      },
      {
        id: 'cnn14',
        tier: 'optional',
        source: 'upstream',
        repo: 'panns/Cnn14_16k',
        target: '/models/cnn14.pth',
        kind: 'file',
        size_bytes: 358668570,
        gated: true,
        present: false,
        missing_files: [],
        error: null,
      },
    ],
    tiers: [
      {
        id: 'required',
        model_ids: ['sensevoice'],
        total_size_bytes: 940019376,
        missing_size_bytes: 940019376,
      },
      {
        id: 'optional',
        model_ids: ['cnn14'],
        total_size_bytes: 358668570,
        missing_size_bytes: 358668570,
      },
    ],
    total_size_bytes: 1298687946,
    required_size_bytes: 940019376,
  }

  beforeEach(() => {
    setToken('')
    localStorage.clear()
    sessionStorage.clear()
  })

  afterEach(() => {
    clearToken()
    vi.unstubAllGlobals()
  })

  it('GET models 归一化逐模型与档位状态', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, MODELS_STATUS))
    vi.stubGlobal('fetch', fetchMock)

    const catalog = await getKernelModels()

    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/models')
    expect(catalog.manifest_version).toBe('2026.10.26')
    expect(catalog.models).toHaveLength(2)
    expect(catalog.models[1]).toMatchObject({
      id: 'cnn14',
      tier: 'optional',
      gated: true,
      present: false,
    })
    expect(catalog.tiers[0].missing_size_bytes).toBe(940019376)
    expect(catalog.required_size_bytes).toBe(940019376)
  })

  it('POST models/download 只发送所选档位与 password, setup token 进头', async () => {
    const job = { ...JOB, kind: 'download:models', asset: 'models' }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(202, { job }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await startKernelModelsDownload(
      { tiers: ['required', 'recommended'] },
      ' setup-token-3 ',
      'pw-3',
    )

    expect(result).toEqual(job)
    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/models/download')
    expect(headersOf(fetchMock)['X-Setup-Token']).toBe('setup-token-3')
    expect(bodyOf(fetchMock)).toEqual({
      tiers: ['required', 'recommended'],
      password: 'pw-3',
    })
    expect(bodyOf(fetchMock)).not.toHaveProperty('models')
    expect(bodyOf(fetchMock)).not.toHaveProperty('token')
    expect(urlOf(fetchMock)).not.toContain('token')
  })
})

describe('onboarding Loom', () => {
  beforeEach(() => {
    setToken('')
  })

  afterEach(() => {
    clearToken()
    vi.unstubAllGlobals()
  })

  it('GET loom 归一化只读状态且响应不含 token 字段', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, LOOM_STATUS))
    vi.stubGlobal('fetch', fetchMock)

    const status = await getLoomOnboarding()

    expect(status.found).toBe(true)
    expect(status.models[0].reasoningEffort).toBe('high')
    expect(status.channels[0].credential_ref).toBe('NEW_API_KEY')
    expect('token' in status).toBe(false)
    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/loom')
    expect(urlOf(fetchMock)).not.toContain('token')
  })

  it('POST loom/validate 只发送选择字段, 不发送密码或 token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, LOOM_VALIDATE))
    vi.stubGlobal('fetch', fetchMock)

    const result = await validateLoomSelection({
      provider: 'new-api',
      model: 'deepseek',
      context_window: 128000,
      max_output: 4096,
    })

    expect(result.valid).toBe(true)
    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/loom/validate')
    expect(bodyOf(fetchMock)).toEqual({
      provider: 'new-api',
      model: 'deepseek',
      context_window: 128000,
      max_output: 4096,
    })
    expect(bodyOf(fetchMock)).not.toHaveProperty('current_password')
    expect(bodyOf(fetchMock)).not.toHaveProperty('token')
  })

  it('POST loom/apply 转发 restart/current_password/setup token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, LOOM_APPLY))
    vi.stubGlobal('fetch', fetchMock)

    const result = await applyLoomSelection(
      { provider: 'new-api', model: 'deepseek' },
      { restart: true, currentPassword: 'pw-3' },
      'setup-token-3',
    )

    expect(result.manual_required).toBe(true)
    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/loom/apply')
    expect(headersOf(fetchMock)['X-Setup-Token']).toBe('setup-token-3')
    expect(bodyOf(fetchMock)).toEqual({
      provider: 'new-api',
      model: 'deepseek',
      restart: true,
      current_password: 'pw-3',
    })
  })

  it('POST loom/apply 无密码时不写 current_password', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, LOOM_APPLY))
    vi.stubGlobal('fetch', fetchMock)

    await applyLoomSelection({ provider: 'new-api', model: 'deepseek' })

    expect(bodyOf(fetchMock)).toEqual({
      provider: 'new-api',
      model: 'deepseek',
      restart: false,
    })
    expect(bodyOf(fetchMock)).not.toHaveProperty('current_password')
  })

  it('POST loom/restart 转发密码与 setup token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, LOOM_RESTART))
    vi.stubGlobal('fetch', fetchMock)

    const result = await restartLoomOnboarding('setup-token-4', 'pw-4')

    expect(result.new_pid).toBe(11)
    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/loom/restart')
    expect(headersOf(fetchMock)['X-Setup-Token']).toBe('setup-token-4')
    expect(bodyOf(fetchMock)).toEqual({ current_password: 'pw-4' })
  })

  it('403 password_required 映射为 typed error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(403, {
          code: 'password_required',
          message: '修改配置需要验证密码',
        }),
      ),
    )

    const error = await captureError(
      applyLoomSelection({ provider: 'new-api', model: 'deepseek' }),
    )

    expect(error.status).toBe(403)
    expect(error.code).toBe('password_required')
  })
})

describe('onboarding Loom runtime', () => {
  beforeEach(() => {
    setToken('')
  })

  afterEach(() => {
    clearToken()
    vi.unstubAllGlobals()
  })

  it('GET loom/runtime 归一化模式、进程、健康与 token 供给状态', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, LOOM_RUNTIME))
    vi.stubGlobal('fetch', fetchMock)

    const runtime = await getLoomRuntime()

    expect(runtime.mode).toBe('systemd')
    expect(runtime.mode_detail.systemd.owned).toBe(true)
    expect(runtime.mode_detail.systemd.active_state).toBe('active')
    expect(runtime.running).toBe(true)
    expect(runtime.pid).toBe(4321)
    expect(runtime.health?.version).toBe('1.2.3')
    expect(runtime.config_exists).toBe(true)
    expect(runtime.token_state?.provisioned).toBe(true)
    expect(runtime.token_state?.fingerprint).toBe('deadbeef')
    expect(runtime).not.toHaveProperty('token')
    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/loom/runtime')
    expect(urlOf(fetchMock)).not.toContain('current_password')
  })

  it('POST token/ensure 转发密码与 setup token 且不发送 token 字段', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, LOOM_TOKEN_STATE))
    vi.stubGlobal('fetch', fetchMock)

    const token = await ensureLoomToken(' setup-token-6 ', 'pw-6')

    expect(token.provisioned).toBe(true)
    expect(token.fingerprint).toBe('deadbeef')
    expect(urlOf(fetchMock)).toBe(
      '/api/system/onboarding/loom/token/ensure',
    )
    expect(headersOf(fetchMock)['X-Setup-Token']).toBe('setup-token-6')
    expect(bodyOf(fetchMock)).toEqual({ current_password: 'pw-6' })
    expect(bodyOf(fetchMock)).not.toHaveProperty('token')
    expect(bodyOf(fetchMock)).not.toHaveProperty('loom_token')
  })

  it('POST config/ensure 转发选择、overwrite、凭据引用与密码', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, LOOM_CONFIG_ENSURE))
    vi.stubGlobal('fetch', fetchMock)

    const result = await ensureLoomConfig(
      { provider: 'new-api', model: 'deepseek' },
      {
        overwrite: true,
        credentialEnv: 'LOOM_KEY_NEW_API',
        currentPassword: 'pw-7',
      },
      'setup-token-7',
    )

    expect(result.created).toBe(true)
    expect(result.credential_ref).toBe('${LOOM_KEY_NEW_API}')
    expect(urlOf(fetchMock)).toBe(
      '/api/system/onboarding/loom/config/ensure',
    )
    expect(headersOf(fetchMock)['X-Setup-Token']).toBe('setup-token-7')
    expect(bodyOf(fetchMock)).toEqual({
      provider: 'new-api',
      model: 'deepseek',
      overwrite: true,
      credential_env: 'LOOM_KEY_NEW_API',
      current_password: 'pw-7',
    })
    expect(bodyOf(fetchMock)).not.toHaveProperty('token')
  })

  it('POST start/stop/restart 使用运行时端点并归一化动作结果', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { ...LOOM_RUNTIME_ACTION, requested: 'start' }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ...LOOM_RUNTIME_ACTION,
          requested: 'stop',
          pid: null,
          new_pid: null,
          detail: 'systemd 停止完成',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ...LOOM_RUNTIME_ACTION,
          requested: 'restart',
          new_pid: 5000,
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const started = await startLoomRuntime('setup-token-8', 'pw-8')
    const stopped = await stopLoomRuntime('setup-token-8', 'pw-8')
    const restarted = await restartLoomRuntime('setup-token-8', 'pw-8')

    expect(started.verified).toBe(true)
    expect(stopped.new_pid).toBe(null)
    expect(restarted.new_pid).toBe(5000)
    expect(urlOf(fetchMock, 0)).toBe('/api/system/onboarding/loom/start')
    expect(urlOf(fetchMock, 1)).toBe('/api/system/onboarding/loom/stop')
    expect(urlOf(fetchMock, 2)).toBe('/api/system/onboarding/loom/restart')
    expect(headersOf(fetchMock, 2)['X-Setup-Token']).toBe('setup-token-8')
    expect(bodyOf(fetchMock, 2)).toEqual({ current_password: 'pw-8' })
  })

  it('runtime 响应缺少合法 mode 时抛 invalid_response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          ...LOOM_RUNTIME,
          mode: 'docker',
        }),
      ),
    )

    await expect(getLoomRuntime()).rejects.toMatchObject({
      status: 200,
      code: 'invalid_response',
    })
  })
})

describe('onboarding MOSS', () => {
  beforeEach(() => {
    setToken('')
  })

  afterEach(() => {
    clearToken()
    vi.unstubAllGlobals()
  })

  it('GET/validate/apply MOSS 使用目标端点并转发密码', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, MOSS_STATUS))
      .mockResolvedValueOnce(jsonResponse(200, MOSS_VALIDATION))
      .mockResolvedValueOnce(jsonResponse(200, MOSS_APPLY))
    vi.stubGlobal('fetch', fetchMock)

    const status = await getMossOnboarding()
    const validation = await validateMossConfig(
      'http://127.0.0.1:8100/v1',
      'moss-audio-4b',
    )
    const applied = await applyMossChoice(
      'skipped',
      { baseUrl: 'http://127.0.0.1:8100/v1', currentPassword: 'pw-5' },
      'setup-token-5',
    )

    expect(status.managed_available).toBe(false)
    expect(validation.reachable).toBe(true)
    expect(applied.status).toBe('skipped')
    expect(urlOf(fetchMock, 0)).toBe('/api/system/onboarding/moss')
    expect(urlOf(fetchMock, 1)).toBe('/api/system/onboarding/moss/validate')
    expect(bodyOf(fetchMock, 1)).toEqual({
      base_url: 'http://127.0.0.1:8100/v1',
      model: 'moss-audio-4b',
    })
    expect(urlOf(fetchMock, 2)).toBe('/api/system/onboarding/moss/apply')
    expect(headersOf(fetchMock, 2)['X-Setup-Token']).toBe('setup-token-5')
    expect(bodyOf(fetchMock, 2)).toEqual({
      choice: 'skipped',
      base_url: 'http://127.0.0.1:8100/v1',
      current_password: 'pw-5',
    })
  })

  it('MOSS apply 未提供密码时 body 不含 current_password', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, MOSS_APPLY))
    vi.stubGlobal('fetch', fetchMock)

    await applyMossChoice('disabled')

    expect(bodyOf(fetchMock)).toEqual({ choice: 'disabled' })
  })
})

describe('onboarding clients', () => {
  beforeEach(() => {
    setToken('')
  })

  afterEach(() => {
    clearToken()
    vi.unstubAllGlobals()
  })

  it('GET clients 只含 android/desktop/connection, 无 pc_sensor', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, CLIENT_CATALOG))
    vi.stubGlobal('fetch', fetchMock)

    const catalog = await getClientCatalog()

    expect(catalog).toEqual(CLIENT_CATALOG)
    expect(Object.keys(catalog)).toEqual(['android', 'desktop', 'connection'])
    expect(catalog).not.toHaveProperty('pc_sensor')
    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/clients')
    expect(urlOf(fetchMock)).not.toContain('token')
  })

  it('旧服务端缺少 action/page_url 时给出安全默认值', async () => {
    const legacy = {
      android: {
        kind: 'android',
        available: true,
        source: 'release',
        url: 'https://example.test/Kinship.apk',
        filename: 'Kinship.apk',
        download_filename: 'Kinship.apk',
        size: null,
        sha256: null,
        version: '1.4.2',
        variant: 'release',
        debug: false,
        label: 'release build',
      },
      desktop: {
        kind: 'desktop',
        available: false,
        source: 'none',
        url: null,
        filename: null,
        download_filename: null,
        size: null,
        sha256: null,
        version: null,
        variant: null,
        debug: null,
        label: null,
      },
      connection: {
        host: 'legacy.local',
        https: { enabled: true, port: 8768 },
        http: { enabled: false, port: 0 },
      },
    }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, legacy))
    vi.stubGlobal('fetch', fetchMock)

    const catalog = await getClientCatalog()

    expect(catalog.android).toMatchObject({
      available: true,
      action: 'download',
      source: 'configured',
      page_url: null,
      expected_filename: null,
      fallback_reason: null,
    })
    expect(catalog.desktop).toMatchObject({
      available: false,
      action: 'none',
      source: 'none',
      page_url: null,
      expected_filename: null,
      fallback_reason: null,
    })
  })
})

const STARTUP_REPORT = {
  ok: true,
  state: 'validated',
  mode: 'validation',
  subsystems: {
    config_store: 'ok',
    kernel: 'ok',
    moss: 'skipped',
    health_cloud: 'deferred',
  },
  checks: [
    {
      id: 'config_store',
      status: 'ok',
      kind: 'required',
      required: true,
      detail: 'revision=r1',
    },
    {
      id: 'kernel',
      status: 'ok',
      kind: 'conditional',
      required: false,
      detail: 'kernel installed (not running; lazy start)',
    },
    {
      id: 'moss',
      status: 'skipped',
      kind: 'conditional',
      required: false,
      detail: 'prerequisite not met',
    },
    {
      id: 'health_cloud',
      status: 'deferred',
      kind: 'deferred',
      required: false,
      detail: 'not started in validation mode',
    },
  ],
  errors: [],
  warnings: [
    {
      subsystem: 'kernel',
      warning: 'kernel is not running; it starts on demand',
    },
  ],
  deferred: ['health_cloud', 'qq_gateway', 'p2p'],
  generated_at: '2026-10-26T00:00:00+00:00',
}

const STARTUP_RESPONSE = {
  ...STARTUP_REPORT,
  startup: STARTUP_REPORT,
  runtime: {
    available: true,
    active: true,
    started: true,
    state: 'validated',
    committed: false,
    gate_open: false,
  },
  lifecycle: {
    activated: false,
    active: true,
    reason: 'validate',
    requested_reason: '',
    subsystems: { config_store: 'ok' },
    errors: [],
    idempotent: false,
    ok: true,
    state: 'validated',
    gate_open: false,
    committed: false,
    validated: true,
    promoted: false,
    started: true,
    status: 'ok',
  },
}

describe('onboarding startup validation', () => {
  beforeEach(() => {
    setToken('')
  })

  afterEach(() => {
    clearToken()
    vi.unstubAllGlobals()
  })

  it('GET startup 归一化报告、运行时与生命周期', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, STARTUP_RESPONSE))
    vi.stubGlobal('fetch', fetchMock)

    const result = await getStartupOnboarding()

    expect(result.report).toMatchObject(STARTUP_REPORT)
    expect(result.runtime).toMatchObject(STARTUP_RESPONSE.runtime)
    expect(result.lifecycle).toMatchObject(STARTUP_RESPONSE.lifecycle)
    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/startup')
  })

  it('POST attempt 发送 password 与 setup token, 不发 current_password', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, STARTUP_RESPONSE))
    vi.stubGlobal('fetch', fetchMock)

    await attemptStartup('setup-token-1', 'pw-1')

    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/startup/attempt')
    expect(bodyOf(fetchMock)).toEqual({ password: 'pw-1' })
    expect(headersOf(fetchMock)['X-Setup-Token']).toBe('setup-token-1')
  })

  it('POST validate 只读调用, 不携带密码或 setup token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, STARTUP_RESPONSE))
    vi.stubGlobal('fetch', fetchMock)

    await validateStartup()

    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/startup/validate')
    expect(bodyOf(fetchMock)).toEqual({})
    expect(headersOf(fetchMock)['X-Setup-Token']).toBeUndefined()
  })

  it('POST abort 发送 password', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, STARTUP_RESPONSE))
    vi.stubGlobal('fetch', fetchMock)

    await abortStartup(undefined, 'pw-2')

    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/startup/abort')
    expect(bodyOf(fetchMock)).toEqual({ password: 'pw-2' })
  })

  it('409 startup_failed 保留校验报告供前端展示', async () => {
    const failed = { ...STARTUP_REPORT, ok: false, state: 'failed' }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(409, {
          code: 'startup_failed',
          message: '启动校验未通过，处理后重新校验',
          startup: failed,
          runtime: STARTUP_RESPONSE.runtime,
        }),
      ),
    )

    const error = await captureError(attemptStartup(undefined, 'pw-1'))

    expect(error.status).toBe(409)
    expect(error.code).toBe('startup_failed')
    expect(error.data.startup).toMatchObject({ ok: false, state: 'failed' })
  })

  it('normalizer 对缺字段响应给出安全默认值, 非报告响应返回 null', () => {
    const minimal = normalizeStartupStatus({
      state: 'deferred',
      runtime: { available: true },
    })
    expect(minimal?.report.ok).toBeNull()
    expect(minimal?.report.checks).toEqual([])
    expect(minimal?.runtime.available).toBe(true)
    expect(minimal?.runtime.state).toBe('')
    expect(minimal?.lifecycle).toBeNull()

    expect(normalizeStartupStatus({ code: 'startup_failed' })).toBeNull()
  })
})

const OTA_TICKET = {
  ticket: 'one-time-ticket',
  url: '/api/ota/download?ticket=one-time-ticket',
  expires_at: 1_800_000_000,
  expires_in: 60,
  filename: 'Kinship-1.4.2-debug.apk',
  source_filename: 'app-debug.apk',
  sha256: 'a'.repeat(64),
  size: 88_600_000,
}

describe('ota download ticket', () => {
  beforeEach(() => {
    setToken('')
  })

  afterEach(() => {
    clearToken()
    vi.unstubAllGlobals()
  })

  it('POST /api/ota/ticket returns a typed ticket URL without a Bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, OTA_TICKET))
    vi.stubGlobal('fetch', fetchMock)

    const ticket = await createOtaTicket()

    expect(ticket).toEqual(OTA_TICKET)
    expect(urlOf(fetchMock)).toBe('/api/ota/ticket')
    expect(ticket.url).toContain('?ticket=')
    expect(ticket.url).not.toContain('Bearer')
    expect(ticket.url).not.toContain('token=')
  })

  it('surfaces a missing artifact as SystemApiError', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(404, { detail: '更新文件不存在' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(createOtaTicket()).rejects.toMatchObject({
      status: 404,
      message: '更新文件不存在',
    })
  })
})

const STORAGE_SNAPSHOT = {
  data_root: '/srv/var',
  models_root: '/opt/kinship-models',
  free_bytes: 64 * 1024 ** 3,
  writable: true,
  source: { data_root: 'config', models_root: 'env' },
  models_dir_configured: true,
  data_root_configured: false,
  legacy: {
    exists: true,
    home: '/home/user',
    suggested_root: '/home/user',
    modelscope: true,
    huggingface: false,
    axeuh_kernel: false,
    paths: { modelscope: '/home/user/.cache/modelscope' },
  },
  system_disk: true,
  system_drive: 'C:',
  warnings: ['模型根位于系统盘（C:）'],
}

describe('onboarding storage', () => {
  beforeEach(() => {
    setToken('')
    localStorage.clear()
    sessionStorage.clear()
  })

  afterEach(() => {
    clearToken()
    vi.unstubAllGlobals()
  })

  it('GET storage 归一化根路径、来源、旧缓存与告警', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, STORAGE_SNAPSHOT))
    vi.stubGlobal('fetch', fetchMock)

    const snapshot = await getOnboardingStorage()

    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/storage')
    expect(snapshot.models_root).toBe('/opt/kinship-models')
    expect(snapshot.source.models_root).toBe('env')
    expect(snapshot.legacy.exists).toBe(true)
    expect(snapshot.legacy.suggested_root).toBe('/home/user')
    expect(snapshot.system_disk).toBe(true)
    expect(snapshot.warnings).toEqual(['模型根位于系统盘（C:）'])
  })

  it('POST storage 只发送 models_dir 与 password, setup token 进头', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, STORAGE_SNAPSHOT))
    vi.stubGlobal('fetch', fetchMock)

    const result = await saveOnboardingStorage(
      '/opt/kinship-models',
      ' setup-token-4 ',
      'pw-4',
    )

    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/storage')
    expect(headersOf(fetchMock)['X-Setup-Token']).toBe('setup-token-4')
    expect(bodyOf(fetchMock)).toEqual({
      models_dir: '/opt/kinship-models',
      password: 'pw-4',
    })
    expect(bodyOf(fetchMock)).not.toHaveProperty('data_root')
    expect(result.models_root).toBe('/opt/kinship-models')
  })

  it('POST storage 把 409 暴露为 SystemApiError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(409, {
        code: 'env_locked',
        message: 'models.dir 被环境变量覆盖层锁定',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const error = await captureError(
      saveOnboardingStorage('/opt/kinship-models'),
    )

    expect(error.status).toBe(409)
    expect(error.code).toBe('env_locked')
    expect(error.message).toContain('锁定')
  })
})

const V4_XIAOMI_STATUS = {
  enabled: true,
  configured: false,
  phase: 'waiting_login',
  userid_masked: '138****0000',
  userid_configured: false,
  region: 'cn',
  last_error: '',
  needs_login: true,
}

const V4_XIAOMI_QR = {
  lp: 'lp-token-1',
  qr_base64: 'data:image/png;base64,AAAA',
  expires_in: 300,
  login_url: 'https://example.test/qr/lp-token-1',
}

const V4_QQ_STATUS = {
  enabled: true,
  self_qq: '12345678',
  ws_url: 'ws://127.0.0.1:3001',
  ws_token_configured: true,
  mcp_token_configured: true,
  valid: true,
  errors: [],
}

const V4_MOSS_CONFIG = {
  enabled: true,
  base_url: 'http://127.0.0.1:8100/v1',
  model: 'moss-audio-4b',
}

const V4_LOOM_SETUP = {
  ok: true,
  stage: 'done',
  loom: {
    url: 'http://127.0.0.1:6000',
    port: 6000,
    mode: 'systemd',
    pid: 4321,
    health: {
      status: 'ok',
      version: '1.2.3',
      uptime_ms: 100,
      started_at: null,
    },
    catalog_models: ['deepseek'],
  },
  applied: {
    ai_backend: 'loom',
    config_path: '/srv/ai/.loom/config.yaml',
    api_key_configured: true,
  },
}

const V4_FINISH_GROUPS = {
  blocking: [
    {
      layer: 'preflight',
      id: 'ports',
      title: '端口占用',
      message: '端口 8768 被占用',
      fix: '释放端口后重试',
    },
  ],
  soft: [
    {
      layer: 'moss',
      id: 'moss_unreachable',
      title: 'MOSS 深度音频',
      message: '无法连接 MOSS',
      fix: '',
    },
  ],
}

const V4_FINISH_CLOSING = {
  title: '初始化完成',
  message: '系统已完成初始化，你可以开始使用了。',
  enabled: [
    { id: 'xiaomi', label: '小米健康云' },
    { id: 'clients', label: '客户端' },
  ],
  skipped: [{ id: 'moss', label: 'MOSS 深度音频' }],
  degraded: [{ id: 'moss_unreachable', message: '无法连接 MOSS' }],
  enter_label: '进入主界面',
}

const V4_FINISH_ACTIVATION = {
  activated: true,
  active: true,
  reason: 'onboarding_finish',
  requested_reason: '',
  subsystems: { qq_gateway: 'active' },
  errors: [],
  idempotent: false,
  ok: true,
  state: 'committed',
  gate_open: false,
  committed: true,
  validated: true,
  promoted: true,
  started: true,
  status: 'ok',
}

const V4_FINISH_STATE = {
  version: 4,
  completed_steps: ['welcome', 'account', 'finish'],
  skipped_steps: ['moss'],
  current_step: 'finish',
  completed: true,
  started_at: '2026-10-27T00:00:00Z',
  updated_at: '2026-10-27T01:00:00Z',
}

describe('onboarding v4 xiaomi', () => {
  beforeEach(() => {
    setToken('')
  })

  afterEach(() => {
    clearToken()
    vi.unstubAllGlobals()
  })

  it('GET xiaomi 归一化脱敏状态字段', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, V4_XIAOMI_STATUS))
    vi.stubGlobal('fetch', fetchMock)

    const status = await getXiaomiOnboarding()

    expect(status).toEqual(V4_XIAOMI_STATUS)
    expect(status).not.toHaveProperty('userid')
    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/xiaomi')
    expect(methodOf(fetchMock)).toBe('GET')
  })

  it('POST xiaomi/config 发送 current_password 与 setup token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, V4_XIAOMI_STATUS))
    vi.stubGlobal('fetch', fetchMock)

    await configureXiaomi(
      { enabled: true, current_password: 'pw-x' },
      ' setup-token-x ',
    )

    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/xiaomi/config')
    expect(methodOf(fetchMock)).toBe('POST')
    expect(headersOf(fetchMock)['X-Setup-Token']).toBe('setup-token-x')
    expect(bodyOf(fetchMock)).toEqual({
      enabled: true,
      current_password: 'pw-x',
    })
    expect(bodyOf(fetchMock)).not.toHaveProperty('password')
  })

  it('POST xiaomi/qr 与 qr/poll 携带 setup token, poll 带 lp', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, V4_XIAOMI_QR))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          state: 'success',
          userid_masked: '138****0000',
          configured: true,
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const qr = await requestXiaomiQr(' setup-token-q ', 'pw-q')
    const polled = await pollXiaomiQr('lp-token-1', ' setup-token-q ', 'pw-q')

    expect(qr.lp).toBe('lp-token-1')
    expect(qr.qr_base64).toContain('base64')
    expect(polled).toEqual({
      state: 'success',
      userid_masked: '138****0000',
      configured: true,
    })
    expect(urlOf(fetchMock, 0)).toBe('/api/system/onboarding/xiaomi/qr')
    expect(urlOf(fetchMock, 1)).toBe('/api/system/onboarding/xiaomi/qr/poll')
    expect(methodOf(fetchMock, 1)).toBe('POST')
    expect(headersOf(fetchMock, 1)['X-Setup-Token']).toBe('setup-token-q')
    expect(bodyOf(fetchMock, 0)).toEqual({ current_password: 'pw-q' })
    expect(bodyOf(fetchMock, 1)).toEqual({
      lp: 'lp-token-1',
      current_password: 'pw-q',
    })
  })

  it('poll 返回未知 state 时抛 invalid_response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { state: 'scanned' })),
    )

    await expect(pollXiaomiQr('lp-1')).rejects.toMatchObject({
      status: 200,
      code: 'invalid_response',
    })
  })
})

describe('onboarding v4 QQ', () => {
  const QQ_BODY = {
    enabled: true,
    self_qq: '12345678',
    ws_url: 'ws://127.0.0.1:3001',
    ws_token: 'secret-token',
    regenerate_mcp_token: true,
    current_password: 'pw-qq',
  }

  beforeEach(() => {
    setToken('')
  })

  afterEach(() => {
    clearToken()
    vi.unstubAllGlobals()
  })

  it('GET qq 归一化布尔状态与字段错误', async () => {
    const invalid = {
      ...V4_QQ_STATUS,
      valid: false,
      errors: [
        { field: 'ws_url', message: 'ws_url 必须以 ws:// 或 wss:// 开头' },
      ],
    }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, invalid))
    vi.stubGlobal('fetch', fetchMock)

    const status = await getQqOnboarding()

    expect(status.valid).toBe(false)
    expect(status.errors[0]).toEqual(invalid.errors[0])
    expect(status).not.toHaveProperty('ws_token')
    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/qq')
  })

  it('POST qq/validate 与 qq/config 发送完整配置和 setup token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { valid: true, errors: [] }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { ...V4_QQ_STATUS, starts_after_finish: true }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const validation = await validateQqConfig(QQ_BODY, ' setup-token-qq ')
    const configured = await configureQq(QQ_BODY, ' setup-token-qq ')

    expect(validation).toEqual({ valid: true, errors: [] })
    expect(configured.starts_after_finish).toBe(true)
    expect(urlOf(fetchMock, 0)).toBe('/api/system/onboarding/qq/validate')
    expect(urlOf(fetchMock, 1)).toBe('/api/system/onboarding/qq/config')
    expect(methodOf(fetchMock, 1)).toBe('POST')
    expect(headersOf(fetchMock, 1)['X-Setup-Token']).toBe('setup-token-qq')
    expect(bodyOf(fetchMock, 0)).toEqual(QQ_BODY)
    expect(bodyOf(fetchMock, 1)).toEqual(QQ_BODY)
    expect(bodyOf(fetchMock, 1)).toHaveProperty('current_password', 'pw-qq')
  })

  it('QQ status 缺少 valid 布尔时抛 invalid_response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { enabled: true })),
    )

    await expect(getQqOnboarding()).rejects.toMatchObject({
      status: 200,
      code: 'invalid_response',
    })
  })
})

describe('onboarding v4 MOSS', () => {
  beforeEach(() => {
    setToken('')
  })

  afterEach(() => {
    clearToken()
    vi.unstubAllGlobals()
  })

  it('GET/POST moss 只发送 enabled/base_url/model 与密码', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, V4_MOSS_CONFIG))
      .mockResolvedValueOnce(
        jsonResponse(200, { ...V4_MOSS_CONFIG, starts_after_finish: true }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const current = await getMossConfig()
    const saved = await configureMoss(
      {
        enabled: true,
        base_url: 'http://127.0.0.1:8100/v1',
        model: 'moss-audio-4b',
        current_password: 'pw-moss',
      },
      ' setup-token-moss ',
    )

    expect(current).toEqual(V4_MOSS_CONFIG)
    expect(saved).toEqual(V4_MOSS_CONFIG)
    expect(urlOf(fetchMock, 0)).toBe('/api/system/onboarding/moss')
    expect(urlOf(fetchMock, 1)).toBe('/api/system/onboarding/moss/config')
    expect(methodOf(fetchMock, 1)).toBe('POST')
    expect(headersOf(fetchMock, 1)['X-Setup-Token']).toBe('setup-token-moss')
    expect(bodyOf(fetchMock, 1)).toEqual({
      enabled: true,
      base_url: 'http://127.0.0.1:8100/v1',
      model: 'moss-audio-4b',
      current_password: 'pw-moss',
    })
  })
})

describe('onboarding v4 Loom setup', () => {
  beforeEach(() => {
    setToken('')
  })

  afterEach(() => {
    clearToken()
    vi.unstubAllGlobals()
  })

  it('POST loom/setup 发送内联 api_key 与密码, 响应不回显密钥', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, V4_LOOM_SETUP))
    vi.stubGlobal('fetch', fetchMock)

    const result = await setupLoom(
      {
        port: 6000,
        provider: 'new-api',
        base_url: 'https://api.example.test/v1',
        model: 'deepseek',
        api_key: 'sk-secret',
        context_window: 128000,
        max_output: 8192,
        timeout: 600000,
        pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        current_password: 'pw-loom',
      },
      ' setup-token-loom ',
    )

    expect(result.loom).toEqual(V4_LOOM_SETUP.loom)
    expect(result.applied).toEqual(V4_LOOM_SETUP.applied)
    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/loom/setup')
    expect(methodOf(fetchMock)).toBe('POST')
    expect(headersOf(fetchMock)['X-Setup-Token']).toBe('setup-token-loom')
    expect(bodyOf(fetchMock)).toMatchObject({
      port: 6000,
      provider: 'new-api',
      base_url: 'https://api.example.test/v1',
      model: 'deepseek',
      api_key: 'sk-secret',
      current_password: 'pw-loom',
    })
    expect(urlOf(fetchMock)).not.toContain('sk-secret')
    expect(JSON.stringify(result)).not.toContain('sk-secret')
  })

  it('setup 失败响应 (ok=false) 保留错误码与 stage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          ok: false,
          code: 'loom_provider_auth_failed',
          stage: 'provider_probe',
          message: '供应商鉴权失败',
          field: 'api_key',
          details: { http_status: 401 },
        }),
      ),
    )

    const result = await setupLoom({
      port: 6000,
      provider: 'new-api',
      base_url: 'https://api.example.test/v1',
      model: 'deepseek',
    })

    expect(result.ok).toBe(false)
    expect(result.code).toBe('loom_provider_auth_failed')
    expect(result.stage).toBe('provider_probe')
    expect(result.field).toBe('api_key')
    expect(result.applied.api_key_configured).toBe(false)
  })
})

describe('onboarding v4 finish', () => {
  beforeEach(() => {
    setToken('')
  })

  afterEach(() => {
    clearToken()
    vi.unstubAllGlobals()
  })

  it('GET finish 归一化 groups/closing/runtime/startup', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        runtime: {
          available: true,
          active: true,
          started: true,
          state: 'deferred',
          committed: false,
          gate_open: true,
        },
        startup: STARTUP_REPORT,
        lifecycle: null,
        groups: V4_FINISH_GROUPS,
        activation: V4_FINISH_ACTIVATION,
        closing: V4_FINISH_CLOSING,
        finish: {
          groups: V4_FINISH_GROUPS,
          activation: V4_FINISH_ACTIVATION,
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const status = await getOnboardingFinish()

    expect(status.groups).toEqual(V4_FINISH_GROUPS)
    expect(status.closing).toEqual(V4_FINISH_CLOSING)
    expect(status.runtime.state).toBe('deferred')
    expect(status.startup.state).toBe('validated')
    expect(status.finish.groups).toEqual(V4_FINISH_GROUPS)
    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/finish')
    expect(methodOf(fetchMock)).toBe('GET')
  })

  it('POST finish 发送 allow_degraded 与 current_password', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        state: V4_FINISH_STATE,
        activation: V4_FINISH_ACTIVATION,
        groups: V4_FINISH_GROUPS,
        closing: V4_FINISH_CLOSING,
        idempotent: true,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await finishOnboarding(
      true,
      'pw-finish',
      ' setup-token-finish ',
    )

    expect(result.ok).toBe(true)
    expect(result.idempotent).toBe(true)
    expect(result.closing.enter_label).toBe('进入主界面')
    expect(urlOf(fetchMock)).toBe('/api/system/onboarding/finish')
    expect(methodOf(fetchMock)).toBe('POST')
    expect(headersOf(fetchMock)['X-Setup-Token']).toBe('setup-token-finish')
    expect(bodyOf(fetchMock)).toEqual({
      allow_degraded: true,
      current_password: 'pw-finish',
    })
    expect(bodyOf(fetchMock)).not.toHaveProperty('password')
  })

  it('POST finish 409 保留 groups/closing 到 SystemApiError.data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(409, {
          ok: false,
          code: 'finish_blocked',
          message: '集成配置存在阻塞项，处理后重试',
          groups: V4_FINISH_GROUPS,
          closing: V4_FINISH_CLOSING,
          report: {},
          runtime: {},
          activation: {},
        }),
      ),
    )

    const error = await captureError(finishOnboarding(false))

    expect(error.status).toBe(409)
    expect(error.code).toBe('finish_blocked')
    expect(error.data.groups).toEqual(V4_FINISH_GROUPS)
    expect(error.data.closing).toEqual(V4_FINISH_CLOSING)
  })

  it('finish 响应缺少 groups/closing 时抛 invalid_response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { ok: true })),
    )

    await expect(finishOnboarding(false)).rejects.toMatchObject({
      status: 200,
      code: 'invalid_response',
    })
  })
})
