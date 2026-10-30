/// <reference types="vitest/globals" />

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  getOnboardingPreflight: vi.fn(),
  getOnboardingStatus: vi.fn(),
  postOnboardingState: vi.fn(),
  runOnboardingAction: vi.fn(),
  getOnboardingAssets: vi.fn(),
  startAssetDownload: vi.fn(),
  getOnboardingJob: vi.fn(),
  cancelOnboardingJob: vi.fn(),
  getLoomOnboarding: vi.fn(),
  getLoomRuntime: vi.fn(),
  ensureLoomToken: vi.fn(),
  ensureLoomConfig: vi.fn(),
  startLoomRuntime: vi.fn(),
  stopLoomRuntime: vi.fn(),
  restartLoomRuntime: vi.fn(),
  validateLoomSelection: vi.fn(),
  applyLoomSelection: vi.fn(),
  restartLoomOnboarding: vi.fn(),
  getMossOnboarding: vi.fn(),
  validateMossConfig: vi.fn(),
  applyMossChoice: vi.fn(),
  getClientCatalog: vi.fn(),
  getXiaomiOnboarding: vi.fn(),
  configureXiaomi: vi.fn(),
  requestXiaomiQr: vi.fn(),
  pollXiaomiQr: vi.fn(),
  getQqOnboarding: vi.fn(),
  validateQqConfig: vi.fn(),
  configureQq: vi.fn(),
  getMossConfig: vi.fn(),
  configureMoss: vi.fn(),
  setupLoom: vi.fn(),
  getOnboardingFinish: vi.fn(),
  finishOnboarding: vi.fn(),
}))

vi.mock('@/api/system', () => {
  class SystemApiError extends Error {
    readonly status: number
    readonly code: string
    readonly errors: unknown[]
    readonly data: Record<string, unknown>

    constructor(
      status: number,
      code: string,
      message: string,
      errors: unknown[] = [],
      data: Record<string, unknown> = {},
    ) {
      super(message)
      this.name = 'SystemApiError'
      this.status = status
      this.code = code
      this.errors = errors
      this.data = data
    }
  }
  return {
    SystemApiError,
    getOnboardingPreflight: mocks.getOnboardingPreflight,
    getOnboardingStatus: mocks.getOnboardingStatus,
    postOnboardingState: mocks.postOnboardingState,
    runOnboardingAction: mocks.runOnboardingAction,
    getOnboardingAssets: mocks.getOnboardingAssets,
    startAssetDownload: mocks.startAssetDownload,
    getOnboardingJob: mocks.getOnboardingJob,
    cancelOnboardingJob: mocks.cancelOnboardingJob,
    getLoomOnboarding: mocks.getLoomOnboarding,
    getLoomRuntime: mocks.getLoomRuntime,
    ensureLoomToken: mocks.ensureLoomToken,
    ensureLoomConfig: mocks.ensureLoomConfig,
    startLoomRuntime: mocks.startLoomRuntime,
    stopLoomRuntime: mocks.stopLoomRuntime,
    restartLoomRuntime: mocks.restartLoomRuntime,
    validateLoomSelection: mocks.validateLoomSelection,
    applyLoomSelection: mocks.applyLoomSelection,
    restartLoomOnboarding: mocks.restartLoomOnboarding,
    getMossOnboarding: mocks.getMossOnboarding,
    validateMossConfig: mocks.validateMossConfig,
    applyMossChoice: mocks.applyMossChoice,
    getClientCatalog: mocks.getClientCatalog,
    getXiaomiOnboarding: mocks.getXiaomiOnboarding,
    configureXiaomi: mocks.configureXiaomi,
    requestXiaomiQr: mocks.requestXiaomiQr,
    pollXiaomiQr: mocks.pollXiaomiQr,
    getQqOnboarding: mocks.getQqOnboarding,
    validateQqConfig: mocks.validateQqConfig,
    configureQq: mocks.configureQq,
    getMossConfig: mocks.getMossConfig,
    configureMoss: mocks.configureMoss,
    setupLoom: mocks.setupLoom,
    getOnboardingFinish: mocks.getOnboardingFinish,
    finishOnboarding: mocks.finishOnboarding,
  }
})

import { useOnboarding } from '@/composables/useOnboarding'
import { useApi } from '@/composables/useApi'
import { fallbackOnboardingSteps } from '@/config/onboardingSteps'
import { SystemApiError, type OnboardingStatus } from '@/api/system'

