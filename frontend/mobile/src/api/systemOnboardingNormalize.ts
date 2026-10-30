/**
 * 引导业务响应边界归一化 (T12)
 *
 * 把 /onboarding/assets、/jobs、/loom、/moss、/clients 的 JSON 解析为
 * systemTypes.ts 的类型; 不满足最小契约时返回 null, 由 system.ts 转成
 * SystemApiError('invalid_response')。
 */

import {
  asBoolean,
  asFiniteNumber,
  asString,
  asStringArray,
  asStringRecord,
  isRecord,
  normalizeOnboardingState,
} from './systemNormalize'
import type {
  ClientAction,
  ClientCatalog,
  ClientConnectionInfo,
  ClientEntry,
  ClientSource,
  DependenciesStatus,
  DownloadJob,
  DownloadJobState,
  FinishClosing,
  FinishClosingDegraded,
  FinishClosingEntry,
  FinishGroupItem,
  FinishGroups,
  FinishResult,
  FinishStatus,
  KernelDiskStatus,
  KernelHealthStatus,
  KernelInstallStatus,
  KernelModelAssetStatus,
  KernelModelCatalog,
  KernelModelTierStatus,
  KernelModelsStatus,
  KernelPythonStatus,
  LegacyModelCaches,
  LoomApiError,
  LoomApplyResult,
  LoomApplyRollback,
  LoomChannel,
  LoomConfigEnsureResult,
  LoomConfigView,
  LoomCredentialRef,
  LoomHealthInfo,
  LoomModelInfo,
  LoomRestartResult,
  LoomRuntimeActionResult,
  LoomRuntimeChildInfo,
  LoomRuntimeHealth,
  LoomRuntimeMode,
  LoomRuntimeModeDetail,
  LoomRuntimeStatus,
  LoomRuntimeSystemdInfo,
  LoomSelection,
  LoomSetupResult,
  LoomStatus,
  LoomTokenState,
  LoomValidateResult,
  MossApplyResult,
  MossConfig,
  MossHelperState,
  MossStatus,
  MossUnits,
  MossValidation,
  OnboardingDependencies,
  QqConfigError,
  QqConfigResult,
  QqStatus,
  QqValidateResult,
  ReleaseAssetInfo,
  ReleaseManifest,
  StartupCheck,
  StartupError,
  StartupLifecycle,
  StartupReport,
  StartupRuntimeStatus,
  StartupStatus,
  StartupWarning,
  StorageRootSource,
  StorageSnapshot,
  StorageSaveResult,
  XiaomiQrPollResult,
  XiaomiQrResult,
  XiaomiStatus,
} from './systemTypes'

// ==================== 引导: 启动校验 ====================

function normalizeStartupCheck(value: unknown): StartupCheck | null {
  if (!isRecord(value)) return null
  const id = asString(value.id)
  if (!id) return null
  return {
    id,
    status: asString(value.status, 'skipped'),
    kind: asString(value.kind, 'required'),
    required: asBoolean(value.required, asString(value.kind) === 'required'),
    detail: asString(value.detail),
  }
}

function normalizeStartupChecks(value: unknown): StartupCheck[] {
  if (!Array.isArray(value)) return []
  return value
    .map(normalizeStartupCheck)
    .filter((item): item is StartupCheck => item !== null)
}

function normalizeStartupErrors(value: unknown): StartupError[] {
  if (!Array.isArray(value)) return []
  const errors: StartupError[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const error = asString(item.error)
    if (!error) continue
    errors.push({ subsystem: asString(item.subsystem), error })
  }
  return errors
}

function normalizeStartupWarnings(value: unknown): StartupWarning[] {
  if (!Array.isArray(value)) return []
  const warnings: StartupWarning[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const warning = asString(item.warning)
    if (!warning) continue
    warnings.push({ subsystem: asString(item.subsystem), warning })
  }
  return warnings
}

function normalizeNullableBoolean(value: unknown): boolean | null {
  if (value === true) return true
  if (value === false) return false
  return null
}

export function normalizeStartupReport(value: unknown): StartupReport | null {
  if (!isRecord(value)) return null
  return {
    ok: normalizeNullableBoolean(value.ok),
    state: asString(value.state, 'deferred'),
    mode: asString(value.mode),
    subsystems: asStringRecord(value.subsystems),
    checks: normalizeStartupChecks(value.checks),
    errors: normalizeStartupErrors(value.errors),
    warnings: normalizeStartupWarnings(value.warnings),
    deferred: asStringArray(value.deferred),
    generated_at: asNullableString(value.generated_at),
  }
}

export function normalizeStartupRuntime(
  value: unknown,
): StartupRuntimeStatus {
  const record = isRecord(value) ? value : {}
  return {
    available: asBoolean(record.available),
    active: asBoolean(record.active),
    started: asBoolean(record.started),
    state: asString(record.state),
    committed: asBoolean(record.committed),
    gate_open: asBoolean(record.gate_open),
  }
}

export function normalizeStartupLifecycle(
  value: unknown,
): StartupLifecycle | null {
  if (!isRecord(value)) return null
  return {
    activated: asBoolean(value.activated),
    active: asBoolean(value.active),
    reason: asString(value.reason),
    requested_reason: asString(value.requested_reason),
    subsystems: asStringRecord(value.subsystems),
    errors: normalizeStartupErrors(value.errors),
    idempotent: asBoolean(value.idempotent),
    ok: normalizeNullableBoolean(value.ok),
    state: asString(value.state),
    gate_open: asBoolean(value.gate_open),
    committed: asBoolean(value.committed),
    validated: asBoolean(value.validated),
    promoted: asBoolean(value.promoted),
    started: asBoolean(value.started),
    status: asString(value.status),
  }
}

