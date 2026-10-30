/**
 * /api/system 冻结契约的 TypeScript 类型 (N15)
 *
 * 仅类型声明; 运行时归一化在 systemNormalize.ts, 请求函数与错误类型在 system.ts。
 */

export interface ProviderInfo {
  kind: string
  location: string
  writable: boolean
  detail: string
}

export interface ConfigSnapshot {
  revision: string
  path: string
  provider: ProviderInfo
  /** 敏感字段已由后端掩码为 "***" */
  config: Record<string, unknown>
  degraded: string[]
  apply_failures: Record<string, string>
  schema_version: string
}

/** 配置运行态摘要 (与可编辑 config 分离, 供状态条展示) */
export interface ConfigStatus {
  revision: string
  writable: boolean
  degraded: string[]
  apply_failures: Record<string, string>
}

export interface ConfigCategory {
  id: string
  title: string
  description: string
  advanced: boolean
}

export interface ConfigField {
  path: string
  type: string
  default: unknown
  enum?: unknown[]
  min?: number
  max?: number
  sensitive: boolean
  apply_strategy: string
  category: string
  title: string
  help: string
  deprecated: boolean
  advanced: boolean
  core: boolean
}

export interface SchemaResponse {
  schema_version: string
  categories: ConfigCategory[]
  fields: ConfigField[]
}

export interface ValidationError {
  path: string
  code: string
  message: string
  severity: string
}

export interface ConfigWarning {
  path: string
  code: string
  message: string
  severity: string
}

export interface ValidateResult {
  ok: true
  warnings: ConfigWarning[]
}

export interface SaveConfigRequest {
  revision: string
  current_password?: string
  changes: Record<string, unknown>
  clear_keys?: string[]
  dry_run?: boolean
}

export interface SaveConfigResult {
  ok: true
  revision: string
  changed: string[]
  applied: string[]
  failed: Record<string, string>
  degraded: string[]
  backup?: string
  dry_run: boolean
}

export interface RestartRequest {
  revision: string
  current_password: string
}

export type RestartScope = 'backend' | 'listener'

export interface RestartResult {
  ok: true
  scope: RestartScope
  restarting: true
}

export type PreflightStatus = 'pass' | 'warn' | 'fail'

export interface PreflightCheck {
  id: string
  label: string
  status: PreflightStatus
  /** 硬阻断项失败会阻止继续; 软检查失败/警告进入 soft_failures */
  blocking: boolean
  category: string
  detail: string
  fix: string
}

export interface PreflightSummary {
  pass: number
  warn: number
  fail: number
}

export interface PreflightResult {
  checks: PreflightCheck[]
  can_proceed: boolean
  /** 硬阻断失败检查 id 列表 */
  blocking_failures: string[]
  /** 需用户显式确认降级的软失败检查 id 列表 */
  soft_failures: string[]
  summary: PreflightSummary
}

export interface OnboardingState {
  version: number | string
  completed_steps: string[]
  skipped_steps: string[]
  current_step: string
  completed: boolean
  started_at: string | null
  updated_at: string | null
}

export type OnboardingStepState =
  | 'completed'
  | 'skipped'
  | 'current'
  | 'pending'

/** 后端 steps_metadata 的只读步骤元数据; 顺序以 /status 返回为准 */
export interface OnboardingStepInfo {
  id: string
  title: string
  description: string
  required: boolean
  skippable: boolean
  state: OnboardingStepState
  auth: string
}

export interface OnboardingStatus {
  state: OnboardingState
  needs_setup: boolean
  degraded: boolean
  onboarding_complete: boolean
  config_revision: string
  steps: OnboardingStepInfo[]
  bootstrap: boolean
  state_version: number
  legacy_upgraded: boolean
  degraded_reasons: string[]
}

export type OnboardingStepStatus = 'completed' | 'skipped'

export interface OnboardingStateRequest {
  step_id: string
  status: OnboardingStepStatus
  data?: Record<string, unknown>
  dry_run?: boolean
}

