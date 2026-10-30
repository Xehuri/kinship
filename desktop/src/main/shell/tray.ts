import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { MenuItemConstructorOptions, Tray } from 'electron'
import type { SensorState, SensorStatus } from '../../shared/types'
import type { AppController } from '../app-controller'
import type { SensorSupervisor } from '../lib/sensor-supervisor'

export interface TrayMenuActions {
  openMain(): void
  openSettings(): void
  openSensorPanel(): void
  restartSensor(): void
  openLogs(): void
  quit(): void
}

const STATE_LABELS: Readonly<Record<SensorState, string>> = Object.freeze({
  unconfigured: '未配置',
  stopped: '已停止',
  starting: '启动中',
  running: '运行中',
  external: '外部实例',
  conflict: '端口冲突',
  'runtime-missing': '缺少运行时',
  crashed: '已崩溃',
  stopping: '停止中',
})

export function trayStateLabel(state: SensorState | undefined): string {
  if (state === undefined) return '未知'
  return STATE_LABELS[state]
}

export function buildTrayMenuTemplate(
  status: SensorStatus,
  actions: TrayMenuActions,
): MenuItemConstructorOptions[] {
  return [
    { label: '打开主界面', click: () => actions.openMain() },
    { label: '服务器设置', click: () => actions.openSettings() },
    { type: 'separator' },
    {
      label: `PC 采集端：${trayStateLabel(status.state)}`,
      enabled: false,
    },
    { label: '打开采集端面板', click: () => actions.openSensorPanel() },
    { label: '重启采集端', click: () => actions.restartSensor() },
    { label: '打开日志', click: () => actions.openLogs() },
    { type: 'separator' },
    { label: '退出', click: () => actions.quit() },
  ]
}

export interface CreateAppTrayOptions {
  readonly iconPath: string
  readonly controller: AppController
  readonly supervisor: SensorSupervisor
  readonly openSensorPanel: () => Promise<void>
  readonly getStatus: () => SensorStatus
  readonly log: (
    message: string,
    fields?: Readonly<Record<string, string | number | boolean>>,
  ) => void
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.trim()
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误'
}

export function createAppTray(options: CreateAppTrayOptions): Tray | null {
  if (process.env.AXEUH_DISABLE_TRAY === '1') return null

  const log = options.log
  const run = (label: string, action: () => void | Promise<void>): void => {
    try {
      const result = action()
      void Promise.resolve(result).catch((error: unknown) => {
        log('托盘操作失败', { action: label, error: describeError(error) })
      })
    } catch (error) {
      log('托盘操作失败', { action: label, error: describeError(error) })
    }
  }

  try {
    const { Tray: ElectronTray, Menu, nativeImage, app, shell } =
      require('electron') as typeof import('electron')

    const image = nativeImage.createFromPath(options.iconPath)
    if (image.isEmpty()) {
      log('托盘图标为空，跳过托盘创建', { path: options.iconPath })
      return null
    }

    const tray = new ElectronTray(image)
    let lastSignature = ''

    const openLogs = (): void => {
      const userData = app.getPath('userData')
      for (const target of [join(userData, 'logs'), join(userData, 'pc-sensor')]) {
        mkdirSync(target, { recursive: true })
        void shell.openPath(target).then((failure) => {
          if (failure.length > 0) {
            log('打开日志目录失败', { path: target, error: failure.slice(0, 180) })
          }
        })
      }
    }

    const actions: TrayMenuActions = {
      openMain: () => {
        options.controller.showMain()
        options.controller.focus()
      },
      openSettings: () => {
        run('打开服务器设置', () => options.controller.openControl('settings'))
      },
      openSensorPanel: () => {
        run('打开采集端面板', options.openSensorPanel)
      },
      restartSensor: () => {
        run('重启采集端', () => options.supervisor.restart())
      },
      openLogs,
      quit: () => {
        options.controller.quit()
      },
    }

    const refresh = (): void => {
      let status: SensorStatus
      try {
        status = options.getStatus()
      } catch (error) {
        log('读取托盘状态失败', { error: describeError(error) })
        return
      }

      const signature = `${status.state}|${String(status.running)}|${String(status.enabled)}|${String(status.port)}`
      if (signature === lastSignature) return
      lastSignature = signature

      const host = hostOf(options.controller.getServerUrl())
      tray.setToolTip(
        `Kinship — ${host.length > 0 ? host : '未配置'} | PC 采集端 ${trayStateLabel(status.state)}`,
      )
      tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(status, actions)))
    }

    tray.on('click', () => {
      options.controller.focus()
    })

    refresh()
    const timer = setInterval(refresh, 1000)
    timer.unref?.()

    process.env.AXEUH_KEEP_RUNNING = '1'
    log('系统托盘已创建')
    return tray
  } catch (error) {
    log('创建系统托盘失败', { error: describeError(error) })
    return null
  }
}