export function normalizeStartupStatus(value: unknown): StartupStatus | null {
  if (!isRecord(value)) return null
  const nested =
    isRecord(value.startup) && Object.keys(value.startup).length > 0
      ? value.startup
      : null
  const reportSource =
    nested ??
    (isRecord(value.report)
      ? value.report
      : 'checks' in value || 'subsystems' in value || 'state' in value
        ? value
        : null)
  const report = normalizeStartupReport(reportSource)
  if (!report) return null
  return {
    report,
    runtime: normalizeStartupRuntime(value.runtime),
    lifecycle: normalizeStartupLifecycle(value.lifecycle),
  }
}

// ==================== 引导: 发行资产与下载作业 ====================

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function normalizeReleaseAsset(value: unknown): ReleaseAssetInfo | null {
  if (!isRecord(value)) return null
  const name = asString(value.name)
  const file = asString(value.file)
  if (!name || !file) return null
  return {
    name,
    file,
    sha256: asString(value.sha256),
    size: asFiniteNumber(value.size) ?? null,
    url: asString(value.url),
    api_version: asString(value.api_version),
    tiers: asStringArray(value.tiers),
  }
}

function normalizeAssetMap(value: unknown): Record<string, ReleaseAssetInfo> {
  if (!isRecord(value)) return {}
  const assets: Record<string, ReleaseAssetInfo> = {}
  for (const [key, item] of Object.entries(value)) {
    const asset = normalizeReleaseAsset(item)
    if (asset) assets[key] = asset
  }
  return assets
}

function normalizeReleaseManifest(value: unknown): ReleaseManifest | null {
  if (!isRecord(value)) return null
  const assets = normalizeAssetMap(value.assets)
  const version = asString(value.version)
  if (!version && Object.keys(assets).length === 0) return null
  return {
    schema: asFiniteNumber(value.schema) ?? 0,
    product: asString(value.product),
    version,
    assets,
  }
}

function normalizeKernelInstall(value: unknown): KernelInstallStatus {
  const record = isRecord(value) ? value : {}
  const source =
    record.source === 'release' ||
    record.source === 'source' ||
    record.source === 'unknown'
      ? record.source
      : null
  return {
    dir: asString(record.dir),
    present: asBoolean(record.present),
    source,
    version: asNullableString(record.version),
    marker: asString(record.marker),
    installed_from_release: asBoolean(record.installed_from_release),
    installable: asBoolean(record.installable),
    install_blocked_reason: asNullableString(record.install_blocked_reason),
  }
}

function normalizeKernelPython(value: unknown): KernelPythonStatus {
  const record = isRecord(value) ? value : {}
  return {
    path: asString(record.path),
    source: asString(record.source),
    exists: asBoolean(record.exists),
    configured: asString(record.configured),
    configured_exists: asBoolean(record.configured_exists),
    last_resort: asBoolean(record.last_resort),
  }
}

function normalizeKernelModels(value: unknown): KernelModelsStatus {
  const record = isRecord(value) ? value : {}
  return {
    model_dir: asString(record.model_dir),
    configured: asBoolean(record.configured),
    exists: asBoolean(record.exists),
  }
}

function normalizeKernelDisk(value: unknown): KernelDiskStatus {
  const record = isRecord(value) ? value : {}
  return {
    path: asString(record.path),
    free: asFiniteNumber(record.free) ?? 0,
    required: asFiniteNumber(record.required) ?? 0,
    sufficient: asBoolean(record.sufficient),
  }
}

function normalizeKernelHealth(value: unknown): KernelHealthStatus {
  const record = isRecord(value) ? value : {}
  return {
    pidfile: asString(record.pidfile),
    found: asBoolean(record.found),
    pid: asFiniteNumber(record.pid) ?? null,
    port: asFiniteNumber(record.port) ?? null,
    alive: asBoolean(record.alive),
    healthy: asBoolean(record.healthy),
    api_version: asNullableString(record.api_version),
    base_url: asNullableString(record.base_url),
    error: asNullableString(record.error),
  }
}

function normalizeDependencies(value: unknown): OnboardingDependencies | null {
  if (!isRecord(value)) return null
  return {
    kernel: normalizeKernelInstall(value.kernel),
    python: normalizeKernelPython(value.python),
    models: normalizeKernelModels(value.models),
    disk: normalizeKernelDisk(value.disk),
    health: normalizeKernelHealth(value.health),
  }
}

export function normalizeDependenciesStatus(
  value: unknown,
): DependenciesStatus | null {
  if (!isRecord(value)) return null
  const configured = asBoolean(value.configured)
  const assets = normalizeAssetMap(value.assets)
  const manifest =
    normalizeReleaseManifest(value.manifest) ??
    (configured
      ? normalizeReleaseManifest({
          schema: value.schema,
          product: value.product,
          version: value.version,
          assets,
        })
      : null)
  const dependencies = normalizeDependencies(value.dependencies)
  return {
    configured,
    manifest,
    assets: Object.keys(assets).length > 0 ? assets : manifest?.assets ?? {},
    dependencies,
    kernel: dependencies?.kernel ?? null,
    python: dependencies?.python ?? null,
    models: dependencies?.models ?? null,
    disk: dependencies?.disk ?? null,
    health: dependencies?.health ?? null,
    error: asNullableString(value.error),
  }
}