function onboardingStatus(
  overrides: Partial<OnboardingStatus> = {},
): OnboardingStatus {
  return {
    state: {
      version: 2,
      completed_steps: [],
      skipped_steps: [],
      current_step: 'welcome',
      completed: false,
      started_at: null,
      updated_at: null,
    },
    needs_setup: true,
    degraded: false,
    onboarding_complete: false,
    config_revision: '',
    steps: [],
    bootstrap: true,
    state_version: 2,
    legacy_upgraded: false,
    degraded_reasons: [],
    ...overrides,
  }
}

function job(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'job-1',
    kind: 'download:kernel',
    state: 'running',
    asset: 'kernel',
    progress: { bytes: 0, total: 100, pct: 0 },
    current: 'download',
    logs_tail: [],
    result: null,
    error: null,
    cancel_requested: false,
    created_at: '2026-10-26T00:00:00Z',
    updated_at: '2026-10-26T00:00:01Z',
    ...overrides,
  }
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
    uptime_ms: 10,
    started_at: null,
  },
  main_model: null,
  models: [],
  channels: [],
  providers: [],
  credentials: [],
  config: null,
  managed_config: { path: '/tmp/config.yaml', exists: true },
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
  units: { enable: [], disable: [] },
  commands: { enable: [], disable: [] },
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

const CLIENT_CATALOG = {
  android: {
    kind: 'android',
    available: true,
    source: 'local',
    url: '/api/ota/download',
    filename: 'app-debug.apk',
    download_filename: 'Kinship-Android.apk',
    size: 1,
    sha256: 'abc',
    version: '1.4.2',
    variant: 'debug',
    debug: true,
    label: 'debug build',
  },
  desktop: {
    kind: 'desktop',
    available: true,
    source: 'release',
    url: 'https://example.com/setup.exe',
    filename: 'setup.exe',
    download_filename: 'setup.exe',
    size: null,
    sha256: null,
    version: '1.0.0',
    variant: 'release',
    debug: false,
    label: 'release build',
  },
  connection: {
    host: 'kinship.local',
    https: { enabled: true, port: 8768 },
    http: { enabled: true, port: 8769 },
  },
}

