/**
 * 系统配置 + 引导初始化 API (N15)
 *
 * 冻结契约 (后端实现为准):
 *   GET  /api/system/config                          -> ConfigSnapshot
 *   GET  /api/system/config/schema                   -> SchemaResponse
 *   POST /api/system/config/validate                 -> ValidateResult / 422
 *   PUT  /api/system/config                          -> SaveConfigResult / 403/409/422
 *   POST /api/system/config/restart                  -> RestartResult / 409
 *   GET  /api/system/onboarding/preflight            -> PreflightResult
 *   GET  /api/system/onboarding/status               -> OnboardingStatus
 *   POST /api/system/onboarding/state                -> OnboardingStateResult
 *   POST /api/system/onboarding/action               -> OnboardingActionResult
 *   GET  /api/system/onboarding/assets               -> DependenciesStatus
 *   POST /api/system/onboarding/assets/download      -> DownloadJob (202)
 *   GET  /api/system/onboarding/jobs/{id}            -> DownloadJob
 *   POST /api/system/onboarding/jobs/{id}/cancel     -> DownloadJob
 *   GET  /api/system/onboarding/models               -> KernelModelCatalog
 *   POST /api/system/onboarding/models/download      -> DownloadJob (202)
 *   GET  /api/system/onboarding/loom                 -> LoomStatus
 *   GET  /api/system/onboarding/loom/runtime         -> LoomRuntimeStatus
 *   POST /api/system/onboarding/loom/token/ensure    -> LoomTokenState
 *   POST /api/system/onboarding/loom/config/ensure   -> LoomConfigEnsureResult
 *   POST /api/system/onboarding/loom/start           -> LoomRuntimeActionResult
 *   POST /api/system/onboarding/loom/stop            -> LoomRuntimeActionResult
 *   POST /api/system/onboarding/loom/validate        -> LoomValidateResult
 *   POST /api/system/onboarding/loom/apply           -> LoomApplyResult
 *   POST /api/system/onboarding/loom/restart         -> LoomRestartResult / LoomRuntimeActionResult
 *   GET  /api/system/onboarding/moss                 -> MossStatus
 *   POST /api/system/onboarding/moss/validate        -> MossValidation
 *   POST /api/system/onboarding/moss/apply           -> MossApplyResult
 *   GET  /api/system/onboarding/clients              -> ClientCatalog
 *
 * 失败语义: 非 2xx 与网络异常统一抛 SystemApiError (携带 status/code/errors/data),
 * 不返回 null —— 配置编辑器必须区分 403 密码/配置锁、409 版本冲突、422 校验失败。
 * 密码仅出现在当次请求体; 密钥字段由后端掩码为 "***"; 本模块不写任何存储。
 */

import { apiGetVerbose, apiPostVerbose, apiPutVerbose } from '@/api/client'
import {
  asFiniteNumber,
  asString,
  isRecord,
  normalizeOnboardingActivation,
  normalizeOnboardingState,
  normalizeOnboardingStatus,
  normalizePreflight,
  normalizeRestartScope,
  normalizeSaveResult,
  normalizeSchema,
  normalizeSnapshot,
  normalizeValidationErrors,
  normalizeWarnings,
} from './systemNormalize'
import {
  normalizeClientCatalog,
  normalizeDependenciesStatus,
  normalizeDownloadJob,
  normalizeFinishResult,
  normalizeFinishStatus,
  normalizeKernelModelCatalog,
  normalizeLoomApplyResult,
  normalizeLoomConfigEnsureResult,
  normalizeLoomRestartResult,
  normalizeLoomRuntimeActionResult,
  normalizeLoomRuntimeStatus,
  normalizeLoomSetupResult,
  normalizeLoomStatus,
  normalizeLoomTokenState,
  normalizeLoomValidateResult,
  normalizeMossApplyResult,
  normalizeMossConfig,
  normalizeMossStatus,
  normalizeMossValidation,
  normalizeQqConfigResult,
  normalizeQqStatus,
  normalizeQqValidateResult,
  normalizeStartupStatus,
  normalizeStorageSaveResult,
  normalizeStorageSnapshot,
  normalizeXiaomiQrPollResult,
  normalizeXiaomiQrResult,
  normalizeXiaomiStatus,
} from './systemOnboardingNormalize'
import type {
  ClientCatalog,
  ConfigSnapshot,
  DependenciesStatus,
  DownloadJob,
  FinishResult,
  FinishStatus,
  KernelModelCatalog,
  KernelModelsDownloadOptions,
  LoomApplyOptions,
  LoomApplyResult,
  LoomConfigEnsureOptions,
  LoomConfigEnsureResult,
  LoomRestartResult,
  LoomRuntimeActionResult,
  LoomRuntimeStatus,
  LoomSelection,
  LoomSetupRequest,
  LoomSetupResult,
  LoomStatus,
  LoomTokenState,
  LoomValidateResult,
  MossApplyOptions,
  MossApplyResult,
  MossChoice,
  MossConfig,
  MossConfigRequest,
  MossStatus,
  MossValidation,
  OnboardingActionRequest,
  OnboardingActionResult,
  OnboardingStateRequest,
  OnboardingStateResult,
  OnboardingStatus,
  OtaTicket,
  PreflightResult,
  QqConfigRequest,
  QqConfigResult,
  QqStatus,
  QqValidateResult,
  RestartRequest,
  RestartResult,
  SaveConfigRequest,
  SaveConfigResult,
  SchemaResponse,
  StartupStatus,
  StorageSaveResult,
  StorageSnapshot,
  ValidateResult,
  ValidationError,
  XiaomiConfigRequest,
  XiaomiQrPollResult,
  XiaomiQrResult,
  XiaomiStatus,
} from './systemTypes'