function normalizeJobState(value: unknown): DownloadJobState | null {
  return value === 'queued' ||
    value === 'running' ||
    value === 'done' ||
    value === 'failed' ||
    value === 'cancelled'
    ? value
    : null
}

export function normalizeDownloadJob(value: unknown): DownloadJob | null {
  if (!isRecord(value)) return null
  const id = asString(value.id)
  const state = normalizeJobState(value.state)
  if (!id || !state) return null
  const progress = isRecord(value.progress) ? value.progress : {}
  return {
    id,
    kind: asString(value.kind),
    state,
    asset: asNullableString(value.asset),
    progress: {
      bytes: asFiniteNumber(progress.bytes) ?? 0,
      total: asFiniteNumber(progress.total) ?? null,
      pct: asFiniteNumber(progress.pct) ?? 0,
    },
    current: asString(value.current),
    logs_tail: asStringArray(value.logs_tail),
    result: value.result ?? null,
    error: asNullableString(value.error),
    cancel_requested: asBoolean(value.cancel_requested),
    created_at: asString(value.created_at),
    updated_at: asString(value.updated_at),
  }
}

function normalizeKernelModelAsset(value: unknown): KernelModelAssetStatus | null {
  if (!isRecord(value)) return null
  const id = asString(value.id)
  if (!id) return null
  return {
    id,
    tier: asString(value.tier),
    source: asString(value.source),
    repo: asString(value.repo),
    target: asString(value.target),
    kind: asString(value.kind),
    size_bytes: asFiniteNumber(value.size_bytes) ?? 0,
    gated: asBoolean(value.gated),
    present: asBoolean(value.present),
    missing_files: asStringArray(value.missing_files),
    error: asNullableString(value.error),
  }
}

function normalizeKernelModelTier(value: unknown): KernelModelTierStatus | null {
  if (!isRecord(value)) return null
  const id = asString(value.id)
  if (!id) return null
  return {
    id,
    model_ids: asStringArray(value.model_ids),
    total_size_bytes: asFiniteNumber(value.total_size_bytes) ?? 0,
    missing_size_bytes: asFiniteNumber(value.missing_size_bytes) ?? 0,
  }
}

export function normalizeKernelModelCatalog(
  value: unknown,
): KernelModelCatalog | null {
  if (!isRecord(value)) return null
  if (!Array.isArray(value.models) || !Array.isArray(value.tiers)) return null
  const models = value.models
    .map(normalizeKernelModelAsset)
    .filter((item): item is KernelModelAssetStatus => item !== null)
  const tiers = value.tiers
    .map(normalizeKernelModelTier)
    .filter((item): item is KernelModelTierStatus => item !== null)
  if (models.length === 0) return null
  return {
    manifest_version: asString(value.manifest_version),
    models,
    tiers,
    total_size_bytes: asFiniteNumber(value.total_size_bytes) ?? 0,
    required_size_bytes: asFiniteNumber(value.required_size_bytes) ?? 0,
  }
}

// ==================== 引导: 存储位置 ====================

function normalizeStorageRootSource(value: unknown): StorageRootSource {
  if (value === 'env' || value === 'config' || value === 'default') {
    return value
  }
  return 'default'
}

function normalizeLegacyModelCaches(value: unknown): LegacyModelCaches {
  const record = isRecord(value) ? value : {}
  const paths: Record<string, string> = {}
  if (isRecord(record.paths)) {
    for (const [key, item] of Object.entries(record.paths)) {
      if (typeof item === 'string') paths[key] = item
    }
  }
  return {
    exists: asBoolean(record.exists),
    home: asString(record.home),
    suggested_root: asNullableString(record.suggested_root),
    modelscope: asBoolean(record.modelscope),
    huggingface: asBoolean(record.huggingface),
    axeuh_kernel: asBoolean(record.axeuh_kernel),
    paths,
  }
}

export function normalizeStorageSnapshot(
  value: unknown,
): StorageSnapshot | null {
  if (!isRecord(value)) return null
  const dataRoot = asString(value.data_root)
  const modelsRoot = asString(value.models_root)
  if (!dataRoot || !modelsRoot) return null
  const source = isRecord(value.source) ? value.source : {}
  return {
    data_root: dataRoot,
    models_root: modelsRoot,
    free_bytes: asFiniteNumber(value.free_bytes) ?? 0,
    writable: asBoolean(value.writable),
    source: {
      data_root: normalizeStorageRootSource(source.data_root),
      models_root: normalizeStorageRootSource(source.models_root),
    },
    models_dir_configured: asBoolean(value.models_dir_configured),
    data_root_configured: asBoolean(value.data_root_configured),
    legacy: normalizeLegacyModelCaches(value.legacy),
    system_disk: asBoolean(value.system_disk),
    system_drive: asNullableString(value.system_drive),
    warnings: asStringArray(value.warnings),
  }
}

export function normalizeStorageSaveResult(
  value: unknown,
): StorageSaveResult | null {
  return normalizeStorageSnapshot(value)
}

// ==================== 引导: Loom ====================

function normalizeLoomApiErrors(value: unknown): LoomApiError[] {
  if (!Array.isArray(value)) return []
  const errors: LoomApiError[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    errors.push({
      code: asString(item.code),
      message: asString(item.message),
    })
  }
  return errors
}

function normalizeLoomHealth(value: unknown): LoomHealthInfo | null {
  if (!isRecord(value)) return null
  return {
    status: asNullableString(value.status),
    version: asNullableString(value.version),
    uptime_ms: asFiniteNumber(value.uptime_ms) ?? null,
    started_at: asNullableString(value.started_at),
  }
}

