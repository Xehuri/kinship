import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from '@playwright/test'
import { ARTIFACTS_DIR, launchDesktop } from './helpers/electron.ts'
import { getSettingsPage } from './helpers/settings.ts'

test('shows the unreachable error page and keeps retry available', async () => {
  const desktop = await launchDesktop({
    env: {
      AXEUH_DISABLE_TRAY: '1',
      AXEUH_SERVER_URL: 'http://127.0.0.1:1',
    },
  })

  try {
    const settings = await getSettingsPage(desktop)
    await settings.waitForText('无法连接服务器', 20_000)
    await settings.waitForSelector('[data-test="retry"]')
    await settings.waitForSelector('[data-test="tech-details"]')

    mkdirSync(ARTIFACTS_DIR, { recursive: true })
    await settings.screenshot(join(ARTIFACTS_DIR, `error-page-${Date.now()}.png`))

    await settings.click('[data-test="retry"]')
    await settings.waitForSelector('[data-test="retry"]')
    await settings.waitForText('无法连接服务器')
  } finally {
    await desktop.close()
  }
})