export type {
  ClientAction,
  ClientCatalog,
  ClientConnectionInfo,
  ClientConnectionPort,
  ClientEntry,
  ClientSource,
  ConfigCategory,
  ConfigField,
  ConfigSnapshot,
  ConfigStatus,
  ConfigWarning,
  DependenciesStatus,
  DownloadJob,
  DownloadJobProgress,
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
  KernelModelsDownloadOptions,
  KernelModelsStatus,
  KernelPythonStatus,
  LoomApiError,
  LoomApplyOptions,
  LoomApplyResult,
  LoomApplyRollback,
  LoomChannel,
  LoomConfigEnsureOptions,
  LoomConfigEnsureResult,
  LoomConfigView,
  LoomCredentialRef,
  LoomHealthInfo,
  LoomModelInfo,
  LoomPricing,
  LoomRestartResult,
  LoomRuntimeActionResult,
  LoomRuntimeChildInfo,
  LoomRuntimeHealth,
  LoomRuntimeMode,
  LoomRuntimeModeDetail,
  LoomRuntimeStatus,
  LoomRuntimeSystemdInfo,
  LoomSelection,
  LoomSetupApplied,
  LoomSetupLoomInfo,
  LoomSetupRequest,
  LoomSetupResult,
  LoomStatus,
  LoomTokenState,
  LoomValidateResult,
  MossApplyOptions,
  MossApplyResult,
  MossChoice,
  MossConfig,
  MossConfigRequest,
  MossHelperState,
  MossStatus,
  MossUnits,
  MossValidation,
  OnboardingActionKind,
  OnboardingActionRequest,
  OnboardingActivation,
  OnboardingActivationError,
  OnboardingActionResult,
  OnboardingDependencies,
  OnboardingState,
  OnboardingStateRequest,
  OnboardingStateResult,
  OnboardingStatus,
  OnboardingStepInfo,
  OnboardingStepState,
  OnboardingStepStatus,
  OtaTicket,
  PreflightCheck,
  PreflightResult,
  PreflightStatus,
  PreflightSummary,
  ProviderInfo,
  QqConfigError,
  QqConfigRequest,
  QqConfigResult,
  QqStatus,
  QqValidateResult,
  ReleaseAssetInfo,
  ReleaseManifest,
  RestartRequest,
  RestartResult,
  RestartScope,
  SaveConfigRequest,
  SaveConfigResult,
  SchemaResponse,
  StartupCheck,
  StartupError,
  StartupLifecycle,
  StartupReport,
  StartupReportState,
  StartupRuntimeStatus,
  StartupStatus,
  StartupWarning,
  StorageSaveResult,
  StorageSnapshot,
  ValidateResult,
  ValidationError,
  XiaomiConfigRequest,
  XiaomiQrPollResult,
  XiaomiQrResult,
  XiaomiStatus,
} from './systemTypes'

const BASE = '/api/system'

/** /api/system 非 2xx 与网络异常的统一错误类型 */
export class SystemApiError extends Error {
  readonly status: number
  readonly code: string
  readonly errors: ValidationError[]
  /** 原始错误响应体 (如 409 的 current_revision / deployment_required 的 command) */
  readonly data: Record<string, unknown>

