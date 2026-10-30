import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { ARTIFACTS_DIR, launchDesktop } from './helpers/electron.ts'
import { productionBackground } from './helpers/tokens.ts'
import { startFakeSensor } from './fixtures/fake-sensor.mjs'

const REAL_SERVER_URL = 'https://health.example.com'
const THEME_SETTLE_MS = 300
const THEME_BACKGROUNDS = {
  light: productionBackground('light'),
  dark: productionBackground('dark'),
  glacier: productionBackground('glacier'),
} as const

interface NativeThemeState {
  readonly bg: string
  readonly theme: string
}

async function realBackendReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${REAL_SERVER_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
    })
    return response.ok
  } catch {
    return false
  }
}

async function readNativeThemeState(app: ElectronApplication): Promise<NativeThemeState> {
  return app.evaluate(({ BrowserWindow, nativeTheme }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes('/mobile'),
    )
    return {
      bg: window?.getBackgroundColor().toLowerCase() ?? '',
      theme: nativeTheme.themeSource,
    }
  })
}

test('main window follows the SPA dark, light and glacier themes', async () => {
  const reachable = await realBackendReachable()
  if (!reachable) {
    console.log(`REAL_BACKEND_SKIP: ${REAL_SERVER_URL}/health is unreachable`)
  }
  test.skip(!reachable, 'REAL_BACKEND_SKIP: real backend unreachable')

  const sensor = await startFakeSensor({
    token: 'e2e-sensor-token',
    instanceId: 'e2e-theme-instance',
    backendToken: 'e2e-theme-backend-token',
  })
  const desktop = await launchDesktop({
    env: {
      AXEUH_DISABLE_TRAY: '1',
      AXEUH_SERVER_URL: REAL_SERVER_URL,
      AXEUH_FAKE_SENSOR_URL: sensor.baseUrl,
      AXEUH_FAKE_SENSOR_TOKEN: sensor.token,
      AXEUH_FAKE_SENSOR_INSTANCE_ID: 'e2e-theme-instance',
    },
  })

  try {
    const main = desktop.window
    await main.waitForURL((url) => url.toString().includes('health.example.com/mobile'), {
      timeout: 30_000,
    })
    await main.waitForFunction(
      () => {
        const state = (window as unknown as { __axeuhThemeSyncV1?: { read?: unknown } })
          .__axeuhThemeSyncV1
        return typeof state?.read === 'function'
      },
      undefined,
      { timeout: 30_000 },
    )

    await main.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light')
    })
    await main.waitForTimeout(THEME_SETTLE_MS)
    await expect.poll(() => readNativeThemeState(desktop.app)).toEqual({
      bg: THEME_BACKGROUNDS.light,
      theme: 'light',
    })

    mkdirSync(ARTIFACTS_DIR, { recursive: true })
    await main.screenshot({
      path: join(ARTIFACTS_DIR, `theme-light-${Date.now()}.png`),
      fullPage: false,
    })

    await main.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark')
    })
    await main.waitForTimeout(THEME_SETTLE_MS)
    await expect.poll(() => readNativeThemeState(desktop.app)).toEqual({
      bg: THEME_BACKGROUNDS.dark,
      theme: 'dark',
    })

    await main.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'glacier')
    })
    await main.waitForTimeout(THEME_SETTLE_MS)
    await expect.poll(() => readNativeThemeState(desktop.app)).toEqual({
      bg: THEME_BACKGROUNDS.glacier,
      theme: 'light',
    })
  } finally {
    await desktop.close()
    await sensor.close()
  }
})