function normalizeLoomModel(value: unknown): LoomModelInfo | null {
  if (!isRecord(value)) return null
  const id = asString(value.id)
  const provider = asString(value.provider)
  if (!id || !provider) return null
  const model: LoomModelInfo = {
    id,
    provider,
    contextWindow: asFiniteNumber(value.contextWindow) ?? null,
    maxOutput: asFiniteNumber(value.maxOutput) ?? null,
    vision: asBoolean(value.vision),
    timeout: asFiniteNumber(value.timeout) ?? null,
  }
  if (typeof value.reasoningEffort === 'string') {
    model.reasoningEffort = value.reasoningEffort
  }
  return model
}

function normalizeLoomModels(value: unknown): LoomModelInfo[] {
  if (!Array.isArray(value)) return []
  return value
    .map(normalizeLoomModel)
    .filter((item): item is LoomModelInfo => item !== null)
}

function normalizeLoomChannel(value: unknown): LoomChannel | null {
  if (!isRecord(value)) return null
  const provider = asString(value.provider)
  if (!provider) return null
  return {
    provider,
    model_count: asFiniteNumber(value.model_count) ?? 0,
    models: asStringArray(value.models),
    credential_ref: asNullableString(value.credential_ref),
  }
}

function normalizeLoomChannels(value: unknown): LoomChannel[] {
  if (!Array.isArray(value)) return []
  return value
    .map(normalizeLoomChannel)
    .filter((item): item is LoomChannel => item !== null)
}

function normalizeLoomCredentials(value: unknown): LoomCredentialRef[] {
  if (!Array.isArray(value)) return []
  const refs: LoomCredentialRef[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const name = asString(item.name)
    if (!name) continue
    refs.push({ name, env_ref: asString(item.env_ref) })
  }
  return refs
}

function normalizeLoomConfigView(value: unknown): LoomConfigView | null {
  if (!isRecord(value)) return null
  return {
    workspace: asNullableString(value.workspace),
    model_ids: asStringArray(value.model_ids),
    pricing_providers: asStringArray(value.pricing_providers),
    effective_version_sha256: asNullableString(value.effective_version_sha256),
  }
}

export function normalizeLoomStatus(value: unknown): LoomStatus | null {
  if (!isRecord(value) || typeof value.found !== 'boolean') return null
  const channels = normalizeLoomChannels(value.channels)
  const managedConfig = isRecord(value.managed_config)
    ? value.managed_config
    : {}
  return {
    found: value.found,
    source: asString(value.source),
    fingerprint: asString(value.fingerprint),
    detail: asString(value.detail),
    url: asString(value.url),
    managed: asBoolean(value.managed),
    reachable: asBoolean(value.reachable),
    online: asBoolean(value.online),
    health: normalizeLoomHealth(value.health),
    main_model: normalizeLoomModel(value.main_model),
    models: normalizeLoomModels(value.models),
    channels,
    providers: Array.isArray(value.providers)
      ? normalizeLoomChannels(value.providers)
      : channels,
    credentials: normalizeLoomCredentials(value.credentials),
    config: normalizeLoomConfigView(value.config),
    managed_config: {
      path: asString(managedConfig.path),
      exists: asBoolean(managedConfig.exists),
    },
    errors: normalizeLoomApiErrors(value.errors),
  }
}

export function normalizeLoomSelection(value: unknown): LoomSelection | null {
  if (!isRecord(value)) return null
  const provider = asString(value.provider)
  const model = asString(value.model)
  if (!provider || !model) return null
  const selection: LoomSelection = { provider, model }
  if (typeof value.base_url === 'string') selection.base_url = value.base_url
  const contextWindow = asFiniteNumber(value.context_window)
  if (contextWindow !== undefined) selection.context_window = contextWindow
  const maxOutput = asFiniteNumber(value.max_output)
  if (maxOutput !== undefined) selection.max_output = maxOutput
  if (typeof value.vision === 'boolean') selection.vision = value.vision
  const timeout = asFiniteNumber(value.timeout)
  if (timeout !== undefined) selection.timeout = timeout
  if (isRecord(value.pricing)) {
    selection.pricing = {
      input: asFiniteNumber(value.pricing.input) ?? 0,
      output: asFiniteNumber(value.pricing.output) ?? 0,
      cacheRead: asFiniteNumber(value.pricing.cacheRead) ?? 0,
      cacheWrite: asFiniteNumber(value.pricing.cacheWrite) ?? 0,
    }
  }
  return selection
}

export function normalizeLoomValidateResult(
  value: unknown,
): LoomValidateResult | null {
  if (!isRecord(value) || typeof value.valid !== 'boolean') return null
  const selection = normalizeLoomSelection(value.selection)
  if (!selection) return null
  return {
    ok: asBoolean(value.ok),
    valid: value.valid,
    managed: asBoolean(value.managed),
    selection,
    main_model: normalizeLoomModel(value.main_model),
    validation_mode: asString(value.validation_mode, 'structural'),
    errors: normalizeLoomApiErrors(value.errors),
    warnings: normalizeLoomApiErrors(value.warnings),
  }
}

