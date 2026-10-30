import type { SensorStatus } from '../../../shared/types'
import { formatCount, formatDateTime } from './format'
import { sensorStateMeta } from './sensor-status'

export type HealthTone = 'ok' | 'warn' | 'danger' | 'neutral'

export interface SensorHealthView {
  tone: HealthTone
  title: string
  detail: string
  live: boolean
  canTestLogin: boolean
  canRestart: boolean
}

export interface SensorConnectionView {
  tone: HealthTone
  label: string
}

export interface LoginTestView {
  success: boolean
  message: string
  authError?: string
}

function isLive(state: SensorStatus['state'] | undefined): boolean {
  return state === 'running' || state === 'external'
}

function loginDetail(status: SensorStatus): string {
  const parts = [`待上传队列 ${formatCount(status.queueSize)} 条`]
  parts.push(
    status.lastEventAt
      ? `最后事件 ${formatDateTime(status.lastEventAt)}`
      : '尚无上报事件',
  )
  return parts.join(' · ')
}

export function buildSensorHealth(
  status: SensorStatus | null | undefined,
  statusError: string | null | undefined,
  loading = false,
): SensorHealthView {
  if (statusError) {
    return {
      tone: 'danger',
      title: '无法读取采集端状态',
      detail: statusError,
      live: false,
      canTestLogin: false,
      canRestart: true,
    }
  }

  if (!status) {
    return {
      tone: 'neutral',
      title: loading ? '正在读取采集端状态' : '尚未读取采集端状态',
      detail: loading ? '正在连接本机 PC 采集端…' : '打开设置后会读取采集端状态。',
      live: false,
      canTestLogin: false,
      canRestart: false,
    }
  }

  const meta = sensorStateMeta(status.state)

  if (isLive(status.state)) {
    if (status.loggedIn === true) {
      return {
        tone: 'ok',
        title: '已连接服务器',
        detail: loginDetail(status),
        live: status.state === 'running',
        canTestLogin: true,
        canRestart: false,
      }
    }
    if (status.authError) {
      return {
        tone: 'danger',
        title: '登录失败',
        detail: status.authError,
        live: status.state === 'running',
        canTestLogin: true,
        canRestart: false,
      }
    }
    return {
      tone: 'warn',
      title: '采集端已运行，尚未登录服务器',
      detail: 'PC 采集端正在本机运行，但还没有拿到服务器 Token。可测试登录，或检查账号与服务器地址。',
      live: status.state === 'running',
      canTestLogin: true,
      canRestart: false,
    }
  }

  if (status.state === 'runtime-missing') {
    return {
      tone: 'danger',
      title: '缺少 PC 采集端运行时',
      detail: status.lastError ?? meta.description,
      live: false,
      canTestLogin: false,
      canRestart: false,
    }
  }

  if (status.state === 'crashed' || status.state === 'conflict') {
    return {
      tone: 'danger',
      title: status.state === 'crashed' ? '采集端已崩溃' : '采集端端口冲突',
      detail: status.lastError ?? meta.description,
      live: false,
      canTestLogin: false,
      canRestart: true,
    }
  }

  if (status.state === 'starting' || status.state === 'stopping') {
    return {
      tone: 'warn',
      title: meta.label,
      detail: status.lastError ?? meta.description,
      live: false,
      canTestLogin: false,
      canRestart: false,
    }
  }

  return {
    tone: 'neutral',
    title: '采集端未运行',
    detail: status.lastError ?? meta.description,
    live: false,
    canTestLogin: false,
    canRestart: false,
  }
}

export function sensorConnectionView(
  status: SensorStatus | null | undefined,
): SensorConnectionView {
  if (!status || !isLive(status.state)) {
    return { tone: 'neutral', label: '未连接' }
  }
  if (status.loggedIn === true) {
    return { tone: 'ok', label: '已登录' }
  }
  if (status.authError) {
    return { tone: 'danger', label: '登录失败' }
  }
  return { tone: 'warn', label: '未登录' }
}

export function authErrorTitle(authError: string | undefined): string {
  if (!authError) return '登录失败'
  if (authError.includes('密码') || authError.includes('用户名')) {
    return '账号或密码错误'
  }
  if (authError.includes('无法连接')) {
    return '无法连接服务器'
  }
  if (/token/i.test(authError)) {
    return 'Token 失效'
  }
  return '登录失败'
}

export function loginTestDetail(result: LoginTestView): string {
  const parts: string[] = []
  const message = result.message.trim()
  if (message.length > 0 && message !== '登录成功' && message !== '登录失败') {
    parts.push(message)
  }
  if (result.authError && !message.includes(result.authError)) {
    parts.push(`原因：${result.authError}`)
  }
  return parts.join(' · ')
}
