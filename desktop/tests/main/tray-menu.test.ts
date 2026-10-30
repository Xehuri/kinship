// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { SensorStatus } from '../../src/shared/types'
import {
  buildTrayMenuTemplate,
  trayStateLabel,
  type TrayMenuActions,
} from '../../src/main/shell/tray'

function makeStatus(state: SensorStatus['state']): SensorStatus {
  return {
    state,
    enabled: state === 'running',
    running: state === 'running' || state === 'external',
    port: 18888,
  }
}

function makeActions(): TrayMenuActions {
  return {
    openMain: vi.fn(),
    openSettings: vi.fn(),
    openSensorPanel: vi.fn(),
    restartSensor: vi.fn(),
    openLogs: vi.fn(),
    quit: vi.fn(),
  }
}

describe('tray menu', () => {
  it('maps every sensor state to a Chinese label', () => {
    expect(trayStateLabel('running')).toBe('运行中')
    expect(trayStateLabel('external')).toBe('外部实例')
    expect(trayStateLabel('runtime-missing')).toBe('缺少运行时')
    expect(trayStateLabel('conflict')).toBe('端口冲突')
    expect(trayStateLabel(undefined)).toBe('未知')
  })

  it('builds the expected menu labels and disables the status row', () => {
    const template = buildTrayMenuTemplate(makeStatus('running'), makeActions())
    const labels = template.map((item) => item.label ?? item.type)
    expect(labels).toEqual([
      '打开主界面',
      '服务器设置',
      'separator',
      'PC 采集端：运行中',
      '打开采集端面板',
      '重启采集端',
      '打开日志',
      'separator',
      '退出',
    ])

    const statusItem = template.find((item) => item.label?.startsWith('PC 采集端：'))
    expect(statusItem?.enabled).toBe(false)
  })

  it('updates the status row from the live status snapshot', () => {
    const template = buildTrayMenuTemplate(makeStatus('crashed'), makeActions())
    expect(template.some((item) => item.label === 'PC 采集端：已崩溃')).toBe(true)
  })
})
