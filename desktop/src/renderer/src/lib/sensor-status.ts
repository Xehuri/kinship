import type { SensorState } from '../../../shared/types'

export type StatusTone = 'ok' | 'warn' | 'danger' | 'neutral' | 'accent'

export interface SensorStateMeta {
  label: string
  tone: StatusTone
  description: string
}

const STATES: Record<SensorState, SensorStateMeta> = {
  unconfigured: {
    label: '未配置',
    tone: 'neutral',
    description: '完成服务器与采集端配置后即可启动。',
  },
  stopped: {
    label: '已停止',
    tone: 'neutral',
    description: '采集端当前未运行，可手动重启。',
  },
  starting: {
    label: '启动中',
    tone: 'warn',
    description: '采集端正在启动，请稍候。',
  },
  running: {
    label: '运行中',
    tone: 'ok',
    description: '采集端正在采集并上报 PC 状态。',
  },
  external: {
    label: '外部实例',
    tone: 'accent',
    description: '检测到由其他进程启动的采集端实例。',
  },
  conflict: {
    label: '端口冲突',
    tone: 'danger',
    description: '采集端端口被占用，可能已有另一个实例在运行。',
  },
  'runtime-missing': {
    label: '缺少运行时',
    tone: 'danger',
    description: '未找到内置的 PC 采集端运行时，安装包可能不完整。',
  },
  crashed: {
    label: '已崩溃',
    tone: 'danger',
    description: '采集端进程意外退出，可查看日志后重启。',
  },
  stopping: {
    label: '停止中',
    tone: 'warn',
    description: '采集端正在停止。',
  },
}

export function sensorStateMeta(state: SensorState | null | undefined): SensorStateMeta {
  if (!state) {
    return {
      label: '未知',
      tone: 'neutral',
      description: '尚未读取到采集端状态。',
    }
  }
  return STATES[state]
}
