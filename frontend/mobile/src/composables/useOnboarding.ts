/**
 * 引导初始化 Composable (N15)
 *
 * 模块级单例只读状态 + 显式动作: refresh() 读取 status/preflight,
 * recordStep()/action() 仅在调用方明确触发时写后端; 不做任何自动推进。
 *
 * 使用方式:
 *   const { status, preflight, currentStep, refresh, recordStep } = useOnboarding()
 *   await refresh()
 *   await recordStep('server', 'completed', { port: 8768 }, setupToken)
 */

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { onLogout } from '@/composables/useApi'
import {
  SystemApiError,
  applyLoomSelection,
  applyMossChoice,
  cancelOnboardingJob,
  configureMoss as postMossConfig,
  configureQq as postQqConfig,
  configureXiaomi as postXiaomiConfig,
  ensureLoomConfig as postLoomConfigEnsure,
  ensureLoomToken as postLoomTokenEnsure,
  finishOnboarding as postFinish,
  getClientCatalog,
  getLoomOnboarding,
  getLoomRuntime,
  getMossConfig,
  getMossOnboarding,
  getOnboardingAssets,
  getOnboardingFinish,
  getOnboardingJob,
  getOnboardingPreflight,
  getOnboardingStatus,
  getOnboardingStorage,
  getQqOnboarding,
  getStartupOnboarding,
  getXiaomiOnboarding,
  attemptStartup as postStartupAttempt,
  abortStartup as postStartupAbort,
  validateStartup as postStartupValidation,
  pollXiaomiQr as postXiaomiQrPoll,
  postOnboardingState,
  requestXiaomiQr as postXiaomiQrRequest,
  restartLoomOnboarding,
  restartLoomRuntime as postLoomRuntimeRestart,
  runOnboardingAction,
  saveOnboardingStorage as postStorageSave,
  setupLoom as postLoomSetup,
  startAssetDownload as postAssetDownload,
  startLoomRuntime as postLoomRuntimeStart,
  stopLoomRuntime as postLoomRuntimeStop,
  validateLoomSelection as postLoomValidation,
  validateMossConfig,
  validateQqConfig as postQqValidation,
} from '@/api/system'
import { fallbackOnboardingSteps } from '@/config/onboardingSteps'
import {
  normalizeFinishClosing,
  normalizeFinishGroups,
  normalizeStartupStatus,
} from '@/api/systemOnboardingNormalize'
import type {
  ClientCatalog,
  DependenciesStatus,
  DownloadJob,
  FinishClosing,
  FinishGroups,
  FinishResult,
  FinishStatus,
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
  OnboardingActionResult,
  OnboardingActionKind,
  OnboardingActivation,
  OnboardingState,
  OnboardingStatus,
  OnboardingStepInfo,
  OnboardingStepStatus,
  PreflightResult,
  QqConfigRequest,
  QqConfigResult,
  QqStatus,
  QqValidateResult,
  StartupStatus,
  StorageSaveResult,
  StorageSnapshot,
  XiaomiConfigRequest,
  XiaomiQrPollResult,
  XiaomiQrResult,
  XiaomiStatus,
} from '@/api/system'