export function normalizeLoomRestartResult(
  value: unknown,
): LoomRestartResult | null {
  if (!isRecord(value) || typeof value.performed !== 'boolean') return null
  const result: LoomRestartResult = {
    ok: asBoolean(value.ok),
    requested: asBoolean(value.requested, true),
    performed: value.performed,
    verified: asBoolean(value.verified),
    manual_required: asBoolean(value.manual_required),
    command: asNullableString(value.command),
    old_pid: asFiniteNumber(value.old_pid) ?? null,
    new_pid: asFiniteNumber(value.new_pid) ?? null,
    detail: asString(value.detail),
  }
  if (typeof value.loom_down === 'boolean') result.loom_down = value.loom_down
  if (typeof value.reason === 'string') result.reason = value.reason
  return result
}

function normalizeLoomRollback(value: unknown): LoomApplyRollback | null {
  if (!isRecord(value)) return null
  const rollback: LoomApplyRollback = {
    attempted: asBoolean(value.attempted, true),
    restored: asBoolean(value.restored),
  }
  if (typeof value.reason === 'string') rollback.reason = value.reason
  if (typeof value.detail === 'string') rollback.detail = value.detail
  const restart = normalizeLoomRestartResult(value.restart)
  if (restart) rollback.restart = restart
  if (typeof value.loom_down === 'boolean') rollback.loom_down = value.loom_down
  return rollback
}