export interface OnboardingActivationError {
  subsystem: string
  error: string
}

/** POST /onboarding/state 在 finish 记录成功时返回的服务面激活结果 */
export interface OnboardingActivation {
  activated: boolean
  active: boolean
  reason: string
  subsystems: Record<string, unknown>
  errors: OnboardingActivationError[]
  idempotent: boolean
}

export interface OnboardingStateResult {
  state: OnboardingState
  recorded: boolean
  activation?: OnboardingActivation | null
}

export type OnboardingActionKind =
  | 'copy_ai_template'
  | 'generate_self_signed_cert'

export interface OnboardingActionRequest {
  action: OnboardingActionKind
  overwrite?: boolean
  current_password?: string
}

export interface OnboardingActionResult {
  ok: boolean
  result: Record<string, unknown>
}

// ==================== 引导: 启动校验 (T12/T15) ====================

/** GET /onboarding/startup 的校验报告状态 (后端可扩展, 前端按字符串容错) */
export type StartupReportState =
  | 'deferred'
  | 'attempted'
  | 'validated'
  | 'failed'
  | 'aborted'

/** 单个启动探针结果; kind 区分必检/条件/延后 */
export interface StartupCheck {
  id: string
  /** ok | failed | skipped | deferred; 未知值按 muted 展示 */
  status: string
  /** required | conditional | deferred */
  kind: string
  required: boolean
  detail: string
}

export interface StartupError {
  subsystem: string
  error: string
}

export interface StartupWarning {
  subsystem: string
  warning: string
}

/** 最近一次启动校验报告 (后端 StartupValidation.report()) */
export interface StartupReport {
  ok: boolean | null
  state: string
  mode: string
  subsystems: Record<string, string>
  checks: StartupCheck[]
  errors: StartupError[]
  warnings: StartupWarning[]
  deferred: string[]
  generated_at: string | null
}

/** 启动运行时状态 (BootstrapRuntime) */
export interface StartupRuntimeStatus {
  available: boolean
  active: boolean
  started: boolean
  state: string
  committed: boolean
  gate_open: boolean
}

/** 生命周期报告 (attempt/validate/abort 的 runtime.report()) */
export interface StartupLifecycle {
  activated: boolean
  active: boolean
  reason: string
  requested_reason: string
  subsystems: Record<string, string>
  errors: StartupError[]
  idempotent: boolean
  ok: boolean | null
  state: string
  gate_open: boolean
  committed: boolean
  validated: boolean
  promoted: boolean
  started: boolean
  status: string
}

/** GET /onboarding/startup 与 POST attempt/validate/abort 的统一响应 */
export interface StartupStatus {
  report: StartupReport
  runtime: StartupRuntimeStatus
  lifecycle: StartupLifecycle | null
}

// ==================== 引导: 发行资产与下载作业 ====================

export interface ReleaseAssetInfo {
  name: string
  file: string
  sha256: string
  size: number | null
  url: string
  api_version: string
  tiers: string[]
}

export interface ReleaseManifest {
  schema: number
  product: string
  version: string
  assets: Record<string, ReleaseAssetInfo>
}

export interface KernelInstallStatus {
  dir: string
  present: boolean
  source: 'release' | 'source' | 'unknown' | null
  version: string | null
  marker: string
  installed_from_release: boolean
  installable: boolean
  install_blocked_reason: string | null
}

export interface KernelPythonStatus {
  path: string
  source: string
  exists: boolean
  configured: string
  configured_exists: boolean
  last_resort: boolean
}

export interface KernelModelsStatus {
  model_dir: string
  configured: boolean
  exists: boolean
}

export interface KernelDiskStatus {
  path: string
  free: number
  required: number
  sufficient: boolean
}

export interface KernelHealthStatus {
  pidfile: string
  found: boolean
  pid: number | null
  port: number | null
  alive: boolean
  healthy: boolean
  api_version: string | null
  base_url: string | null
  error: string | null
}