export interface UseOnboardingReturn {
  status: Ref<OnboardingStatus | null>
  preflight: Ref<PreflightResult | null>
  activation: Ref<OnboardingActivation | null>
  loading: Ref<boolean>
  error: Ref<SystemApiError | null>
  currentStep: ComputedRef<string | null>
  completedSteps: ComputedRef<string[]>
  skippedSteps: ComputedRef<string[]>
  steps: ComputedRef<OnboardingStepInfo[]>
  bootstrap: ComputedRef<boolean>
  degradedReasons: ComputedRef<string[]>
  needsSetup: ComputedRef<boolean>
  onboardingComplete: ComputedRef<boolean>
  canProceed: ComputedRef<boolean>
  assets: Ref<DependenciesStatus | null>
  assetsLoading: Ref<boolean>
  job: Ref<DownloadJob | null>
  loom: Ref<LoomStatus | null>
  loomRuntime: Ref<LoomRuntimeStatus | null>
  loomValidation: Ref<LoomValidateResult | null>
  loomApplyResult: Ref<LoomApplyResult | null>
  moss: Ref<MossStatus | null>
  mossValidation: Ref<MossValidation | null>
  mossApplyResult: Ref<MossApplyResult | null>
  xiaomi: Ref<XiaomiStatus | null>
  qq: Ref<QqStatus | null>
  mossConfig: Ref<MossConfig | null>
  loomSetupResult: Ref<LoomSetupResult | null>
  finish: Ref<FinishStatus | null>
  finishGroups: Ref<FinishGroups | null>
  finishClosing: Ref<FinishClosing | null>
  finishError: Ref<SystemApiError | null>
  clients: Ref<ClientCatalog | null>
  startup: Ref<StartupStatus | null>
  startupLoading: Ref<boolean>
  storage: Ref<StorageSnapshot | null>
  storageLoading: Ref<boolean>
  clear: () => void
  refresh: () => Promise<void>
  recordStep: (
    stepId: string,
    stepStatus: OnboardingStepStatus,
    data?: Record<string, unknown>,
    setupToken?: string,
  ) => Promise<OnboardingState | null>
  action: (
    kind: OnboardingActionKind,
    overwrite?: boolean,
    setupToken?: string,
    currentPassword?: string,
  ) => Promise<OnboardingActionResult | null>
  loadAssets: () => Promise<DependenciesStatus | null>
  startAssetDownload: (
    asset: string,
    setupToken?: string,
    currentPassword?: string,
  ) => Promise<DownloadJob | null>
  loadJob: (jobId: string) => Promise<DownloadJob | null>
  cancelJob: (
    setupToken?: string,
    currentPassword?: string,
  ) => Promise<DownloadJob | null>
  loadLoom: () => Promise<LoomStatus | null>
  loadLoomRuntime: () => Promise<LoomRuntimeStatus | null>
  ensureLoomToken: (
    setupToken?: string,
    currentPassword?: string,
  ) => Promise<LoomTokenState | null>
  ensureLoomConfig: (
    selection: LoomSelection,
    options?: LoomConfigEnsureOptions,
    setupToken?: string,
  ) => Promise<LoomConfigEnsureResult | null>
  startLoomRuntime: (
    setupToken?: string,
    currentPassword?: string,
  ) => Promise<LoomRuntimeActionResult | null>
  stopLoomRuntime: (
    setupToken?: string,
    currentPassword?: string,
  ) => Promise<LoomRuntimeActionResult | null>
  restartLoomRuntime: (
    setupToken?: string,
    currentPassword?: string,
  ) => Promise<LoomRuntimeActionResult | null>
  validateLoom: (
    selection: LoomSelection,
  ) => Promise<LoomValidateResult | null>
  applyLoom: (
    selection: LoomSelection,
    options?: LoomApplyOptions,
    setupToken?: string,
  ) => Promise<LoomApplyResult | null>
  restartLoom: (
    setupToken?: string,
    currentPassword?: string,
  ) => Promise<LoomRestartResult | null>
  loadMoss: () => Promise<MossStatus | null>
  validateMoss: (
    baseUrl?: string,
    model?: string,
  ) => Promise<MossValidation | null>
  applyMoss: (
    choice: MossChoice,
    options?: MossApplyOptions,
    setupToken?: string,
  ) => Promise<MossApplyResult | null>
  loadXiaomi: () => Promise<XiaomiStatus | null>
  configureXiaomi: (
    body: XiaomiConfigRequest,
    setupToken?: string,
  ) => Promise<XiaomiStatus | null>
  requestXiaomiQr: (
    setupToken?: string,
    currentPassword?: string,
  ) => Promise<XiaomiQrResult | null>
  pollXiaomiQr: (
    lp: string,
    setupToken?: string,
    currentPassword?: string,
  ) => Promise<XiaomiQrPollResult | null>
  loadQq: () => Promise<QqStatus | null>
  validateQq: (
    body: QqConfigRequest,
    setupToken?: string,
  ) => Promise<QqValidateResult | null>
  configureQq: (
    body: QqConfigRequest,
    setupToken?: string,
  ) => Promise<QqConfigResult | null>
  loadMossConfig: () => Promise<MossConfig | null>
  configureMoss: (
    body: MossConfigRequest,
    setupToken?: string,
  ) => Promise<MossConfig | null>
  setupLoom: (
    body: LoomSetupRequest,
    setupToken?: string,
  ) => Promise<LoomSetupResult | null>
  loadFinish: () => Promise<FinishStatus | null>
  runFinish: (
    allowDegraded: boolean,
    currentPassword?: string,
    setupToken?: string,
  ) => Promise<FinishResult | null>
  loadClients: () => Promise<ClientCatalog | null>
  loadStartup: () => Promise<StartupStatus | null>
  attemptStartup: (
    setupToken?: string,
    currentPassword?: string,
  ) => Promise<StartupStatus | null>
  validateStartup: () => Promise<StartupStatus | null>
  abortStartup: (
    setupToken?: string,
    currentPassword?: string,
  ) => Promise<StartupStatus | null>
  loadStorage: () => Promise<StorageSnapshot | null>
  saveStorage: (
    modelsDir: string,
    setupToken?: string,
    currentPassword?: string,
  ) => Promise<StorageSaveResult | null>
  isStepCompleted: (stepId: string) => boolean
  isStepSkipped: (stepId: string) => boolean
}

