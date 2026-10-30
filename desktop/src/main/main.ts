import { mkdirSync } from 'node:fs'
import { app, BrowserWindow, Menu, protocol } from 'electron'
import { APP_DISPLAY_NAME, APP_ID } from '../shared/constants'
import { DesktopApp } from './desktop-app'
import { logger } from './lib/logger'
import { resolveUserDataDir } from './lib/user-data'

function bootstrap(): void {
  app.setName(APP_DISPLAY_NAME)

  // Storage dir intentionally stays legacy ('Axeuh Health Desktop') so %APPDATA% does not move.
  const userData = resolveUserDataDir(app.getPath('appData'))
  mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)

  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_ID)
  }

  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'axeuh',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ])

  const lock = app.requestSingleInstanceLock()
  if (!lock) {
    app.quit()
    return
  }

  const desktopApp = new DesktopApp()
  let shuttingDown = false
  let shutdownDone = false

  app.on('second-instance', () => {
    desktopApp.focus()
  })

  app.on('before-quit', (event) => {
    if (shutdownDone) return
    event.preventDefault()
    if (shuttingDown) return
    shuttingDown = true
    void desktopApp.shutdown().finally(() => {
      shutdownDone = true
      app.quit()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return
    if (process.env.AXEUH_KEEP_RUNNING === '1') return
    app.quit()
  })

  app.on('activate', () => {
    if (process.platform !== 'darwin') return
    if (BrowserWindow.getAllWindows().length === 0) desktopApp.focus()
  })

  void app
    .whenReady()
    .then(() => {
      if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
      return desktopApp.start()
    })
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : 'unknown error'
      logger.error('应用启动失败', { error: reason })
      app.quit()
    })
}

bootstrap()