export interface OnboardingDependencies {
  kernel: KernelInstallStatus
  python: KernelPythonStatus
  models: KernelModelsStatus
  disk: KernelDiskStatus
  health: KernelHealthStatus
}

/** GET /api/system/onboarding/assets; manifest 为从扁平响应还原后的统一视图 */
export interface DependenciesStatus {
  configured: boolean
  manifest: ReleaseManifest | null
  assets: Record<string, ReleaseAssetInfo>
  dependencies: OnboardingDependencies | null
  kernel: KernelInstallStatus | null
  python: KernelPythonStatus | null
  models: KernelModelsStatus | null
  disk: KernelDiskStatus | null
  health: KernelHealthStatus | null
  error: string | null
}

export type DownloadJobState =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface DownloadJobProgress {
  bytes: number
  total: number | null
  pct: number
}

export interface DownloadJob {
  id: string
  kind: string
  state: DownloadJobState
  asset: string | null
  progress: DownloadJobProgress
  current: string
  logs_tail: string[]
  result: unknown
  error: string | null
  cancel_requested: boolean
  created_at: string
  updated_at: string
}

/** GET /api/system/onboarding/models 的单个模型状态 */
export interface KernelModelAssetStatus {
  id: string
  tier: string
  source: string
  repo: string
  target: string
  kind: string
  size_bytes: number
  gated: boolean
  present: boolean
  missing_files: string[]
  error: string | null
}

/** GET /api/system/onboarding/models 的档位汇总 */
export interface KernelModelTierStatus {
  id: string
  model_ids: string[]
  total_size_bytes: number
  missing_size_bytes: number
}

/** GET /api/system/onboarding/models 的完整响应 */
export interface KernelModelCatalog {
  manifest_version: string
  models: KernelModelAssetStatus[]
  tiers: KernelModelTierStatus[]
  total_size_bytes: number
  required_size_bytes: number
}

/** POST /api/system/onboarding/models/download 的选择参数 */
export interface KernelModelsDownloadOptions {
  models?: string[]
  tiers?: string[]
  password?: string
}

/** 模型根/数据根的解析来源 */
export type StorageRootSource = 'env' | 'config' | 'default'

export interface StorageRootSources {
  data_root: StorageRootSource
  models_root: StorageRootSource
}

/** ~/.cache 下检测到的旧模型缓存（只读探测，不迁移） */
export interface LegacyModelCaches {
  exists: boolean
  home: string
  /** 旧缓存存在时建议的临时模型根（通常是 home） */
  suggested_root: string | null
  modelscope: boolean
  huggingface: boolean
  axeuh_kernel: boolean
  paths: Record<string, string>
}

/** GET /api/system/onboarding/storage 的只读快照 */
export interface StorageSnapshot {
  data_root: string
  models_root: string
  free_bytes: number
  writable: boolean
  source: StorageRootSources
  models_dir_configured: boolean
  data_root_configured: boolean
  legacy: LegacyModelCaches
  system_disk: boolean
  system_drive: string | null
  warnings: string[]
}

/** POST /api/system/onboarding/storage 的响应：保存后的同一份快照 */
export type StorageSaveResult = StorageSnapshot

// ==================== 引导: Loom ====================

export interface LoomApiError {
  code: string
  message: string
}

export interface LoomHealthInfo {
  status: string | null
  version: string | null
  uptime_ms: number | null
  started_at: string | null
}

export interface LoomModelInfo {
  id: string
  provider: string
  contextWindow: number | null
  maxOutput: number | null
  vision: boolean
  timeout: number | null
  reasoningEffort?: string
}

export interface LoomChannel {
  provider: string
  model_count: number
  models: string[]
  credential_ref: string | null
}

export interface LoomCredentialRef {
  name: string
  env_ref: string
}

export interface LoomConfigView {
  workspace: string | null
  model_ids: string[]
  pricing_providers: string[]
  effective_version_sha256: string | null
}

