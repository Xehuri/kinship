import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { ARTIFACTS_DIR, launchDesktop } from './helpers/electron.ts'
import { getSettingsPage } from './helpers/settings.ts'
import { startFakeSensor } from './fixtures/fake-sensor.mjs'

const REAL_SERVER_URL = 'https://health.example.com'

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

test('loads the real backend main SPA next to the local settings view', async () => {
  const reachable = await realBackendReachable()
  if (!reachable) {
    console.log(`REAL_BACKEND_SKIP: ${REAL_SERVER_URL}/health is unreachable`)
  }
  test.skip(!reachable, 'REAL_BACKEND_SKIP: real backend unreachable')

  const sensor = await startFakeSensor({
    token: 'e2e-sensor-token',
    instanceId: 'e2e-instance',
    backendToken: '',
  })
  const desktop = await launchDesktop({
    env: {
      AXEUH_DISABLE_TRAY: '1',
      AXEUH_SERVER_URL: REAL_SERVER_URL,
      AXEUH_START_ROUTE: 'settings',
      AXEUH_FAKE_SENSOR_URL: sensor.baseUrl,
      AXEUH_FAKE_SENSOR_TOKEN: sensor.token,
      AXEUH_FAKE_SENSOR_INSTANCE_ID: 'e2e-instance',
    },
  })

  try {
    const main = desktop.window
    await main.waitForURL((url) => url.toString().includes('health.example.com/mobile'), {
      timeout: 30_000,
    })
    const settings = await getSettingsPage(desktop)

    await expect(main.locator('body')).toContainText(/Axeuh Mobile|登录/, { timeout: 30_000 })
    await settings.waitForText('桌面设置')

    const bridgeType = await main.evaluate(
      () => typeof (window as unknown as { axeuh?: unknown }).axeuh,
    )
    expect(bridgeType).toBe('undefined')

    mkdirSync(ARTIFACTS_DIR, { recursive: true })
    const stamp = Date.now()
    await main.screenshot({
      path: join(ARTIFACTS_DIR, `real-backend-main-${stamp}.png`),
      fullPage: false,
    })
    await settings.screenshot(join(ARTIFACTS_DIR, `real-backend-settings-${stamp}.png`))
  } finally {
    await desktop.close()
    await sensor.close()
  }
})
