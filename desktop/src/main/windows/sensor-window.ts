import { BrowserWindow, shell } from 'electron'
import { buildPanelUrl } from '../lib/sensor-command'
import { logger } from '../lib/logger'

export interface SensorWindowOptions {
  readonly parent?: BrowserWindow
  readonly baseUrl: string
  readonly token?: string
}

let sensorWindow: BrowserWindow | null = null

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch (error) {
    if (error instanceof TypeError) return false
    throw error
  }
}

function openExternal(url: string): void {
  if (!isHttpUrl(url)) return
  void shell.openExternal(url).catch((error: unknown) => {
    if (error instanceof Error) {
      logger.warn('打开外部链接失败', { error: error.message })
      return
    }
    logger.warn('打开外部链接失败')
  })
}

export function openSensorWindow(options: SensorWindowOptions): BrowserWindow {
  if (sensorWindow !== null && !sensorWindow.isDestroyed()) {
    if (sensorWindow.isMinimized()) sensorWindow.restore()
    sensorWindow.show()
    sensorWindow.focus()
    return sensorWindow
  }

  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const allowedOrigin = new URL(baseUrl).origin

  const window = new BrowserWindow({
    width: 1024,
    height: 780,
    minWidth: 860,
    minHeight: 640,
    title: 'PC 采集端',
    autoHideMenuBar: true,
    backgroundColor: '#0b1220',
    parent: options.parent,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:axeuh-sensor',
    },
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (isHttpUrl(url) && new URL(url).origin === allowedOrigin) return
    event.preventDefault()
    openExternal(url)
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  window.once('closed', () => {
    if (sensorWindow === window) sensorWindow = null
  })

  sensorWindow = window
  void window.loadURL(buildPanelUrl(baseUrl)).catch((error: unknown) => {
    if (error instanceof Error) {
      logger.warn('PC 采集端面板加载失败', { error: error.message })
      return
    }
    logger.warn('PC 采集端面板加载失败')
  })

  return window
}