export interface LoomStatus {
  found: boolean
  source: string
  fingerprint: string
  detail: string
  url: string
  managed: boolean
  reachable: boolean
  online: boolean
  health: LoomHealthInfo | null
  main_model: LoomModelInfo | null
  models: LoomModelInfo[]
  channels: LoomChannel[]
  providers: LoomChannel[]
  credentials: LoomCredentialRef[]
  config: LoomConfigView | null
  managed_config: { path: string; exists: boolean }
  errors: LoomApiError[]
}

export interface LoomPricing {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface LoomSelection {
  provider: string
  model: string
  base_url?: string
  context_window?: number
  max_output?: number
  vision?: boolean
  timeout?: number
  pricing?: LoomPricing
}

export interface LoomValidateResult {
  ok: boolean
  valid: boolean
  managed: boolean
  selection: LoomSelection
  main_model: LoomModelInfo | null
  validation_mode: string
  errors: LoomApiError[]
  warnings: LoomApiError[]
}

export interface LoomRestartResult {
  ok: boolean
  requested: boolean
  performed: boolean
  verified: boolean
  manual_required: boolean
  command: string | null
  old_pid: number | null
  new_pid: number | null
  detail: string
  loom_down?: boolean
  reason?: string
}

export interface LoomApplyRollback {
  attempted: boolean
  restored: boolean
  reason?: string
  detail?: string
  restart?: LoomRestartResult
  loom_down?: boolean
}

export interface LoomApplyResult {
  ok: boolean
  managed: boolean
  applied: boolean
  manual_required: boolean
  selection: LoomSelection
  validation_mode: string
  backup: string | null
  rollback: LoomApplyRollback | null
  restart: LoomRestartResult
  errors: LoomApiError[]
  warnings: LoomApiError[]
}

export interface LoomApplyOptions {
  restart?: boolean
  currentPassword?: string
}

// ==================== 引导: Loom 运行时 (T13) ====================

export type LoomRuntimeMode = 'systemd' | 'child' | 'none'

export interface LoomTokenState {
  found: boolean
  source: string
  fingerprint: string
  provisioned: boolean
  token_file: string | null
  persisted: boolean
  detail: string
  errors: LoomApiError[]
}

export interface LoomRuntimeSystemdInfo {
  systemctl: boolean
  unit: string
  present: boolean
  /** 单元归属当前项目实例时才允许自动启停；缺失/外来一律 false */
  owned: boolean
  load_state: string | null
  active_state: string | null
  sub_state: string | null
  pid: number | null
}

export interface LoomRuntimeChildInfo {
  node: boolean
  cli_path: string
  cli_present: boolean
}

export interface LoomRuntimeModeDetail {
  systemd: LoomRuntimeSystemdInfo
  child: LoomRuntimeChildInfo
  /** 模式判定失败原因, 如 node_missing / loom_harness_dist_missing */
  reasons: string[]
}

export interface LoomRuntimeHealth {
  reachable: boolean
  ok: boolean
  http_status: number | null
  status: string | null
  version: string | null
  error: string | null
}

/** GET /api/system/onboarding/loom/runtime */
export interface LoomRuntimeStatus {
  ok: boolean
  mode: LoomRuntimeMode
  mode_detail: LoomRuntimeModeDetail
  managed: boolean
  config_path: string
  config_exists: boolean
  token_state: LoomTokenState | null
  running: boolean
  pid: number | null
  pid_verified: boolean
  adopted: boolean
  reachable: boolean
  health: LoomRuntimeHealth | null
  port: number | null
  detail: string
}

export interface LoomConfigEnsureOptions {
  overwrite?: boolean
  credentialEnv?: string
  currentPassword?: string
}

/** POST /api/system/onboarding/loom/config/ensure */
export interface LoomConfigEnsureResult {
  ok: boolean
  managed: boolean
  path: string
  exists: boolean
  created: boolean
  overwritten: boolean
  backup: string | null
  manual_required: boolean
  validation: string
  credential_ref: string | null
  errors: LoomApiError[]
  detail?: string
  overwrite_required?: boolean
}

/** POST /loom/{start,stop,restart} 的统一响应 */
export interface LoomRuntimeActionResult {
  ok: boolean
  mode: LoomRuntimeMode
  requested: string
  performed: boolean
  verified: boolean
  manual_required: boolean
  adopted: boolean
  pid: number | null
  old_pid: number | null
  new_pid: number | null
  command: string | null
  detail: string
  health: LoomRuntimeHealth | null
  errors: LoomApiError[]
  token_state?: LoomTokenState
  config_path?: string
  log_path?: string
}

// ==================== 引导: MOSS ====================

export type MossChoice = 'enabled' | 'disabled' | 'skipped'

export interface MossUnits {
  enable: string[]
  disable: string[]
}

export interface MossHelperState {
  configured: boolean
  reason: string
  invoked: boolean
  returncode: number | null
  ok?: boolean
  error?: string | null
}

export interface MossStatus {
  base_url: string
  model: string
  manage_units: boolean
  helper_configured: boolean
  helper_reason: string
  managed_available: boolean
  choice: MossChoice | null
  last_choice: Record<string, unknown> | null
  units: MossUnits
  commands: Record<string, string[]>
  warnings: string[]
}

export interface MossValidation {
  base_url: string | null
  model: string
  reachable: boolean
  model_found: boolean
  models: string[]
  matched_model: string | null
  latency_ms: number
  loopback: boolean
  warnings: string[]
  warning: string | null
  error: LoomApiError | null
}

export interface MossApplyResult {
  choice: MossChoice
  ok: boolean
  status: string
  enabled: boolean
  disabled: boolean
  manual_required: boolean
  managed: boolean
  verified: boolean
  service_reachable: boolean
  verification_pending: boolean
  base_url: string | null
  model: string
  commands: string[]
  manual_commands: string[]
  units: MossUnits
  helper: MossHelperState
  validation: MossValidation | null
  verification: MossValidation | null
  errors: LoomApiError[]
  warnings: string[]
  recorded: boolean
  record_error: string | null
}

export interface MossApplyOptions {
  baseUrl?: string
  model?: string
  currentPassword?: string
}

// ==================== 引导: 客户端目录 ====================

/** 客户端解析动作: 可下载 / 仅发行页 / 不可用 */
export type ClientAction = 'download' | 'external' | 'none'

/** 客户端解析来源: 本机 / 配置 URL / 发行清单 / GitHub 发行页 / 全部缺失 */
export type ClientSource = 'local' | 'configured' | 'manifest' | 'github' | 'none'

export interface ClientEntry {
  kind: 'android' | 'desktop'
  /** 契约恒等式: available === (action !== 'none') */
  available: boolean
  action: ClientAction
  source: ClientSource
  url: string | null
  /** 发行页地址; action=external 时与 url 相同 */
  page_url: string | null
  filename: string | null
  download_filename: string | null
  expected_filename: string | null
  size: number | null
  sha256: string | null
  version: string | null
  variant: string | null
  debug: boolean | null
  label: string | null
  fallback_reason: string | null
}

export interface ClientConnectionPort {
  enabled: boolean
  port: number
}

export interface ClientConnectionInfo {
  host: string
  https: ClientConnectionPort
  http: ClientConnectionPort
}

export interface ClientCatalog {
  android: ClientEntry
  desktop: ClientEntry
  connection: ClientConnectionInfo
}

// ==================== 客户端下载: 一次性票据 ====================

export interface OtaTicket {
  ticket: string
  url: string
  expires_at: number
  expires_in: number
  filename: string
  source_filename: string
  sha256: string
  size: number
}

// ==================== 引导 v4: 小米健康云 ====================

/** GET/POST /api/system/onboarding/xiaomi* 的脱敏状态; 永不返回 passToken */
export interface XiaomiStatus {
  enabled: boolean
  configured: boolean
  phase: string
  userid_masked: string
  userid_configured: boolean
  region: string
  last_error: string
  needs_login: boolean
}

export interface XiaomiConfigRequest {
  enabled: boolean
  current_password?: string
}

export interface XiaomiQrResult {
  lp: string
  qr_base64: string
  expires_in: number
  login_url: string
}

export interface XiaomiQrPollResult {
  state: 'waiting' | 'success'
  userid_masked?: string
  configured?: boolean
}

// ==================== 引导 v4: QQ 网关 ====================

export interface QqConfigError {
  field: string
  message: string
}

/** 脱敏状态; 永不返回 ws_token/token_file */
export interface QqStatus {
  enabled: boolean
  self_qq: string
  ws_url: string
  ws_token_configured: boolean
  mcp_token_configured: boolean
  valid: boolean
  errors: QqConfigError[]
}

export interface QqConfigRequest {
  enabled: boolean
  self_qq: string
  ws_url: string
  ws_token?: string
  regenerate_mcp_token?: boolean
  current_password?: string
}

/** POST /qq/config 成功只落配置, 网关在 finish 后启动 */
export type QqConfigResult = QqStatus & { starts_after_finish: true }

export interface QqValidateResult {
  valid: boolean
  errors: QqConfigError[]
}

// ==================== 引导 v4: MOSS ====================

export interface MossConfig {
  enabled: boolean
  base_url: string
  model: string
}

export interface MossConfigRequest {
  enabled: boolean
  base_url: string
  model: string
  current_password?: string
}

// ==================== 引导 v4: Loom 一次性托管初始化 ====================

export interface LoomSetupRequest {
  port: number
  provider: string
  base_url: string
  model: string
  api_key?: string
  context_window?: number
  max_output?: number
  timeout?: number
  pricing?: LoomPricing
  current_password?: string
}

export interface LoomSetupLoomInfo {
  url: string
  port: number | null
  mode: string
  pid: number | null
  health: LoomHealthInfo | null
  catalog_models: string[]
}

export interface LoomSetupApplied {
  ai_backend: string
  config_path: string
  api_key_configured: boolean
}

/** POST /loom/setup; 响应不含 api_key/token 明文, api_key_configured 仅为布尔 */
export interface LoomSetupResult {
  ok: boolean
  stage: string
  loom: LoomSetupLoomInfo
  applied: LoomSetupApplied
  /** 失败响应 (HTTP 200 + ok=false) 的错误码/阶段/字段/无密钥 details */
  code?: string
  message?: string
  field?: string
  details?: Record<string, unknown>
}

// ==================== 引导 v4: finish ====================

export interface FinishGroupItem {
  layer: string
  id: string
  title: string
  message: string
  fix?: string
}

export interface FinishGroups {
  blocking: FinishGroupItem[]
  soft: FinishGroupItem[]
}

export interface FinishClosingEntry {
  id: string
  label: string
}

export interface FinishClosingDegraded {
  id: string
  message: string
}

export interface FinishClosing {
  title: string
  message: string
  enabled: FinishClosingEntry[]
  skipped: FinishClosingEntry[]
  degraded: FinishClosingDegraded[]
  enter_label: string
}

/** GET /api/system/onboarding/finish 的只读收口快照 */
export interface FinishStatus {
  runtime: StartupRuntimeStatus
  startup: StartupReport
  lifecycle: StartupLifecycle | null
  groups: FinishGroups | null
  activation: StartupLifecycle | null
  closing: FinishClosing | null
  finish: {
    groups: FinishGroups | null
    activation: StartupLifecycle | null
  }
}

/** POST /api/system/onboarding/finish 成功响应 */
export interface FinishResult {
  ok: boolean
  state: OnboardingState
  activation: StartupLifecycle | null
  groups: FinishGroups
  closing: FinishClosing
  idempotent?: boolean
}