describe('useOnboarding', () => {
  const onb = useOnboarding()

  beforeEach(() => {
    vi.clearAllMocks()
    onb.status.value = null
    onb.preflight.value = null
    onb.activation.value = null
    onb.error.value = null
    onb.assets.value = null
    onb.job.value = null
    onb.loom.value = null
    onb.loomRuntime.value = null
    onb.loomValidation.value = null
    onb.loomApplyResult.value = null
    onb.moss.value = null
    onb.mossValidation.value = null
    onb.mossApplyResult.value = null
    onb.clients.value = null
    onb.xiaomi.value = null
    onb.qq.value = null
    onb.mossConfig.value = null
    onb.loomSetupResult.value = null
    onb.finish.value = null
    onb.finishGroups.value = null
    onb.finishClosing.value = null
    onb.finishError.value = null
  })

  it('logout 清空 onboarding 的 QQ 状态', () => {
    onb.status.value = onboardingStatus()
    onb.qq.value = {
      enabled: true,
      self_qq: '12345678',
      ws_url: 'ws://127.0.0.1:3001',
      ws_token_configured: true,
      mcp_token_configured: true,
      valid: true,
      errors: [],
    }

    useApi().logout()

    expect(onb.qq.value).toBeNull()
    expect(onb.status.value).toBeNull()
  })

  it('keeps the finish activation returned by recordStep', async () => {
    mocks.postOnboardingState.mockResolvedValue({
      state: {
        version: 2,
        completed_steps: ['finish'],
        skipped_steps: [],
        current_step: 'finish',
        completed: true,
        started_at: null,
        updated_at: null,
      },
      recorded: true,
      activation: {
        activated: true,
        active: true,
        reason: 'onboarding_finish',
        subsystems: {},
        errors: [],
        idempotent: false,
      },
    })

    await onb.recordStep('finish', 'completed', { allow_degraded: false })

    expect(onb.activation.value?.activated).toBe(true)
    expect(onb.activation.value?.active).toBe(true)
  })

  it('forwards the current password to runOnboardingAction', async () => {
    mocks.runOnboardingAction.mockResolvedValue({ ok: true, result: {} })

    const result = await onb.action(
      'generate_self_signed_cert',
      false,
      'setup-token-1',
      'pw-123456',
    )

    expect(result).toEqual({ ok: true, result: {} })
    expect(mocks.runOnboardingAction).toHaveBeenCalledWith(
      { action: 'generate_self_signed_cert', overwrite: false },
      'setup-token-1',
      'pw-123456',
    )
  })

  it('omits the password argument when none is supplied', async () => {
    mocks.runOnboardingAction.mockResolvedValue({ ok: true, result: {} })

    await onb.action('copy_ai_template', true)

    expect(mocks.runOnboardingAction).toHaveBeenCalledWith(
      { action: 'copy_ai_template', overwrite: true },
      undefined,
      undefined,
    )
  })

  it('uses fallback steps before the first status response', () => {
    expect(onb.steps.value.map((step) => step.id)).toEqual(
      fallbackOnboardingSteps().map((step) => step.id),
    )
    expect(onb.steps.value[0].state).toBe('current')
  })

  it('uses authoritative steps and exposes bootstrap/degradedReasons', async () => {
    const steps = [
      {
        id: 'welcome',
        title: '欢迎',
        description: '开始',
        required: true,
        skippable: false,
        state: 'completed' as const,
        auth: 'none',
      },
      {
        id: 'account',
        title: '管理员账号',
        description: '建号',
        required: true,
        skippable: false,
        state: 'current' as const,
        auth: 'setup_token',
      },
    ]
    mocks.getOnboardingStatus.mockResolvedValue(
      onboardingStatus({
        steps,
        bootstrap: true,
        degraded_reasons: ['config_degraded'],
      }),
    )
    mocks.getOnboardingPreflight.mockResolvedValue({
      checks: [],
      can_proceed: true,
      blocking_failures: [],
      soft_failures: [],
      summary: { pass: 0, warn: 0, fail: 0 },
    })

    await onb.refresh()

    expect(onb.steps.value).toEqual(steps)
    expect(onb.bootstrap.value).toBe(true)
    expect(onb.degradedReasons.value).toEqual(['config_degraded'])
  })

  it('loads assets and forwards setup token/password when starting a download', async () => {
    mocks.getOnboardingAssets.mockResolvedValue({
      configured: false,
      manifest: null,
      assets: {},
      dependencies: null,
      kernel: null,
      python: null,
      models: null,
      disk: null,
      health: null,
      error: 'release_manifest_not_configured',
    })
    mocks.startAssetDownload.mockResolvedValue(job())

    const assets = await onb.loadAssets()
    const started = await onb.startAssetDownload(
      'kernel',
      'setup-token-1',
      'pw-1',
    )

    expect(assets?.configured).toBe(false)
    expect(onb.assets.value?.error).toBe('release_manifest_not_configured')
    expect(started?.id).toBe('job-1')
    expect(onb.job.value?.id).toBe('job-1')
    expect(mocks.startAssetDownload).toHaveBeenCalledWith(
      'kernel',
      'setup-token-1',
      'pw-1',
    )
  })

  it('cancels the active job with forwarded credentials', async () => {
    onb.job.value = job() as never
    mocks.cancelOnboardingJob.mockResolvedValue(
      job({ state: 'cancelled', cancel_requested: true }),
    )

    const result = await onb.cancelJob('setup-token-2', 'pw-2')

    expect(result?.state).toBe('cancelled')
    expect(mocks.cancelOnboardingJob).toHaveBeenCalledWith(
      'job-1',
      'setup-token-2',
      'pw-2',
    )
  })

  it('does not call the API when cancelling without an active job', async () => {
    const result = await onb.cancelJob()

    expect(result).toBeNull()
    expect(mocks.cancelOnboardingJob).not.toHaveBeenCalled()
  })

  it('loads, validates and applies Loom with password only in the apply call', async () => {
    mocks.getLoomOnboarding.mockResolvedValue(LOOM_STATUS)
    mocks.validateLoomSelection.mockResolvedValue({
      ok: true,
      valid: true,
      managed: false,
      selection: { provider: 'new-api', model: 'deepseek' },
      main_model: null,
      validation_mode: 'structural',
      errors: [],
      warnings: [],
    })
    mocks.applyLoomSelection.mockResolvedValue({
      ok: true,
      managed: false,
      applied: false,
      manual_required: true,
      selection: { provider: 'new-api', model: 'deepseek' },
      validation_mode: 'structural',
      backup: null,
      rollback: null,
      restart: {
        ok: false,
        requested: false,
        performed: false,
        verified: false,
        manual_required: true,
        command: null,
        old_pid: null,
        new_pid: null,
        detail: '',
      },
      errors: [],
      warnings: [],
    })
    mocks.restartLoomOnboarding.mockResolvedValue({
      ok: true,
      requested: true,
      performed: true,
      verified: true,
      manual_required: false,
      command: null,
      old_pid: 1,
      new_pid: 2,
      detail: '重启完成',
    })

    await onb.loadLoom()
    await onb.validateLoom({ provider: 'new-api', model: 'deepseek' })
    await onb.applyLoom(
      { provider: 'new-api', model: 'deepseek' },
      { restart: false, currentPassword: 'pw-3' },
      'setup-token-3',
    )
    await onb.restartLoom('setup-token-3', 'pw-3')

    expect(onb.loom.value).toEqual(LOOM_STATUS)
    expect(onb.loomValidation.value?.valid).toBe(true)
    expect(onb.loomApplyResult.value?.manual_required).toBe(true)
    expect(mocks.validateLoomSelection).toHaveBeenCalledWith({
      provider: 'new-api',
      model: 'deepseek',
    })
    expect(mocks.applyLoomSelection).toHaveBeenCalledWith(
      { provider: 'new-api', model: 'deepseek' },
      { restart: false, currentPassword: 'pw-3' },
      'setup-token-3',
    )
    expect(mocks.restartLoomOnboarding).toHaveBeenCalledWith(
      'setup-token-3',
      'pw-3',
    )
  })

  it('loads Loom runtime and forwards token, config and runtime actions', async () => {
    const runtime = {
      ok: true,
      mode: 'systemd' as const,
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
        child: { node: true, cli_path: '/srv/cli.js', cli_present: true },
        reasons: [],
      },
      managed: true,
      config_path: '/srv/ai/.loom/config.yaml',
      config_exists: true,
      token_state: {
        found: true,
        source: 'env',
        fingerprint: 'f00dbabe',
        provisioned: false,
        token_file: null,
        persisted: false,
        detail: '环境变量',
        errors: [],
      },
      running: true,
      pid: 4321,
      pid_verified: true,
      adopted: false,
      reachable: true,
      health: {
        reachable: true,
        ok: true,
        http_status: 200,
        status: 'ok',
        version: '1.2.3',
        error: null,
      },
      port: 5100,
      detail: 'systemd active',
    }
    const token = {
      ...runtime.token_state,
      source: 'provisioned',
      provisioned: true,
      fingerprint: 'deadbeef',
      token_file: '/srv/secrets/loom.env',
      persisted: true,
    }
    const config = {
      ok: true,
      managed: true,
      path: '/srv/ai/.loom/config.yaml',
      exists: true,
      created: true,
      overwritten: false,
      backup: null,
      manual_required: false,
      validation: 'structural',
      credential_ref: '${LOOM_KEY}',
      errors: [],
    }
    const action = {
      ok: true,
      mode: 'systemd' as const,
      requested: 'start',
      performed: true,
      verified: true,
      manual_required: false,
      adopted: false,
      pid: 4321,
      old_pid: null,
      new_pid: 4321,
      command: null,
      detail: '启动完成',
      health: runtime.health,
      errors: [],
    }
    mocks.getLoomRuntime.mockResolvedValue(runtime)
    mocks.ensureLoomToken.mockResolvedValue(token)
    mocks.ensureLoomConfig.mockResolvedValue(config)
    mocks.startLoomRuntime.mockResolvedValue(action)
    mocks.stopLoomRuntime.mockResolvedValue({ ...action, requested: 'stop' })
    mocks.restartLoomRuntime.mockResolvedValue({
      ...action,
      requested: 'restart',
    })

    await onb.loadLoomRuntime()

    expect(onb.loomRuntime.value).toEqual(runtime)

    onb.loom.value = LOOM_STATUS
    const ensured = await onb.ensureLoomToken('setup-token-r', 'pw-r')
    expect(ensured).toEqual(token)
    expect(mocks.ensureLoomToken).toHaveBeenCalledWith('setup-token-r', 'pw-r')
    expect(onb.loomRuntime.value?.token_state).toEqual(token)
    expect(onb.loom.value?.fingerprint).toBe('deadbeef')

    await onb.ensureLoomConfig(
      { provider: 'new-api', model: 'deepseek' },
      { overwrite: true, currentPassword: 'pw-r' },
      'setup-token-r',
    )
    expect(mocks.ensureLoomConfig).toHaveBeenCalledWith(
      { provider: 'new-api', model: 'deepseek' },
      { overwrite: true, currentPassword: 'pw-r' },
      'setup-token-r',
    )
    expect(onb.loomRuntime.value?.config_exists).toBe(true)

    await onb.startLoomRuntime('setup-token-r', 'pw-r')
    await onb.stopLoomRuntime('setup-token-r', 'pw-r')
    await onb.restartLoomRuntime('setup-token-r', 'pw-r')

    expect(mocks.startLoomRuntime).toHaveBeenCalledWith(
      'setup-token-r',
      'pw-r',
    )
    expect(mocks.stopLoomRuntime).toHaveBeenCalledWith(
      'setup-token-r',
      'pw-r',
    )
    expect(mocks.restartLoomRuntime).toHaveBeenCalledWith(
      'setup-token-r',
      'pw-r',
    )
  })

  it('loads, validates and applies MOSS choices', async () => {
    mocks.getMossOnboarding.mockResolvedValue(MOSS_STATUS)
    mocks.validateMossConfig.mockResolvedValue(MOSS_VALIDATION)
    mocks.applyMossChoice.mockResolvedValue({
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
    })

    await onb.loadMoss()
    await onb.validateMoss('http://127.0.0.1:8100/v1', 'moss-audio-4b')
    await onb.applyMoss(
      'skipped',
      { baseUrl: 'http://127.0.0.1:8100/v1', currentPassword: 'pw-4' },
      'setup-token-4',
    )

    expect(onb.moss.value?.model).toBe('moss-audio-4b')
    expect(onb.mossValidation.value?.reachable).toBe(true)
    expect(onb.mossApplyResult.value?.status).toBe('skipped')
    expect(mocks.validateMossConfig).toHaveBeenCalledWith(
      'http://127.0.0.1:8100/v1',
      'moss-audio-4b',
    )
    expect(mocks.applyMossChoice).toHaveBeenCalledWith(
      'skipped',
      { baseUrl: 'http://127.0.0.1:8100/v1', currentPassword: 'pw-4' },
      'setup-token-4',
    )
  })

  it('loads the client catalog without a pc_sensor entry', async () => {
    mocks.getClientCatalog.mockResolvedValue(CLIENT_CATALOG)

    const catalog = await onb.loadClients()

    expect(catalog).toEqual(CLIENT_CATALOG)
    expect(onb.clients.value).toEqual(CLIENT_CATALOG)
    expect(Object.keys(catalog ?? {})).toEqual([
      'android',
      'desktop',
      'connection',
    ])
  })

  it('captures API failures into the shared error ref', async () => {
    mocks.getOnboardingAssets.mockRejectedValue(new Error('offline'))

    const result = await onb.loadAssets()

    expect(result).toBeNull()
    expect(onb.error.value?.code).toBe('unknown_error')
    expect(onb.assetsLoading.value).toBe(false)
  })

  it('loads and saves Xiaomi through the v4 config and QR actions', async () => {
    const status = {
      enabled: true,
      configured: false,
      phase: 'waiting_login',
      userid_masked: '',
      userid_configured: false,
      region: 'cn',
      last_error: '',
      needs_login: true,
    }
    const qr = {
      lp: 'lp-1',
      qr_base64: 'data:image/png;base64,AAAA',
      expires_in: 300,
      login_url: 'https://example.test/qr',
    }
    mocks.getXiaomiOnboarding.mockResolvedValue(status)
    mocks.configureXiaomi.mockResolvedValue({ ...status, enabled: false })
    mocks.requestXiaomiQr.mockResolvedValue(qr)
    mocks.pollXiaomiQr.mockResolvedValue({
      state: 'success',
      userid_masked: '138****0000',
      configured: true,
    })

    await onb.loadXiaomi()
    expect(onb.xiaomi.value?.needs_login).toBe(true)

    const saved = await onb.configureXiaomi(
      { enabled: false, current_password: 'pw-x' },
      'setup-token-x',
    )
    expect(saved?.enabled).toBe(false)
    expect(onb.xiaomi.value?.enabled).toBe(false)
    expect(mocks.configureXiaomi).toHaveBeenCalledWith(
      { enabled: false, current_password: 'pw-x' },
      'setup-token-x',
    )

    const started = await onb.requestXiaomiQr('setup-token-x', 'pw-x')
    const polled = await onb.pollXiaomiQr('lp-1', 'setup-token-x', 'pw-x')
    expect(started?.lp).toBe('lp-1')
    expect(polled?.state).toBe('success')
    expect(mocks.requestXiaomiQr).toHaveBeenCalledWith('setup-token-x', 'pw-x')
    expect(mocks.pollXiaomiQr).toHaveBeenCalledWith(
      'lp-1',
      'setup-token-x',
      'pw-x',
    )
  })

  it('loads, validates and saves QQ gateway settings', async () => {
    const status = {
      enabled: true,
      self_qq: '12345678',
      ws_url: 'ws://127.0.0.1:3001',
      ws_token_configured: true,
      mcp_token_configured: true,
      valid: true,
      errors: [],
    }
    const body = {
      enabled: true,
      self_qq: '12345678',
      ws_url: 'ws://127.0.0.1:3001',
      regenerate_mcp_token: true,
      current_password: 'pw-qq',
    }
    mocks.getQqOnboarding.mockResolvedValue(status)
    mocks.validateQqConfig.mockResolvedValue({ valid: true, errors: [] })
    mocks.configureQq.mockResolvedValue({
      ...status,
      starts_after_finish: true,
    })

    await onb.loadQq()
    const validation = await onb.validateQq(body, 'setup-token-qq')
    const saved = await onb.configureQq(body, 'setup-token-qq')

    expect(onb.qq.value?.self_qq).toBe('12345678')
    expect(validation?.valid).toBe(true)
    expect(saved?.starts_after_finish).toBe(true)
    expect(mocks.validateQqConfig).toHaveBeenCalledWith(
      body,
      'setup-token-qq',
    )
    expect(mocks.configureQq).toHaveBeenCalledWith(body, 'setup-token-qq')
  })

  it('loads and saves the compact MOSS config', async () => {
    const config = {
      enabled: true,
      base_url: 'http://127.0.0.1:8100/v1',
      model: 'moss-audio-4b',
    }
    mocks.getMossConfig.mockResolvedValue(config)
    mocks.configureMoss.mockResolvedValue({ ...config, enabled: false })

    await onb.loadMossConfig()
    const saved = await onb.configureMoss(
      {
        enabled: false,
        base_url: config.base_url,
        model: config.model,
        current_password: 'pw-moss',
      },
      'setup-token-moss',
    )

    expect(onb.mossConfig.value?.model).toBe('moss-audio-4b')
    expect(saved?.enabled).toBe(false)
    expect(onb.mossConfig.value?.enabled).toBe(false)
    expect(mocks.configureMoss).toHaveBeenCalledWith(
      {
        enabled: false,
        base_url: config.base_url,
        model: config.model,
        current_password: 'pw-moss',
      },
      'setup-token-moss',
    )
  })

  it('stores the Loom setup result and forwards the inline key', async () => {
    const result = {
      ok: true,
      stage: 'done',
      loom: {
        url: 'http://127.0.0.1:6000',
        port: 6000,
        mode: 'systemd',
        pid: 4321,
        health: null,
        catalog_models: ['deepseek'],
      },
      applied: {
        ai_backend: 'loom',
        config_path: '/srv/ai/.loom/config.yaml',
        api_key_configured: true,
      },
    }
    mocks.setupLoom.mockResolvedValue(result)
    const body = {
      port: 6000,
      provider: 'new-api',
      base_url: 'https://api.example.test/v1',
      model: 'deepseek',
      api_key: 'sk-secret',
      current_password: 'pw-loom',
    }

    const saved = await onb.setupLoom(body, 'setup-token-loom')

    expect(saved).toEqual(result)
    expect(onb.loomSetupResult.value?.applied.ai_backend).toBe('loom')
    expect(mocks.setupLoom).toHaveBeenCalledWith(body, 'setup-token-loom')
  })

  it('loads the finish snapshot into finish/groups/closing', async () => {
    const groups = {
      blocking: [
        { layer: 'preflight', id: 'ports', title: '端口', message: '被占用' },
      ],
      soft: [],
    }
    const closing = {
      title: '初始化完成',
      message: '可以开始使用了。',
      enabled: [{ id: 'clients', label: '客户端' }],
      skipped: [],
      degraded: [],
      enter_label: '进入主界面',
    }
    const status = {
      runtime: {
        available: true,
        active: true,
        started: true,
        state: 'deferred',
        committed: false,
        gate_open: true,
      },
      startup: {
        ok: null,
        state: 'deferred',
        mode: 'validation',
        subsystems: {},
        checks: [],
        errors: [],
        warnings: [],
        deferred: [],
        generated_at: null,
      },
      lifecycle: null,
      groups,
      activation: null,
      closing,
      finish: { groups, activation: null },
    }
    mocks.getOnboardingFinish.mockResolvedValue(status)

    const loaded = await onb.loadFinish()

    expect(loaded?.runtime.state).toBe('deferred')
    expect(onb.finish.value?.groups).toEqual(groups)
    expect(onb.finishGroups.value).toEqual(groups)
    expect(onb.finishClosing.value).toEqual(closing)
    expect(onb.finishError.value).toBeNull()
  })

  it('runs finish and keeps the returned groups/closing', async () => {
    const groups = {
      blocking: [],
      soft: [
        {
          layer: 'moss',
          id: 'moss_unreachable',
          title: 'MOSS',
          message: '无法连接',
        },
      ],
    }
    const closing = {
      title: '初始化完成',
      message: '已完成。',
      enabled: [{ id: 'clients', label: '客户端' }],
      skipped: [],
      degraded: [{ id: 'moss_unreachable', message: '无法连接' }],
      enter_label: '进入主界面',
    }
    mocks.finishOnboarding.mockResolvedValue({
      ok: true,
      state: {
        version: 4,
        completed_steps: ['finish'],
        skipped_steps: [],
        current_step: 'finish',
        completed: true,
        started_at: null,
        updated_at: null,
      },
      activation: null,
      groups,
      closing,
      idempotent: true,
    })

    const result = await onb.runFinish(true, 'pw-finish', 'setup-token-finish')

    expect(result?.ok).toBe(true)
    expect(onb.finishGroups.value).toEqual(groups)
    expect(onb.finishClosing.value).toEqual(closing)
    expect(onb.finishError.value).toBeNull()
    expect(mocks.finishOnboarding).toHaveBeenCalledWith(
      true,
      'pw-finish',
      'setup-token-finish',
    )
  })

  it('preserves the finish SystemApiError and extracts groups/closing', async () => {
    const groups = {
      blocking: [
        {
          layer: 'preflight',
          id: 'ports',
          title: '端口占用',
          message: '端口 8768 被占用',
          fix: '释放端口',
        },
      ],
      soft: [],
    }
    const closing = {
      title: '初始化完成',
      message: '已完成。',
      enabled: [{ id: 'clients', label: '客户端' }],
      skipped: [],
      degraded: [],
      enter_label: '进入主界面',
    }
    const error = new SystemApiError(
      409,
      'finish_blocked',
      '集成配置存在阻塞项，处理后重试',
      [],
      { groups, closing },
    )
    mocks.finishOnboarding.mockRejectedValue(error)

    const result = await onb.runFinish(false, 'pw-finish')

    expect(result).toBeNull()
    expect(onb.finishError.value).toBe(error)
    expect(onb.finishError.value?.status).toBe(409)
    expect(onb.finishError.value?.code).toBe('finish_blocked')
    expect(onb.finishGroups.value).toEqual(groups)
    expect(onb.finishClosing.value).toEqual(closing)
  })

  it('maps a non-API finish failure to unknown_error without clearing diagnostics', async () => {
    mocks.finishOnboarding.mockRejectedValue(new Error('offline'))

    const result = await onb.runFinish(false)

    expect(result).toBeNull()
    expect(onb.finishError.value?.code).toBe('unknown_error')
    expect(onb.finishGroups.value).toBeNull()
    expect(onb.finishClosing.value).toBeNull()
  })
})