  constructor(
    status: number,
    code: string,
    message: string,
    errors: ValidationError[] = [],
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

export function isSystemApiError(value: unknown): value is SystemApiError {
  return value instanceof SystemApiError
}

function asErrorMessage(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function errorFrom(
  status: number,
  data: unknown,
  fallbackMessage: string,
): SystemApiError {
  if (status === 0) {
    return new SystemApiError(0, 'network_error', fallbackMessage)
  }
  const body = isRecord(data) ? data : {}
  const message =
    asErrorMessage(body.message) ||
    asErrorMessage(body.detail) ||
    fallbackMessage
  return new SystemApiError(
    status,
    asErrorMessage(body.code) || `http_${status}`,
    message,
    normalizeValidationErrors(body.errors),
    body,
  )
}

function invalidResponse(status: number, endpoint: string): SystemApiError {
  return new SystemApiError(
    status,
    'invalid_response',
    `响应格式无效: ${endpoint}`,
  )
}

function setupHeaders(
  setupToken?: string,
): Record<string, string> | undefined {
  const token = setupToken?.trim()
  return token ? { 'X-Setup-Token': token } : undefined
}

export async function getSystemConfig(): Promise<ConfigSnapshot> {
  const res = await apiGetVerbose<unknown>(`${BASE}/config`)
  if (!res.ok) throw errorFrom(res.status, res.data, '获取系统配置失败')
  const snapshot = normalizeSnapshot(res.data)
  if (!snapshot) throw invalidResponse(res.status, `${BASE}/config`)
  return snapshot
}

export async function getSystemConfigSchema(): Promise<SchemaResponse> {
  const res = await apiGetVerbose<unknown>(`${BASE}/config/schema`)
  if (!res.ok) throw errorFrom(res.status, res.data, '获取配置 schema 失败')
  const schema = normalizeSchema(res.data)
  if (!schema) throw invalidResponse(res.status, `${BASE}/config/schema`)
  return schema
}

export async function validateSystemConfig(
  changes: Record<string, unknown>,
  clearKeys?: string[],
): Promise<ValidateResult> {
  const body: Record<string, unknown> = { changes }
  if (clearKeys && clearKeys.length > 0) body.clear_keys = clearKeys

  const res = await apiPostVerbose<unknown>(`${BASE}/config/validate`, body)
  if (!res.ok) throw errorFrom(res.status, res.data, '配置校验失败')
  if (!isRecord(res.data)) {
    throw invalidResponse(res.status, `${BASE}/config/validate`)
  }
  return { ok: true, warnings: normalizeWarnings(res.data.warnings) }
}

export async function saveSystemConfig(
  req: SaveConfigRequest,
  setupToken?: string,
): Promise<SaveConfigResult> {
  const res = await apiPutVerbose<unknown>(
    `${BASE}/config`,
    req,
    setupHeaders(setupToken),
  )
  if (!res.ok) throw errorFrom(res.status, res.data, '保存配置失败')
  const result = normalizeSaveResult(res.data)
  if (!result) throw invalidResponse(res.status, `${BASE}/config`)
  return result
}

export async function restartSystem(
  req: RestartRequest,
): Promise<RestartResult> {
  const res = await apiPostVerbose<unknown>(`${BASE}/config/restart`, req)
  if (!res.ok) throw errorFrom(res.status, res.data, '重启服务失败')
  const scope = normalizeRestartScope(
    isRecord(res.data) ? res.data.scope : undefined,
  )
  if (!scope) throw invalidResponse(res.status, `${BASE}/config/restart`)
  return { ok: true, scope, restarting: true }
}

export async function getOnboardingPreflight(): Promise<PreflightResult> {
  const res = await apiGetVerbose<unknown>(`${BASE}/onboarding/preflight`)
  if (!res.ok) throw errorFrom(res.status, res.data, '获取环境预检失败')
  const preflight = normalizePreflight(res.data)
  if (!preflight) {
    throw invalidResponse(res.status, `${BASE}/onboarding/preflight`)
  }
  return preflight
}

export async function getOnboardingStatus(): Promise<OnboardingStatus> {
  const res = await apiGetVerbose<unknown>(`${BASE}/onboarding/status`)
  if (!res.ok) throw errorFrom(res.status, res.data, '获取初始化状态失败')
  const status = normalizeOnboardingStatus(res.data)
  if (!status) {
    throw invalidResponse(res.status, `${BASE}/onboarding/status`)
  }
  return status
}

export async function postOnboardingState(
  req: OnboardingStateRequest,
  setupToken?: string,
): Promise<OnboardingStateResult> {
  const res = await apiPostVerbose<unknown>(
    `${BASE}/onboarding/state`,
    req,
    setupHeaders(setupToken),
  )
  if (!res.ok) throw errorFrom(res.status, res.data, '记录初始化步骤失败')
  const state = normalizeOnboardingState(
    isRecord(res.data) ? res.data.state : undefined,
  )
  if (!state) {
    throw invalidResponse(res.status, `${BASE}/onboarding/state`)
  }
  return {
    state,
    recorded: isRecord(res.data) && res.data.recorded === true,
    activation: isRecord(res.data)
      ? normalizeOnboardingActivation(res.data.activation)
      : null,
  }
}

export async function runOnboardingAction(
  req: OnboardingActionRequest,
  setupToken?: string,
  currentPassword?: string,
): Promise<OnboardingActionResult> {
  const payload: OnboardingActionRequest = {
    ...req,
    ...(currentPassword ? { current_password: currentPassword } : {}),
  }
  const res = await apiPostVerbose<unknown>(
    `${BASE}/onboarding/action`,
    payload,
    setupHeaders(setupToken),
  )
  if (!res.ok) throw errorFrom(res.status, res.data, '执行初始化操作失败')
  if (!isRecord(res.data)) {
    throw invalidResponse(res.status, `${BASE}/onboarding/action`)
  }
  return {
    ok: res.data.ok === true,
    result: isRecord(res.data.result) ? res.data.result : {},
  }
}

// ==================== 引导: 依赖资产与下载作业 ====================

const ONBOARDING = `${BASE}/onboarding`

// ==================== 引导 v4: 小米健康云 ====================

const XIAOMI_ONBOARDING = `${ONBOARDING}/xiaomi`

export async function getXiaomiOnboarding(): Promise<XiaomiStatus> {
  const res = await apiGetVerbose<unknown>(XIAOMI_ONBOARDING)
  if (!res.ok) throw errorFrom(res.status, res.data, '获取小米健康云状态失败')
  const status = normalizeXiaomiStatus(res.data)
  if (!status) throw invalidResponse(res.status, XIAOMI_ONBOARDING)
  return status
}

export async function configureXiaomi(
  body: XiaomiConfigRequest,
  setupToken?: string,
): Promise<XiaomiStatus> {
  const path = `${XIAOMI_ONBOARDING}/config`
  const res = await apiPostVerbose<unknown>(
    path,
    body,
    setupHeaders(setupToken),
  )
  if (!res.ok) throw errorFrom(res.status, res.data, '保存小米健康云配置失败')
  const status = normalizeXiaomiStatus(res.data)
  if (!status) throw invalidResponse(res.status, path)
  return status
}

export async function requestXiaomiQr(
  setupToken?: string,
  currentPassword?: string,
): Promise<XiaomiQrResult> {
  const path = `${XIAOMI_ONBOARDING}/qr`
  const body: Record<string, unknown> = {}
  if (currentPassword) body.current_password = currentPassword
  const res = await apiPostVerbose<unknown>(
    path,
    body,
    setupHeaders(setupToken),
  )
  if (!res.ok) throw errorFrom(res.status, res.data, '申请小米健康云二维码失败')
  const result = normalizeXiaomiQrResult(res.data)
  if (!result) throw invalidResponse(res.status, path)
  return result
}

export async function pollXiaomiQr(
  lp: string,
  setupToken?: string,
  currentPassword?: string,
): Promise<XiaomiQrPollResult> {
  const path = `${XIAOMI_ONBOARDING}/qr/poll`
  const body: Record<string, unknown> = { lp }
  if (currentPassword) body.current_password = currentPassword
  const res = await apiPostVerbose<unknown>(
    path,
    body,
    setupHeaders(setupToken),
  )
  if (!res.ok) throw errorFrom(res.status, res.data, '轮询小米健康云扫码状态失败')
  const result = normalizeXiaomiQrPollResult(res.data)
  if (!result) throw invalidResponse(res.status, path)
  return result
}

// ==================== 引导 v4: QQ 网关 ====================

const QQ_ONBOARDING = `${ONBOARDING}/qq`

export async function getQqOnboarding(): Promise<QqStatus> {
  const res = await apiGetVerbose<unknown>(QQ_ONBOARDING)
  if (!res.ok) throw errorFrom(res.status, res.data, '获取 QQ 网关状态失败')
  const status = normalizeQqStatus(res.data)
  if (!status) throw invalidResponse(res.status, QQ_ONBOARDING)
  return status
}

export async function validateQqConfig(
  body: QqConfigRequest,
  setupToken?: string,
): Promise<QqValidateResult> {
  const path = `${QQ_ONBOARDING}/validate`
  const res = await apiPostVerbose<unknown>(
    path,
    body,
    setupHeaders(setupToken),
  )
  if (!res.ok) throw errorFrom(res.status, res.data, '校验 QQ 网关配置失败')
  const result = normalizeQqValidateResult(res.data)
  if (!result) throw invalidResponse(res.status, path)
  return result
}

export async function configureQq(
  body: QqConfigRequest,
  setupToken?: string,
): Promise<QqConfigResult> {
  const path = `${QQ_ONBOARDING}/config`
  const res = await apiPostVerbose<unknown>(
    path,
    body,
    setupHeaders(setupToken),
  )
  if (!res.ok) throw errorFrom(res.status, res.data, '保存 QQ 网关配置失败')
  const result = normalizeQqConfigResult(res.data)
  if (!result) throw invalidResponse(res.status, path)
  return result
}

// ==================== 引导 v4: MOSS ====================

export async function getMossConfig(): Promise<MossConfig> {
  const path = `${ONBOARDING}/moss`
  const res = await apiGetVerbose<unknown>(path)
  if (!res.ok) throw errorFrom(res.status, res.data, '获取 MOSS 配置失败')
  const config = normalizeMossConfig(res.data)
  if (!config) throw invalidResponse(res.status, path)
  return config
}

export async function configureMoss(
  body: MossConfigRequest,
  setupToken?: string,
): Promise<MossConfig> {
  const path = `${ONBOARDING}/moss/config`
  const res = await apiPostVerbose<unknown>(
    path,
    body,
    setupHeaders(setupToken),
  )
  if (!res.ok) throw errorFrom(res.status, res.data, '保存 MOSS 配置失败')
  const config = normalizeMossConfig(res.data)
  if (!config) throw invalidResponse(res.status, path)
  return config
}

// ==================== 引导 v4: Loom 一次性托管初始化 ====================

export async function setupLoom(
  body: LoomSetupRequest,
  setupToken?: string,
): Promise<LoomSetupResult> {
  const path = `${ONBOARDING}/loom/setup`
  const res = await apiPostVerbose<unknown>(
    path,
    body,
    setupHeaders(setupToken),
  )
  if (!res.ok) throw errorFrom(res.status, res.data, '初始化 Loom 失败')
  const result = normalizeLoomSetupResult(res.data)
  if (!result) throw invalidResponse(res.status, path)
  return result
}

// ==================== 引导 v4: finish ====================

const FINISH_ONBOARDING = `${ONBOARDING}/finish`

export async function getOnboardingFinish(): Promise<FinishStatus> {
  const res = await apiGetVerbose<unknown>(FINISH_ONBOARDING)
  if (!res.ok) throw errorFrom(res.status, res.data, '获取完成引导状态失败')
  const status = normalizeFinishStatus(res.data)
  if (!status) throw invalidResponse(res.status, FINISH_ONBOARDING)
  return status
}

export async function finishOnboarding(
  allowDegraded: boolean,
  currentPassword?: string,
  setupToken?: string,
): Promise<FinishResult> {
  const body: Record<string, unknown> = {
    allow_degraded: allowDegraded,
  }
  if (currentPassword) body.current_password = currentPassword
  const res = await apiPostVerbose<unknown>(
    FINISH_ONBOARDING,
    body,
    setupHeaders(setupToken),
  )
  if (!res.ok) throw errorFrom(res.status, res.data, '完成初始化失败')
  const result = normalizeFinishResult(res.data)
  if (!result) throw invalidResponse(res.status, FINISH_ONBOARDING)
  return result
}

// ==================== 引导: 依赖资产与下载作业 ====================

export async function getOnboardingAssets(): Promise<DependenciesStatus> {
  const res = await apiGetVerbose<unknown>(`${ONBOARDING}/assets`)
  if (!res.ok) throw errorFrom(res.status, res.data, '获取依赖状态失败')
  const status = normalizeDependenciesStatus(res.data)
  if (!status) throw invalidResponse(res.status, `${ONBOARDING}/assets`)
  return status
}

export async function startAssetDownload(
  asset: string,
  setupToken?: string,
  currentPassword?: string,
): Promise<DownloadJob> {
  const body: Record<string, unknown> = { asset }
  if (currentPassword) body.password = currentPassword
  const res = await apiPostVerbose<unknown>(
    `${ONBOARDING}/assets/download`,
    body,
    setupHeaders(setupToken),
  )
  if (!res.ok) throw errorFrom(res.status, res.data, '启动资产下载失败')
  const job = normalizeDownloadJob(
    isRecord(res.data) ? res.data.job : undefined,
  )
  if (!job) throw invalidResponse(res.status, `${ONBOARDING}/assets/download`)
  return job
}

export async function getOnboardingJob(jobId: string): Promise<DownloadJob> {
  const path = `${ONBOARDING}/jobs/${encodeURIComponent(jobId)}`
  const res = await apiGetVerbose<unknown>(path)
  if (!res.ok) throw errorFrom(res.status, res.data, '获取下载作业失败')
  const job = normalizeDownloadJob(
    isRecord(res.data) ? res.data.job : undefined,
  )
  if (!job) throw invalidResponse(res.status, path)
  return job
}

export async function cancelOnboardingJob(
  jobId: string,
  setupToken?: string,
  currentPassword?: string,
): Promise<DownloadJob> {
  const path = `${ONBOARDING}/jobs/${encodeURIComponent(jobId)}/cancel`
  const body: Record<string, unknown> = {}
  if (currentPassword) body.password = currentPassword
  const res = await apiPostVerbose<unknown>(
    path,
    body,
    setupHeaders(setupToken),
  )
  if (!res.ok) throw errorFrom(res.status, res.data, '取消下载作业失败')
  const job = normalizeDownloadJob(
    isRecord(res.data) ? res.data.job : undefined,
  )
  if (!job) throw invalidResponse(res.status, path)
  return job
}

export async function getKernelModels(): Promise<KernelModelCatalog> {
  const path = `${ONBOARDING}/models`
  const res = await apiGetVerbose<unknown>(path)
  if (!res.ok) throw errorFrom(res.status, res.data, '获取内核模型状态失败')
  const catalog = normalizeKernelModelCatalog(res.data)
  if (!catalog) throw invalidResponse(res.status, path)
  return catalog
}

export async function startKernelModelsDownload(
  options: KernelModelsDownloadOptions = {},
  setupToken?: string,
  currentPassword?: string,
): Promise<DownloadJob> {
  const path = `${ONBOARDING}/models/download`
  const body: Record<string, unknown> = {}
  if (options.models && options.models.length > 0) body.models = options.models
  if (options.tiers && options.tiers.length > 0) body.tiers = options.tiers
  const password = currentPassword || options.password
  if (password) body.password = password
  const res = await apiPostVerbose<unknown>(
    path,
    body,
    setupHeaders(setupToken),
  )
  if (!res.ok) throw errorFrom(res.status, res.data, '启动内核模型下载失败')
  const job = normalizeDownloadJob(
    isRecord(res.data) ? res.data.job : undefined,
  )
  if (!job) throw invalidResponse(res.status, path)
  return job
}

export async function getOnboardingStorage(): Promise<StorageSnapshot> {
  const path = `${ONBOARDING}/storage`
  const res = await apiGetVerbose<unknown>(path)
  if (!res.ok) throw errorFrom(res.status, res.data, '获取模型存储信息失败')
  const snapshot = normalizeStorageSnapshot(res.data)
  if (!snapshot) throw invalidResponse(res.status, path)
  return snapshot
}

export async function saveOnboardingStorage(
  modelsDir: string,
  setupToken?: string,
  currentPassword?: string,
): Promise<StorageSaveResult> {
  const path = `${ONBOARDING}/storage`
  const body: Record<string, unknown> = { models_dir: modelsDir }
  if (currentPassword) body.password = currentPassword
  const res = await apiPostVerbose<unknown>(path, body, setupHeaders(setupToken))
  if (!res.ok) throw errorFrom(res.status, res.data, '保存模型根目录失败')
  const result = normalizeStorageSaveResult(res.data)
  if (!result) throw invalidResponse(res.status, path)
  return result
}

// ==================== 引导: Loom ====================

export async function getLoomOnboarding(): Promise<LoomStatus> {
  const path = `${ONBOARDING}/loom`
  const res = await apiGetVerbose<unknown>(path)
  if (!res.ok) throw errorFrom(res.status, res.data, '获取 Loom 状态失败')
  const status = normalizeLoomStatus(res.data)
  if (!status) throw invalidResponse(res.status, path)
  return status
}

export async function validateLoomSelection(
  selection: LoomSelection,
): Promise<LoomValidateResult> {
  const path = `${ONBOARDING}/loom/validate`
  const res = await apiPostVerbose<unknown>(path, selection)
  if (!res.ok) throw errorFrom(res.status, res.data, '校验 Loom 选择失败')
  const result = normalizeLoomValidateResult(res.data)
  if (!result) throw invalidResponse(res.status, path)
  return result
}

export async function applyLoomSelection(
  selection: LoomSelection,
  options: LoomApplyOptions = {},
  setupToken?: string,
): Promise<LoomApplyResult> {
  const path = `${ONBOARDING}/loom/apply`
  const body: Record<string, unknown> = {
    ...selection,
    restart: options.restart === true,
  }
  if (options.currentPassword) body.current_password = options.currentPassword
  const res = await apiPostVerbose<unknown>(
    path,
    body,
    setupHeaders(setupToken),
  )
  if (!res.ok) throw errorFrom(res.status, res.data, '应用 Loom 配置失败')
  const result = normalizeLoomApplyResult(res.data)
  if (!result) throw invalidResponse(res.status, path)
  return result
}

export async function restartLoomOnboarding(
  setupToken?: string,
  currentPassword?: string,
): Promise<LoomRestartResult> {
  const path = `${ONBOARDING}/loom/restart`
  const body: Record<string, unknown> = {}
  if (currentPassword) body.current_password = currentPassword
  const res = await apiPostVerbose<unknown>(
    path,
    body,
    setupHeaders(setupToken),
  )
  if (!res.ok) throw errorFrom(res.status, res.data, '重启 Loom 失败')
  const result = normalizeLoomRestartResult(res.data)
  if (!result) throw invalidResponse(res.status, path)
  return result
}

export async function getLoomRuntime(): Promise<LoomRuntimeStatus> {
  const path = `${ONBOARDING}/loom/runtime`
  const res = await apiGetVerbose<unknown>(path)
  if (!res.ok) throw errorFrom(res.status, res.data, '获取 Loom 运行状态失败')
  const runtime = normalizeLoomRuntimeStatus(res.data)
  if (!runtime) throw invalidResponse(res.status, path)
  return runtime
}

export async function ensureLoomToken(
  setupToken?: string,
  currentPassword?: string,
): Promise<LoomTokenState> {
  const path = `${ONBOARDING}/loom/token/ensure`
  const body: Record<string, unknown> = {}
  if (currentPassword) body.current_password = currentPassword
  const res = await apiPostVerbose<unknown>(
    path,
    body,
    setupHeaders(setupToken),
  )
  if (!res.ok) throw errorFrom(res.status, res.data, '获取 Loom Token 失败')
  const tokenState = normalizeLoomTokenState(res.data)
  if (!tokenState) throw invalidResponse(res.status, path)
  return tokenState
}

export async function ensureLoomConfig(
  selection: LoomSelection,
  options: LoomConfigEnsureOptions = {},
  setupToken?: string,
): Promise<LoomConfigEnsureResult> {
  const path = `${ONBOARDING}/loom/config/ensure`
  const body: Record<string, unknown> = { ...selection }
  if (options.overwrite === true) body.overwrite = true
  if (options.credentialEnv) body.credential_env = options.credentialEnv
  if (options.currentPassword) body.current_password = options.currentPassword
  const res = await apiPostVerbose<unknown>(
    path,
    body,
    setupHeaders(setupToken),
  )
  if (!res.ok) throw errorFrom(res.status, res.data, '写入 Loom 配置失败')
  const result = normalizeLoomConfigEnsureResult(res.data)
  if (!result) throw invalidResponse(res.status, path)
  return result
}

async function postLoomRuntimeAction(
  action: 'start' | 'stop' | 'restart',
  setupToken?: string,
  currentPassword?: string,
): Promise<LoomRuntimeActionResult> {
  const path = `${ONBOARDING}/loom/${action}`
  const body: Record<string, unknown> = {}
  if (currentPassword) body.current_password = currentPassword
  const res = await apiPostVerbose<unknown>(
    path,
    body,
    setupHeaders(setupToken),
  )
  if (!res.ok) throw errorFrom(res.status, res.data, '控制 Loom 运行状态失败')
  const result = normalizeLoomRuntimeActionResult(res.data)
  if (!result) throw invalidResponse(res.status, path)
  return result
}

export function startLoomRuntime(
  setupToken?: string,
  currentPassword?: string,
): Promise<LoomRuntimeActionResult> {
  return postLoomRuntimeAction('start', setupToken, currentPassword)
}

export function stopLoomRuntime(
  setupToken?: string,
  currentPassword?: string,
): Promise<LoomRuntimeActionResult> {
  return postLoomRuntimeAction('stop', setupToken, currentPassword)
}

export function restartLoomRuntime(
  setupToken?: string,
  currentPassword?: string,
): Promise<LoomRuntimeActionResult> {
  return postLoomRuntimeAction('restart', setupToken, currentPassword)
}

// ==================== 引导: MOSS ====================

export async function getMossOnboarding(): Promise<MossStatus> {
  const path = `${ONBOARDING}/moss`
  const res = await apiGetVerbose<unknown>(path)
  if (!res.ok) throw errorFrom(res.status, res.data, '获取 MOSS 状态失败')
  const status = normalizeMossStatus(res.data)
  if (!status) throw invalidResponse(res.status, path)
  return status
}

export async function validateMossConfig(
  baseUrl?: string,
  model?: string,
): Promise<MossValidation> {
  const path = `${ONBOARDING}/moss/validate`
  const body: Record<string, unknown> = {}
  if (baseUrl) body.base_url = baseUrl
  if (model) body.model = model
  const res = await apiPostVerbose<unknown>(path, body)
  if (!res.ok) throw errorFrom(res.status, res.data, '校验 MOSS 服务失败')
  const validation = normalizeMossValidation(res.data)
  if (!validation) throw invalidResponse(res.status, path)
  return validation
}

export async function applyMossChoice(
  choice: MossChoice,
  options: MossApplyOptions = {},
  setupToken?: string,
): Promise<MossApplyResult> {
  const path = `${ONBOARDING}/moss/apply`
  const body: Record<string, unknown> = { choice }
  if (options.baseUrl) body.base_url = options.baseUrl
  if (options.model) body.model = options.model
  if (options.currentPassword) body.current_password = options.currentPassword
  const res = await apiPostVerbose<unknown>(
    path,
    body,
    setupHeaders(setupToken),
  )
  if (!res.ok) throw errorFrom(res.status, res.data, '应用 MOSS 选择失败')
  const result = normalizeMossApplyResult(res.data)
  if (!result) throw invalidResponse(res.status, path)
  return result
}

// ==================== 引导: 启动校验 ====================

const STARTUP = `${ONBOARDING}/startup`

export async function getStartupOnboarding(): Promise<StartupStatus> {
  const res = await apiGetVerbose<unknown>(STARTUP)
  if (!res.ok) throw errorFrom(res.status, res.data, '获取启动校验状态失败')
  const status = normalizeStartupStatus(res.data)
  if (!status) throw invalidResponse(res.status, STARTUP)
  return status
}

export async function attemptStartup(
  setupToken?: string,
  currentPassword?: string,
): Promise<StartupStatus> {
  return postStartupAction('attempt', setupToken, currentPassword)
}

export async function validateStartup(): Promise<StartupStatus> {
  const path = `${STARTUP}/validate`
  const res = await apiPostVerbose<unknown>(path, {})
  if (!res.ok) throw errorFrom(res.status, res.data, '执行启动校验失败')
  const status = normalizeStartupStatus(res.data)
  if (!status) throw invalidResponse(res.status, path)
  return status
}

export async function abortStartup(
  setupToken?: string,
  currentPassword?: string,
): Promise<StartupStatus> {
  return postStartupAction('abort', setupToken, currentPassword)
}

async function postStartupAction(
  action: 'attempt' | 'abort',
  setupToken?: string,
  currentPassword?: string,
): Promise<StartupStatus> {
  const path = `${STARTUP}/${action}`
  const body: Record<string, unknown> = {}
  if (currentPassword) body.password = currentPassword
  const res = await apiPostVerbose<unknown>(
    path,
    body,
    setupHeaders(setupToken),
  )
  if (!res.ok) throw errorFrom(res.status, res.data, '控制启动校验失败')
  const status = normalizeStartupStatus(res.data)
  if (!status) throw invalidResponse(res.status, path)
  return status
}

// ==================== 引导: 客户端目录 ====================

export async function getClientCatalog(): Promise<ClientCatalog> {
  const path = `${ONBOARDING}/clients`
  const res = await apiGetVerbose<unknown>(path)
  if (!res.ok) throw errorFrom(res.status, res.data, '获取客户端目录失败')
  const catalog = normalizeClientCatalog(res.data)
  if (!catalog) throw invalidResponse(res.status, path)
  return catalog
}

export async function createOtaTicket(): Promise<OtaTicket> {
  const path = '/api/ota/ticket'
  const res = await apiPostVerbose<unknown>(path, {})
  if (!res.ok) throw errorFrom(res.status, res.data, '获取下载票据失败')
  if (
    !isRecord(res.data) ||
    typeof res.data.ticket !== 'string' ||
    typeof res.data.url !== 'string'
  ) {
    throw invalidResponse(res.status, path)
  }
  return {
    ticket: res.data.ticket,
    url: res.data.url,
    expires_at: asFiniteNumber(res.data.expires_at) ?? 0,
    expires_in: asFiniteNumber(res.data.expires_in) ?? 0,
    filename: asString(res.data.filename),
    source_filename: asString(res.data.source_filename),
    sha256: asString(res.data.sha256),
    size: asFiniteNumber(res.data.size) ?? 0,
  }
}