// ==================== 模块级状态 ====================

const status = ref<OnboardingStatus | null>(null)
const preflight = ref<PreflightResult | null>(null)
const activation = ref<OnboardingActivation | null>(null)
const loading = ref(false)
const error = ref<SystemApiError | null>(null)

const assets = ref<DependenciesStatus | null>(null)
const assetsLoading = ref(false)
const job = ref<DownloadJob | null>(null)
const loom = ref<LoomStatus | null>(null)
const loomRuntime = ref<LoomRuntimeStatus | null>(null)
const loomValidation = ref<LoomValidateResult | null>(null)
const loomApplyResult = ref<LoomApplyResult | null>(null)
const moss = ref<MossStatus | null>(null)
const mossValidation = ref<MossValidation | null>(null)
const mossApplyResult = ref<MossApplyResult | null>(null)
const xiaomi = ref<XiaomiStatus | null>(null)
const qq = ref<QqStatus | null>(null)
const mossConfig = ref<MossConfig | null>(null)
const loomSetupResult = ref<LoomSetupResult | null>(null)
const finish = ref<FinishStatus | null>(null)
const finishGroups = ref<FinishGroups | null>(null)
const finishClosing = ref<FinishClosing | null>(null)
const finishError = ref<SystemApiError | null>(null)
const clients = ref<ClientCatalog | null>(null)
const startup = ref<StartupStatus | null>(null)
const startupLoading = ref(false)
const storage = ref<StorageSnapshot | null>(null)
const storageLoading = ref(false)

function clear(): void {
  status.value = null
  preflight.value = null
  activation.value = null
  loading.value = false
  error.value = null
  assets.value = null
  assetsLoading.value = false
  job.value = null
  loom.value = null
  loomRuntime.value = null
  loomValidation.value = null
  loomApplyResult.value = null
  moss.value = null
  mossValidation.value = null
  mossApplyResult.value = null
  xiaomi.value = null
  qq.value = null
  mossConfig.value = null
  loomSetupResult.value = null
  finish.value = null
  finishGroups.value = null
  finishClosing.value = null
  finishError.value = null
  clients.value = null
  startup.value = null
  startupLoading.value = false
  storage.value = null
  storageLoading.value = false
}

onLogout(clear)

const currentStep = computed<string | null>(
  () => status.value?.state.current_step || null,
)
const completedSteps = computed<string[]>(
  () => status.value?.state.completed_steps ?? [],
)
const skippedSteps = computed<string[]>(
  () => status.value?.state.skipped_steps ?? [],
)
const steps = computed<OnboardingStepInfo[]>(() => {
  const authoritative = status.value?.steps
  if (authoritative && authoritative.length > 0) return authoritative
  return fallbackOnboardingSteps(currentStep.value)
})
const bootstrap = computed<boolean>(() => status.value?.bootstrap ?? false)
const degradedReasons = computed<string[]>(
  () => status.value?.degraded_reasons ?? [],
)
const needsSetup = computed<boolean>(() => status.value?.needs_setup ?? false)
const onboardingComplete = computed<boolean>(
  () => status.value?.onboarding_complete ?? false,
)
const canProceed = computed<boolean>(
  () => preflight.value?.can_proceed ?? false,
)

// ==================== 内部工具 ====================

function toSystemApiError(value: unknown): SystemApiError {
  if (value instanceof SystemApiError) return value
  return new SystemApiError(
    0,
    'unknown_error',
    value instanceof Error ? value.message : String(value),
  )
}

async function guard<T>(action: () => Promise<T>): Promise<T | null> {
  error.value = null
  try {
    return await action()
  } catch (e) {
    error.value = toSystemApiError(e)
    return null
  }
}

