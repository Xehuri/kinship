import { DEFAULT_IDLE_THRESHOLD_SECONDS } from '../../../shared/constants'
import type { SensorConfigPatch, SensorConfigView } from '../../../shared/types'
import { validateSensorConfigPatch } from '../../../shared/validation'

export type SensorAuthMode = 'credentials' | 'token'

export interface SensorFormState {
  enabled: boolean
  agentId: string
  agentName: string
  username: string
  hasStoredPassword: boolean
  rememberPassword: boolean
  hasBackendToken: boolean
  idleThreshold: number
  windowEnabled: boolean
  idleEnabled: boolean
  screenEnabled: boolean
  sslVerify: boolean
  sslCaFile: string
  password: string
  backendToken: string
  authMode: SensorAuthMode
}

export interface SensorFormValidation {
  ok: boolean
  message?: string
  field?: 'agentId' | 'agentName' | 'idleThreshold'
}

function randomSuffix(): string {
  const suffix = Math.random().toString(36).slice(2, 8)
  return suffix.padEnd(6, '0')
}

export function createAgentId(): string {
  return `pc-${randomSuffix()}`
}

export function createEmptySensorConfigView(): SensorConfigView {
  return {
    enabled: true,
    serverUrl: '',
    agentId: '',
    agentName: '我的电脑',
    username: '',
    hasStoredPassword: false,
    rememberPassword: true,
    hasBackendToken: false,
    idleThreshold: DEFAULT_IDLE_THRESHOLD_SECONDS,
    windowEnabled: true,
    idleEnabled: true,
    screenEnabled: true,
    sslVerify: true,
    sslCaFile: '',
  }
}

export function createSensorForm(view: SensorConfigView): SensorFormState {
  return {
    enabled: view.enabled,
    agentId: view.agentId.trim().length > 0 ? view.agentId : createAgentId(),
    agentName: view.agentName.trim().length > 0 ? view.agentName : '我的电脑',
    username: view.username,
    hasStoredPassword: view.hasStoredPassword,
    rememberPassword: view.rememberPassword,
    hasBackendToken: view.hasBackendToken,
    idleThreshold: view.idleThreshold,
    windowEnabled: view.windowEnabled,
    idleEnabled: view.idleEnabled,
    screenEnabled: view.screenEnabled,
    sslVerify: view.sslVerify,
    sslCaFile: view.sslCaFile,
    password: '',
    backendToken: '',
    authMode: view.hasBackendToken && !view.hasStoredPassword ? 'token' : 'credentials',
  }
}

export function buildSensorPatch(form: SensorFormState, serverUrl: string): SensorConfigPatch {
  const patch: SensorConfigPatch = {
    enabled: form.enabled,
    serverUrl,
    agentId: form.agentId.trim(),
    agentName: form.agentName.trim(),
    idleThreshold: Math.round(form.idleThreshold),
    windowEnabled: form.windowEnabled,
    idleEnabled: form.idleEnabled,
    screenEnabled: form.screenEnabled,
    sslVerify: form.sslVerify,
    sslCaFile: form.sslCaFile.trim(),
  }

  if (form.authMode === 'credentials') {
    patch.username = form.username.trim()
    patch.rememberPassword = form.rememberPassword
    if (form.password.length > 0) patch.password = form.password
  } else if (form.backendToken.length > 0) {
    patch.backendToken = form.backendToken
  }

  return patch
}

export function validateSensorForm(form: SensorFormState, serverUrl: string): SensorFormValidation {
  const agentId = form.agentId.trim()
  if (agentId.length < 1 || agentId.length > 64) {
    return { ok: false, message: '设备 ID 需为 1-64 个字符', field: 'agentId' }
  }

  if (form.agentName.trim().length < 1) {
    return { ok: false, message: '请填写设备名称', field: 'agentName' }
  }

  if (
    !Number.isFinite(form.idleThreshold) ||
    Math.round(form.idleThreshold) < 30 ||
    Math.round(form.idleThreshold) > 3600
  ) {
    return { ok: false, message: '无人判定阈值需在 30-3600 秒之间', field: 'idleThreshold' }
  }

  const result = validateSensorConfigPatch(buildSensorPatch(form, serverUrl))
  if (!result.ok) return { ok: false, message: result.message }

  return { ok: true }
}