export function normalizeLoomApplyResult(
  value: unknown,
): LoomApplyResult | null {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return null
  const selection = normalizeLoomSelection(value.selection)
  if (!selection) return null
  return {
    ok: value.ok,
    managed: asBoolean(value.managed),
    applied: asBoolean(value.applied),
    manual_required: asBoolean(value.manual_required),
    selection,
    validation_mode: asString(value.validation_mode, 'structural'),
    backup: asNullableString(value.backup),
    rollback: normalizeLoomRollback(value.rollback),
    restart: normalizeLoomRestartResult(value.restart) ?? {
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
    errors: normalizeLoomApiErrors(value.errors),
    warnings: normalizeLoomApiErrors(value.warnings),
  }
}

// ==================== 引导: Loom 运行时 ====================

function normalizeLoomRuntimeMode(value: unknown): LoomRuntimeMode | null {
  return value === 'systemd' || value === 'child' || value === 'none'
    ? value
    : null
}

export function normalizeLoomTokenState(value: unknown): LoomTokenState | null {
  if (!isRecord(value) || typeof value.found !== 'boolean') return null
  return {
    found: value.found,
    source: asString(value.source),
    fingerprint: asString(value.fingerprint),
    provisioned: asBoolean(value.provisioned),
    token_file: asNullableString(value.token_file),
    persisted: asBoolean(value.persisted),
    detail: asString(value.detail),
    errors: normalizeLoomApiErrors(value.errors),
  }
}

function normalizeLoomRuntimeSystemd(value: unknown): LoomRuntimeSystemdInfo {
  const record = isRecord(value) ? value : {}
  return {
    systemctl: asBoolean(record.systemctl),
    unit: asString(record.unit),
    present: asBoolean(record.present),
    owned: asBoolean(record.owned),
    load_state: asNullableString(record.load_state),
    active_state: asNullableString(record.active_state),
    sub_state: asNullableString(record.sub_state),
    pid: asFiniteNumber(record.pid) ?? null,
  }
}

function normalizeLoomRuntimeChild(value: unknown): LoomRuntimeChildInfo {
  const record = isRecord(value) ? value : {}
  return {
    node: asBoolean(record.node),
    cli_path: asString(record.cli_path),
    cli_present: asBoolean(record.cli_present),
  }
}

function normalizeLoomRuntimeModeDetail(value: unknown): LoomRuntimeModeDetail {
  const record = isRecord(value) ? value : {}
  return {
    systemd: normalizeLoomRuntimeSystemd(record.systemd),
    child: normalizeLoomRuntimeChild(record.child),
    reasons: asStringArray(record.reasons),
  }
}

export function normalizeLoomRuntimeHealth(
  value: unknown,
): LoomRuntimeHealth | null {
  if (!isRecord(value)) return null
  return {
    reachable: asBoolean(value.reachable),
    ok: asBoolean(value.ok),
    http_status: asFiniteNumber(value.http_status) ?? null,
    status: asNullableString(value.status),
    version: asNullableString(value.version),
    error: asNullableString(value.error),
  }
}

export function normalizeLoomRuntimeStatus(
  value: unknown,
): LoomRuntimeStatus | null {
  if (!isRecord(value)) return null
  const mode = normalizeLoomRuntimeMode(value.mode)
  if (!mode) return null
  return {
    ok: asBoolean(value.ok),
    mode,
    mode_detail: normalizeLoomRuntimeModeDetail(value.mode_detail),
    managed: asBoolean(value.managed),
    config_path: asString(value.config_path),
    config_exists: asBoolean(value.config_exists),
    token_state: normalizeLoomTokenState(value.token_state),
    running: asBoolean(value.running),
    pid: asFiniteNumber(value.pid) ?? null,
    pid_verified: asBoolean(value.pid_verified),
    adopted: asBoolean(value.adopted),
    reachable: asBoolean(value.reachable),
    health: normalizeLoomRuntimeHealth(value.health),
    port: asFiniteNumber(value.port) ?? null,
    detail: asString(value.detail),
  }
}

export function normalizeLoomConfigEnsureResult(
  value: unknown,
): LoomConfigEnsureResult | null {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return null
  const result: LoomConfigEnsureResult = {
    ok: value.ok,
    managed: asBoolean(value.managed),
    path: asString(value.path),
    exists: asBoolean(value.exists),
    created: asBoolean(value.created),
    overwritten: asBoolean(value.overwritten),
    backup: asNullableString(value.backup),
    manual_required: asBoolean(value.manual_required),
    validation: asString(value.validation, 'skipped'),
    credential_ref: asNullableString(value.credential_ref),
    errors: normalizeLoomApiErrors(value.errors),
  }
  if (typeof value.detail === 'string') result.detail = value.detail
  if (typeof value.overwrite_required === 'boolean') {
    result.overwrite_required = value.overwrite_required
  }
  return result
}

export function normalizeLoomRuntimeActionResult(
  value: unknown,
): LoomRuntimeActionResult | null {
  if (!isRecord(value) || typeof value.performed !== 'boolean') return null
  const mode = normalizeLoomRuntimeMode(value.mode)
  if (!mode) return null
  const result: LoomRuntimeActionResult = {
    ok: asBoolean(value.ok),
    mode,
    requested: asString(value.requested),
    performed: value.performed,
    verified: asBoolean(value.verified),
    manual_required: asBoolean(value.manual_required),
    adopted: asBoolean(value.adopted),
    pid: asFiniteNumber(value.pid) ?? null,
    old_pid: asFiniteNumber(value.old_pid) ?? null,
    new_pid: asFiniteNumber(value.new_pid) ?? null,
    command: asNullableString(value.command),
    detail: asString(value.detail),
    health: normalizeLoomRuntimeHealth(value.health),
    errors: normalizeLoomApiErrors(value.errors),
  }
  const tokenState = normalizeLoomTokenState(value.token_state)
  if (tokenState) result.token_state = tokenState
  if (typeof value.config_path === 'string') result.config_path = value.config_path
  if (typeof value.log_path === 'string') result.log_path = value.log_path
  return result
}

// ==================== 引导: MOSS ====================

function normalizeMossUnits(value: unknown): MossUnits {
  const record = isRecord(value) ? value : {}
  return {
    enable: asStringArray(record.enable),
    disable: asStringArray(record.disable),
  }
}

function normalizeMossCommands(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {}
  const commands: Record<string, string[]> = {}
  for (const [key, item] of Object.entries(value)) {
    commands[key] = asStringArray(item)
  }
  return commands
}

export function normalizeMossStatus(value: unknown): MossStatus | null {
  if (!isRecord(value) || typeof value.base_url !== 'string') return null
  const choice =
    value.choice === 'enabled' ||
    value.choice === 'disabled' ||
    value.choice === 'skipped'
      ? value.choice
      : null
  return {
    base_url: value.base_url,
    model: asString(value.model),
    manage_units: asBoolean(value.manage_units),
    helper_configured: asBoolean(value.helper_configured),
    helper_reason: asString(value.helper_reason),
    managed_available: asBoolean(value.managed_available),
    choice,
    last_choice: isRecord(value.last_choice) ? value.last_choice : null,
    units: normalizeMossUnits(value.units),
    commands: normalizeMossCommands(value.commands),
    warnings: asStringArray(value.warnings),
  }
}

export function normalizeMossValidation(value: unknown): MossValidation | null {
  if (!isRecord(value) || typeof value.reachable !== 'boolean') return null
  return {
    base_url: asNullableString(value.base_url),
    model: asString(value.model),
    reachable: value.reachable,
    model_found: asBoolean(value.model_found),
    models: asStringArray(value.models),
    matched_model: asNullableString(value.matched_model),
    latency_ms: asFiniteNumber(value.latency_ms) ?? 0,
    loopback: asBoolean(value.loopback),
    warnings: asStringArray(value.warnings),
    warning: asNullableString(value.warning),
    error: isRecord(value.error)
      ? {
          code: asString(value.error.code),
          message: asString(value.error.message),
        }
      : null,
  }
}

function normalizeMossHelper(value: unknown): MossHelperState {
  const record = isRecord(value) ? value : {}
  const helper: MossHelperState = {
    configured: asBoolean(record.configured),
    reason: asString(record.reason),
    invoked: asBoolean(record.invoked),
    returncode: asFiniteNumber(record.returncode) ?? null,
  }
  if (typeof record.ok === 'boolean') helper.ok = record.ok
  if (typeof record.error === 'string') helper.error = record.error
  return helper
}

export function normalizeMossApplyResult(
  value: unknown,
): MossApplyResult | null {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return null
  if (
    value.choice !== 'enabled' &&
    value.choice !== 'disabled' &&
    value.choice !== 'skipped'
  ) {
    return null
  }
  return {
    choice: value.choice,
    ok: value.ok,
    status: asString(value.status),
    enabled: asBoolean(value.enabled),
    disabled: asBoolean(value.disabled),
    manual_required: asBoolean(value.manual_required),
    managed: asBoolean(value.managed),
    verified: asBoolean(value.verified),
    service_reachable: asBoolean(value.service_reachable),
    verification_pending: asBoolean(value.verification_pending),
    base_url: asNullableString(value.base_url),
    model: asString(value.model),
    commands: asStringArray(value.commands),
    manual_commands: asStringArray(value.manual_commands),
    units: normalizeMossUnits(value.units),
    helper: normalizeMossHelper(value.helper),
    validation: normalizeMossValidation(value.validation),
    verification: normalizeMossValidation(value.verification),
    errors: normalizeLoomApiErrors(value.errors),
    warnings: asStringArray(value.warnings),
    recorded: asBoolean(value.recorded),
    record_error: asNullableString(value.record_error),
  }
}

// ==================== 引导: 客户端目录 ====================

function normalizeClientAction(value: unknown, available: boolean): ClientAction {
  if (value === 'download' || value === 'external' || value === 'none') return value
  return available ? 'download' : 'none'
}

function normalizeClientSource(value: unknown, available: boolean): ClientSource {
  if (
    value === 'local' ||
    value === 'configured' ||
    value === 'manifest' ||
    value === 'github' ||
    value === 'none'
  ) {
    return value
  }
  if (value === 'release') return 'configured'
  return available ? 'local' : 'none'
}

function normalizeClientEntry(
  value: unknown,
  kind: ClientEntry['kind'],
): ClientEntry {
  const record = isRecord(value) ? value : {}
  const action = normalizeClientAction(record.action, asBoolean(record.available))
  return {
    kind,
    available: action !== 'none',
    action,
    source: normalizeClientSource(record.source, action !== 'none'),
    url: asNullableString(record.url),
    page_url: asNullableString(record.page_url),
    filename: asNullableString(record.filename),
    download_filename: asNullableString(record.download_filename),
    expected_filename: asNullableString(record.expected_filename),
    size: asFiniteNumber(record.size) ?? null,
    sha256: asNullableString(record.sha256),
    version: asNullableString(record.version),
    variant: asNullableString(record.variant),
    debug: typeof record.debug === 'boolean' ? record.debug : null,
    label: asNullableString(record.label),
    fallback_reason: asNullableString(record.fallback_reason),
  }
}

function normalizeClientPort(
  value: unknown,
): { enabled: boolean; port: number } {
  const record = isRecord(value) ? value : {}
  return {
    enabled: asBoolean(record.enabled),
    port: asFiniteNumber(record.port) ?? 0,
  }
}

function normalizeClientConnection(value: unknown): ClientConnectionInfo {
  const record = isRecord(value) ? value : {}
  return {
    host: asString(record.host),
    https: normalizeClientPort(record.https),
    http: normalizeClientPort(record.http),
  }
}

export function normalizeClientCatalog(value: unknown): ClientCatalog | null {
  if (!isRecord(value)) return null
  if (
    !isRecord(value.android) ||
    !isRecord(value.desktop) ||
    !isRecord(value.connection)
  ) {
    return null
  }
  return {
    android: normalizeClientEntry(value.android, 'android'),
    desktop: normalizeClientEntry(value.desktop, 'desktop'),
    connection: normalizeClientConnection(value.connection),
  }
}

// ==================== 引导 v4: 小米健康云 ====================

export function normalizeXiaomiStatus(value: unknown): XiaomiStatus | null {
  if (
    !isRecord(value) ||
    typeof value.enabled !== 'boolean' ||
    typeof value.configured !== 'boolean'
  ) {
    return null
  }
  const phase = asString(value.phase)
  return {
    enabled: value.enabled,
    configured: value.configured,
    phase,
    userid_masked: asString(value.userid_masked),
    userid_configured: asBoolean(value.userid_configured),
    region: asString(value.region),
    last_error: asString(value.last_error),
    needs_login: asBoolean(
      value.needs_login,
      value.enabled && (!value.configured || phase === 'auth_expired'),
    ),
  }
}

export function normalizeXiaomiQrResult(
  value: unknown,
): XiaomiQrResult | null {
  if (!isRecord(value)) return null
  const lp = asString(value.lp)
  const qrBase64 = asString(value.qr_base64)
  if (!lp || !qrBase64) return null
  return {
    lp,
    qr_base64: qrBase64,
    expires_in: asFiniteNumber(value.expires_in) ?? 0,
    login_url: asString(value.login_url),
  }
}

export function normalizeXiaomiQrPollResult(
  value: unknown,
): XiaomiQrPollResult | null {
  if (!isRecord(value)) return null
  if (value.state !== 'waiting' && value.state !== 'success') return null
  if (value.state === 'waiting') return { state: 'waiting' }
  const result: XiaomiQrPollResult = { state: 'success' }
  if (typeof value.userid_masked === 'string') {
    result.userid_masked = value.userid_masked
  }
  if (typeof value.configured === 'boolean') {
    result.configured = value.configured
  }
  return result
}

// ==================== 引导 v4: QQ 网关 ====================

function normalizeQqErrors(value: unknown): QqConfigError[] {
  if (!Array.isArray(value)) return []
  const errors: QqConfigError[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const field = asString(item.field)
    const message = asString(item.message)
    if (!field && !message) continue
    errors.push({ field, message })
  }
  return errors
}

export function normalizeQqStatus(value: unknown): QqStatus | null {
  if (
    !isRecord(value) ||
    typeof value.enabled !== 'boolean' ||
    typeof value.valid !== 'boolean'
  ) {
    return null
  }
  return {
    enabled: value.enabled,
    self_qq: asString(value.self_qq),
    ws_url: asString(value.ws_url),
    ws_token_configured: asBoolean(value.ws_token_configured),
    mcp_token_configured: asBoolean(value.mcp_token_configured),
    valid: value.valid,
    errors: normalizeQqErrors(value.errors),
  }
}

export function normalizeQqValidateResult(
  value: unknown,
): QqValidateResult | null {
  if (!isRecord(value) || typeof value.valid !== 'boolean') return null
  return { valid: value.valid, errors: normalizeQqErrors(value.errors) }
}

export function normalizeQqConfigResult(
  value: unknown,
): QqConfigResult | null {
  if (!isRecord(value) || value.starts_after_finish !== true) return null
  const status = normalizeQqStatus(value)
  if (!status) return null
  return { ...status, starts_after_finish: true }
}

// ==================== 引导 v4: MOSS ====================

export function normalizeMossConfig(value: unknown): MossConfig | null {
  if (
    !isRecord(value) ||
    typeof value.enabled !== 'boolean' ||
    typeof value.base_url !== 'string' ||
    typeof value.model !== 'string'
  ) {
    return null
  }
  return {
    enabled: value.enabled,
    base_url: value.base_url,
    model: value.model,
  }
}

// ==================== 引导 v4: Loom 一次性托管初始化 ====================

export function normalizeLoomSetupResult(
  value: unknown,
): LoomSetupResult | null {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return null
  const stage = asString(value.stage)
  if (!stage) return null
  const loomSource = isRecord(value.loom) ? value.loom : null
  const appliedSource = isRecord(value.applied) ? value.applied : null
  const runtime = isRecord(value.runtime) ? value.runtime : {}
  const result: LoomSetupResult = {
    ok: value.ok,
    stage,
    loom: {
      url: loomSource ? asString(loomSource.url) : asString(value.url),
      port:
        asFiniteNumber(loomSource?.port) ??
        asFiniteNumber(value.port) ??
        null,
      mode: loomSource ? asString(loomSource.mode) : asString(runtime.mode),
      pid:
        asFiniteNumber(loomSource?.pid) ??
        asFiniteNumber(runtime.pid) ??
        null,
      health: normalizeLoomHealth(loomSource?.health ?? runtime.health),
      catalog_models: loomSource
        ? asStringArray(loomSource.catalog_models)
        : asStringArray(value.catalog_models),
    },
    applied: {
      ai_backend: appliedSource
        ? asString(appliedSource.ai_backend)
        : asString(value.ai_backend),
      config_path: appliedSource
        ? asString(appliedSource.config_path)
        : asString(value.config_path),
      api_key_configured: appliedSource
        ? asBoolean(appliedSource.api_key_configured)
        : asBoolean(value.api_key_configured),
    },
  }
  if (typeof value.code === 'string') result.code = value.code
  if (typeof value.message === 'string') result.message = value.message
  if (typeof value.field === 'string') result.field = value.field
  if (isRecord(value.details)) result.details = value.details
  return result
}

// ==================== 引导 v4: finish ====================

function normalizeFinishGroupItem(value: unknown): FinishGroupItem | null {
  if (!isRecord(value)) return null
  const id = asString(value.id)
  if (!id) return null
  const item: FinishGroupItem = {
    layer: asString(value.layer),
    id,
    title: asString(value.title, id),
    message: asString(value.message),
  }
  if (typeof value.fix === 'string') item.fix = value.fix
  return item
}

function normalizeFinishGroupItems(value: unknown): FinishGroupItem[] {
  if (!Array.isArray(value)) return []
  return value
    .map(normalizeFinishGroupItem)
    .filter((item): item is FinishGroupItem => item !== null)
}

export function normalizeFinishGroups(value: unknown): FinishGroups | null {
  if (!isRecord(value)) return null
  return {
    blocking: normalizeFinishGroupItems(value.blocking),
    soft: normalizeFinishGroupItems(value.soft),
  }
}

function normalizeFinishClosingEntries(value: unknown): FinishClosingEntry[] {
  if (!Array.isArray(value)) return []
  const entries: FinishClosingEntry[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const id = asString(item.id)
    if (!id) continue
    entries.push({ id, label: asString(item.label, id) })
  }
  return entries
}

function normalizeFinishClosingDegraded(
  value: unknown,
): FinishClosingDegraded[] {
  if (!Array.isArray(value)) return []
  const entries: FinishClosingDegraded[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const id = asString(item.id)
    if (!id) continue
    entries.push({ id, message: asString(item.message) })
  }
  return entries
}

export function normalizeFinishClosing(value: unknown): FinishClosing | null {
  if (!isRecord(value)) return null
  return {
    title: asString(value.title),
    message: asString(value.message),
    enabled: normalizeFinishClosingEntries(value.enabled),
    skipped: normalizeFinishClosingEntries(value.skipped),
    degraded: normalizeFinishClosingDegraded(value.degraded),
    enter_label: asString(value.enter_label),
  }
}

export function normalizeFinishStatus(value: unknown): FinishStatus | null {
  if (!isRecord(value)) return null
  if (!isRecord(value.runtime) || !isRecord(value.startup)) return null
  const startup = normalizeStartupReport(value.startup)
  if (!startup) return null
  const groups = normalizeFinishGroups(value.groups)
  const activation = normalizeStartupLifecycle(value.activation)
  const finishSource = isRecord(value.finish) ? value.finish : {}
  return {
    runtime: normalizeStartupRuntime(value.runtime),
    startup,
    lifecycle: normalizeStartupLifecycle(value.lifecycle),
    groups,
    activation,
    closing: normalizeFinishClosing(value.closing),
    finish: {
      groups: normalizeFinishGroups(finishSource.groups) ?? groups,
      activation: normalizeStartupLifecycle(finishSource.activation) ?? activation,
    },
  }
}

export function normalizeFinishResult(value: unknown): FinishResult | null {
  if (!isRecord(value) || value.ok !== true) return null
  const state = normalizeOnboardingState(value.state)
  const groups = normalizeFinishGroups(value.groups)
  const closing = normalizeFinishClosing(value.closing)
  if (!state || !groups || !closing) return null
  const result: FinishResult = {
    ok: true,
    state,
    activation: normalizeStartupLifecycle(value.activation),
    groups,
    closing,
  }
  if (typeof value.idempotent === 'boolean') {
    result.idempotent = value.idempotent
  }
  return result
}