async function refresh(): Promise<void> {
  loading.value = true
  error.value = null

  try {
    const [statusResult, preflightResult] = await Promise.allSettled([
      getOnboardingStatus(),
      getOnboardingPreflight(),
    ])

    if (statusResult.status === 'fulfilled') {
      status.value = statusResult.value
    } else {
      error.value = toSystemApiError(statusResult.reason)
    }

    if (preflightResult.status === 'fulfilled') {
      preflight.value = preflightResult.value
    } else if (error.value === null) {
      error.value = toSystemApiError(preflightResult.reason)
    }
  } finally {
    loading.value = false
  }
}

async function recordStep(
  stepId: string,
  stepStatus: OnboardingStepStatus,
  data?: Record<string, unknown>,
  setupToken?: string,
): Promise<OnboardingState | null> {
  error.value = null
  try {
    const result = await postOnboardingState(
      {
        step_id: stepId,
        status: stepStatus,
        ...(data ? { data } : {}),
      },
      setupToken,
    )

    if (status.value) {
      status.value = { ...status.value, state: result.state }
    }
    activation.value = result.activation ?? null

    return result.state
  } catch (e) {
    error.value = toSystemApiError(e)
    return null
  }
}

async function action(
  kind: OnboardingActionKind,
  overwrite?: boolean,
  setupToken?: string,
  currentPassword?: string,
): Promise<OnboardingActionResult | null> {
  error.value = null
  try {
    return await runOnboardingAction(
      {
        action: kind,
        ...(overwrite === undefined ? {} : { overwrite }),
      },
      setupToken,
      currentPassword,
    )
  } catch (e) {
    error.value = toSystemApiError(e)
    return null
  }
}

async function loadAssets(): Promise<DependenciesStatus | null> {
  assetsLoading.value = true
  try {
    const result = await guard(getOnboardingAssets)
    if (result) assets.value = result
    return result
  } finally {
    assetsLoading.value = false
  }
}

async function startAssetDownload(
  asset: string,
  setupToken?: string,
  currentPassword?: string,
): Promise<DownloadJob | null> {
  const result = await guard(() =>
    postAssetDownload(asset, setupToken, currentPassword),
  )
  if (result) job.value = result
  return result
}

async function loadJob(jobId: string): Promise<DownloadJob | null> {
  const result = await guard(() => getOnboardingJob(jobId))
  if (result) job.value = result
  return result
}

async function cancelJob(
  setupToken?: string,
  currentPassword?: string,
): Promise<DownloadJob | null> {
  const active = job.value
  if (!active) return null
  const result = await guard(() =>
    cancelOnboardingJob(active.id, setupToken, currentPassword),
  )
  if (result) job.value = result
  return result
}

async function loadLoom(): Promise<LoomStatus | null> {
  const result = await guard(getLoomOnboarding)
  if (result) loom.value = result
  return result
}

async function loadLoomRuntime(): Promise<LoomRuntimeStatus | null> {
  const result = await guard(getLoomRuntime)
  if (result) loomRuntime.value = result
  return result
}

async function ensureLoomToken(
  setupToken?: string,
  currentPassword?: string,
): Promise<LoomTokenState | null> {
  const result = await guard(() =>
    postLoomTokenEnsure(setupToken, currentPassword),
  )
  if (result) {
    if (loomRuntime.value) {
      loomRuntime.value = { ...loomRuntime.value, token_state: result }
    }
    if (loom.value) {
      loom.value = {
        ...loom.value,
        found: result.found,
        source: result.source,
        fingerprint: result.fingerprint,
        detail: result.detail,
      }
    }
  }
  return result
}

async function ensureLoomConfig(
  selection: LoomSelection,
  options?: LoomConfigEnsureOptions,
  setupToken?: string,
): Promise<LoomConfigEnsureResult | null> {
  const result = await guard(() =>
    postLoomConfigEnsure(selection, options, setupToken),
  )
  if (result && loomRuntime.value) {
    loomRuntime.value = {
      ...loomRuntime.value,
      managed: result.managed,
      config_exists: result.exists,
    }
  }
  return result
}

async function startLoomRuntime(
  setupToken?: string,
  currentPassword?: string,
): Promise<LoomRuntimeActionResult | null> {
  return guard(() => postLoomRuntimeStart(setupToken, currentPassword))
}

