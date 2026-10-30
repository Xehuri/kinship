import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { ARTIFACTS_DIR, launchDesktop } from './helpers/electron.ts'
import { getSettingsPage } from './helpers/settings.ts'
import type { SettingsPage } from './helpers/settings.ts'
import { startFakeSensor } from './fixtures/fake-sensor.mjs'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function waitForReadySensor(settings: SettingsPage): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const body = await settings.text()
    if (body.includes('外部实例') || body.includes('运行中')) return
    await sleep(100)
  }
  throw new Error(`等待采集端状态超时；当前文本：${await settings.text()}`)
}

async function waitForFinalEnabled(settings: SettingsPage): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const enabled = await settings.evaluate(
      "(() => { const button = document.querySelector('[data-test=\"reset-final\"]'); return button instanceof HTMLButtonElement && !button.disabled })()",
    )
    if (enabled === true) return
    await sleep(100)
  }
  throw new Error('等待“确认重置”按钮启用超时')
}

async function waitForSensorStopped(sensor: { stopped: boolean }): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (sensor.stopped) return
    await sleep(100)
  }
  throw new Error('等待 fake sensor 停止超时')
}

test('resets all local parameters and returns to the first-run setup', async () => {
  const sensor = await startFakeSensor({
    token: 'e2e-sensor-token',
    instanceId: 'e2e-instance',
  })
  const desktop = await launchDesktop({
    env: {
      AXEUH_DISABLE_TRAY: '1',
      AXEUH_SERVER_URL: 'http://127.0.0.1:1',
      AXEUH_START_ROUTE: 'settings',
      AXEUH_FAKE_SENSOR_URL: sensor.baseUrl,
      AXEUH_FAKE_SENSOR_TOKEN: sensor.token,
      AXEUH_FAKE_SENSOR_INSTANCE_ID: 'e2e-instance',
    },
  })

  try {
    const settings = await getSettingsPage(desktop)
    await settings.waitForText('桌面设置')
    await waitForReadySensor(settings)

    await settings.click('[data-test="save-all"]')
    await settings.waitForText('更改已保存', 20_000)

    const userData = desktop.userDataDir
    const desktopConfig = join(userData, 'desktop-config.json')
    const agentConfig = join(userData, 'pc-sensor', 'config.json')
    const collectionConfig = join(userData, 'pc-sensor', 'pc_sensor_config.json')

    expect(existsSync(desktopConfig)).toBe(true)
    expect(existsSync(agentConfig)).toBe(true)
    expect(existsSync(collectionConfig)).toBe(true)

    mkdirSync(ARTIFACTS_DIR, { recursive: true })

    await settings.click('[data-test="nav-reset"]')
    await sleep(900)
    const activeNav = await settings.evaluate(
      "document.querySelector('.rail__item.is-active')?.getAttribute('data-test') ?? ''",
    )
    expect(activeNav).toBe('nav-reset')
    await settings.waitForSelector('[data-test="reset-all"]')
    await settings.evaluate(
      "document.getElementById('section-reset')?.scrollIntoView({ block: 'start' })",
    )
    await sleep(350)
    await settings.screenshot(join(ARTIFACTS_DIR, `reset-section-${Date.now()}.png`))

    await settings.click('[data-test="reset-all"]')
    await settings.waitForSelector('[data-test="reset-confirm"]')
    await sleep(300)
    await settings.screenshot(join(ARTIFACTS_DIR, `reset-step1-${Date.now()}.png`))

    await settings.click('[data-test="reset-continue"]')
    await settings.waitForSelector('[data-test="reset-phrase"]')
    const finalDisabled = await settings.evaluate(
      "(() => { const button = document.querySelector('[data-test=\"reset-final\"]'); return button instanceof HTMLButtonElement ? button.disabled : null })()",
    )
    expect(finalDisabled).toBe(true)
    await sleep(300)
    await settings.screenshot(join(ARTIFACTS_DIR, `reset-step2-${Date.now()}.png`))

    await settings.fill('[data-test="reset-phrase"]', '重置')
    await waitForFinalEnabled(settings)
    await settings.click('[data-test="reset-final"]')

    await settings.waitForText('配置网络层', 30_000)
    await settings.waitForSelector('[data-test="network-editor"]')
    await sleep(400)
    await settings.screenshot(join(ARTIFACTS_DIR, `reset-setup-${Date.now()}.png`))

    const setupUrl = await settings.url()
    expect(setupUrl).toContain('#/setup')

    await waitForSensorStopped(sensor)
    expect(sensor.stopped).toBe(true)

    expect(existsSync(desktopConfig)).toBe(false)
    expect(existsSync(agentConfig)).toBe(false)
    expect(existsSync(collectionConfig)).toBe(false)
    expect(existsSync(join(userData, 'logs', 'desktop.log'))).toBe(true)
  } finally {
    await desktop.close()
    await sensor.close()
  }
})