async function stopLoomRuntime(
  setupToken?: string,
  currentPassword?: string,
): Promise<LoomRuntimeActionResult | null> {
  return guard(() => postLoomRuntimeStop(setupToken, currentPassword))
}

async function restartLoomRuntime(
  setupToken?: string,
  currentPassword?: string,
): Promise<LoomRuntimeActionResult | null> {
  return guard(() => postLoomRuntimeRestart(setupToken, currentPassword))
}

async function validateLoom(
  selection: LoomSelection,
): Promise<LoomValidateResult | null> {
  const result = await guard(() => postLoomValidation(selection))
  if (result) loomValidation.value = result
  return result
}

async function applyLoom(
  selection: LoomSelection,
  options?: LoomApplyOptions,
  setupToken?: string,
): Promise<LoomApplyResult | null> {
  const result = await guard(() =>
    applyLoomSelection(selection, options, setupToken),
  )
  if (result) loomApplyResult.value = result
  return result
}

async function restartLoom(
  setupToken?: string,
  currentPassword?: string,
): Promise<LoomRestartResult | null> {
  return guard(() => restartLoomOnboarding(setupToken, currentPassword))
}

async function loadMoss(): Promise<MossStatus | null> {
  const result = await guard(getMossOnboarding)
  if (result) moss.value = result
  return result
}

async function validateMoss(
  baseUrl?: string,
  model?: string,
): Promise<MossValidation | null> {
  const result = await guard(() => validateMossConfig(baseUrl, model))
  if (result) mossValidation.value = result
  return result
}

async function applyMoss(
  choice: MossChoice,
  options?: MossApplyOptions,
  setupToken?: string,
): Promise<MossApplyResult | null> {
  const result = await guard(() => applyMossChoice(choice, options, setupToken))
  if (result) mossApplyResult.value = result
  return result
}

async function loadXiaomi(): Promise<XiaomiStatus | null> {
  const result = await guard(getXiaomiOnboarding)
  if (result) xiaomi.value = result
  return result
}

async function configureXiaomi(
  body: XiaomiConfigRequest,
  setupToken?: string,
): Promise<XiaomiStatus | null> {
  const result = await guard(() => postXiaomiConfig(body, setupToken))
  if (result) xiaomi.value = result
  return result
}

function requestXiaomiQr(
  setupToken?: string,
  currentPassword?: string,
): Promise<XiaomiQrResult | null> {
  return guard(() => postXiaomiQrRequest(setupToken, currentPassword))
}

function pollXiaomiQr(
  lp: string,
  setupToken?: string,
  currentPassword?: string,
): Promise<XiaomiQrPollResult | null> {
  return guard(() => postXiaomiQrPoll(lp, setupToken, currentPassword))
}

async function loadQq(): Promise<QqStatus | null> {
  const result = await guard(getQqOnboarding)
  if (result) qq.value = result
  return result
}

function validateQq(
  body: QqConfigRequest,
  setupToken?: string,
): Promise<QqValidateResult | null> {
  return guard(() => postQqValidation(body, setupToken))
}

async function configureQq(
  body: QqConfigRequest,
  setupToken?: string,
): Promise<QqConfigResult | null> {
  const result = await guard(() => postQqConfig(body, setupToken))
  if (result) qq.value = result
  return result
}

async function loadMossConfig(): Promise<MossConfig | null> {
  const result = await guard(getMossConfig)
  if (result) mossConfig.value = result
  return result
}

async function configureMoss(
  body: MossConfigRequest,
  setupToken?: string,
): Promise<MossConfig | null> {
  const result = await guard(() => postMossConfig(body, setupToken))
  if (result) mossConfig.value = result
  return result
}

async function setupLoom(
  body: LoomSetupRequest,
  setupToken?: string,
): Promise<LoomSetupResult | null> {
  const result = await guard(() => postLoomSetup(body, setupToken))
  if (result) loomSetupResult.value = result
  return result
}

async function loadFinish(): Promise<FinishStatus | null> {
  finishError.value = null
  const result = await guard(getOnboardingFinish)
  if (result) {
    finish.value = result
    finishGroups.value = result.groups
    finishClosing.value = result.closing
  } else {
    finishError.value = error.value
  }
  return result
}

async function runFinish(
  allowDegraded: boolean,
  currentPassword?: string,
  setupToken?: string,
): Promise<FinishResult | null> {
  finishError.value = null
  try {
    const result = await postFinish(
      allowDegraded,
      currentPassword,
      setupToken,
    )
    finishGroups.value = result.groups
    finishClosing.value = result.closing
    if (finish.value) {
      finish.value = {
        ...finish.value,
        activation: result.activation,
        groups: result.groups,
        closing: result.closing,
        finish: {
          groups: result.groups,
          activation: result.activation,
        },
      }
    }
    return result
  } catch (e) {
    const apiError = toSystemApiError(e)
    finishError.value = apiError
    const groups = normalizeFinishGroups(apiError.data.groups)
    const closing = normalizeFinishClosing(apiError.data.closing)
    if (groups) finishGroups.value = groups
    if (closing) finishClosing.value = closing
    return null
  }
}

async function loadClients(): Promise<ClientCatalog | null> {
  const result = await guard(getClientCatalog)
  if (result) clients.value = result
  return result
}

async function runStartupAction(
  action: () => Promise<StartupStatus>,
): Promise<StartupStatus | null> {
  error.value = null
  try {
    const result = await action()
    startup.value = result
    return result
  } catch (e) {
    const apiError = toSystemApiError(e)
    const recovered = normalizeStartupStatus(apiError.data)
    if (recovered) startup.value = recovered
    error.value = apiError
    return null
  }
}

async function loadStartup(): Promise<StartupStatus | null> {
  startupLoading.value = true
  try {
    const result = await guard(getStartupOnboarding)
    if (result) startup.value = result
    return result
  } finally {
    startupLoading.value = false
  }
}

function attemptStartup(
  setupToken?: string,
  currentPassword?: string,
): Promise<StartupStatus | null> {
  return runStartupAction(() => postStartupAttempt(setupToken, currentPassword))
}

function validateStartup(): Promise<StartupStatus | null> {
  return runStartupAction(postStartupValidation)
}

function abortStartup(
  setupToken?: string,
  currentPassword?: string,
): Promise<StartupStatus | null> {
  return runStartupAction(() => postStartupAbort(setupToken, currentPassword))
}

async function loadStorage(): Promise<StorageSnapshot | null> {
  storageLoading.value = true
  try {
    const result = await guard(getOnboardingStorage)
    if (result) storage.value = result
    return result
  } finally {
    storageLoading.value = false
  }
}

async function saveStorage(
  modelsDir: string,
  setupToken?: string,
  currentPassword?: string,
): Promise<StorageSaveResult | null> {
  const result = await guard(() =>
    postStorageSave(modelsDir, setupToken, currentPassword),
  )
  if (result) storage.value = result
  return result
}

function isStepCompleted(stepId: string): boolean {
  return completedSteps.value.includes(stepId)
}

function isStepSkipped(stepId: string): boolean {
  return skippedSteps.value.includes(stepId)
}

export function useOnboarding(): UseOnboardingReturn {
  return {
    status,
    preflight,
    activation,
    loading,
    error,
    currentStep,
    completedSteps,
    skippedSteps,
    steps,
    bootstrap,
    degradedReasons,
    needsSetup,
    onboardingComplete,
    canProceed,
    assets,
    assetsLoading,
    job,
    loom,
    loomRuntime,
    loomValidation,
    loomApplyResult,
    moss,
    mossValidation,
    mossApplyResult,
    xiaomi,
    qq,
    mossConfig,
    loomSetupResult,
    finish,
    finishGroups,
    finishClosing,
    finishError,
    clients,
    startup,
    startupLoading,
    storage,
    storageLoading,
    clear,
    refresh,
    recordStep,
    action,
    loadAssets,
    startAssetDownload,
    loadJob,
    cancelJob,
    loadLoom,
    loadLoomRuntime,
    ensureLoomToken,
    ensureLoomConfig,
    startLoomRuntime,
    stopLoomRuntime,
    restartLoomRuntime,
    validateLoom,
    applyLoom,
    restartLoom,
    loadMoss,
    validateMoss,
    applyMoss,
    loadXiaomi,
    configureXiaomi,
    requestXiaomiQr,
    pollXiaomiQr,
    loadQq,
    validateQq,
    configureQq,
    loadMossConfig,
    configureMoss,
    setupLoom,
    loadFinish,
    runFinish,
    loadClients,
    loadStartup,
    attemptStartup,
    validateStartup,
    abortStartup,
    loadStorage,
    saveStorage,
    isStepCompleted,
    isStepSkipped,
  }
}
