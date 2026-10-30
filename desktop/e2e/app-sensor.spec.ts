import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { ARTIFACTS_DIR, launchDesktop } from './helpers/electron.ts'
import { getSettingsPage } from './helpers/settings.ts'
import type { SettingsPage } from './helpers/settings.ts'
import { desktopBackground, hexToRgb } from './helpers/tokens.ts'
import { startFakeSensor } from './fixtures/fake-sensor.mjs'
import { startFixtureServer } from './fixtures/server.mjs'

const DESKTOP_DARK_BG = hexToRgb(desktopBackground('dark'))

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function readActiveNav(settings: SettingsPage): Promise<string> {
  const active = await settings.evaluate(
    "document.querySelector('.rail__item.is-active')?.getAttribute('data-test') ?? ''",
  )
  return typeof active === 'string' ? active : ''
}

async function clickNavAndExpect(settings: SettingsPage, id: string): Promise<void> {
  await settings.click(`[data-test="nav-${id}"]`)
  await sleep(900)
  expect(await readActiveNav(settings)).toBe(`nav-${id}`)
}

interface SensorRequest {
  readonly method: string
  readonly url: string
  readonly body: string | null
}

function readConfigPatch(request: SensorRequest): Record<string, unknown> | null {
  if (request.method !== 'POST' || request.url !== '/pc-sensor/config') return null
  if (request.body === null) return null
  try {
    const parsed: unknown = JSON.parse(request.body)
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function readConfigPatches(requests: readonly SensorRequest[]): Record<string, unknown>[] {
  const patches: Record<string, unknown>[] = []
  for (const request of requests) {
    const patch = readConfigPatch(request)
    if (patch !== null) patches.push(patch)
  }
  return patches
}

async function waitForSensorStatus(settings: SettingsPage): Promise<void> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const body = await settings.text()
    if (body.includes('外部实例') || body.includes('运行中')) return
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100)
    })
  }
  throw new Error(`等待采集端状态超时；当前文本：${await settings.text()}`)
}

test('settings save the sensor config through the fake sensor', async () => {
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
    await settings.click('[data-test="nav-sensor"]')
    await waitForSensorStatus(settings)

    await settings.fill('[data-test="idle-threshold"]', '120')
    await settings.click('[data-test="save-all"]')
    await settings.waitForText('更改已保存', 20_000)

    const requests = sensor.requests as readonly SensorRequest[]
    const savedPatch = readConfigPatches(requests)
      .filter((patch) => patch['idle_threshold'] === 120)
      .at(-1)
    expect(savedPatch).toBeDefined()
    expect(savedPatch?.['idle_threshold']).toBe(120)
    expect(savedPatch?.['server_url']).toBe('http://127.0.0.1:1')

    await settings.waitForSelector('[data-test="health-strip"]')
    await settings.waitForSelector('[data-test="sensor-status-card"]')
    await settings.waitForSelector('[data-test="back-to-main-rail"]')

    await desktop.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1200, 900)
    })
    await sleep(400)

    await clickNavAndExpect(settings, 'network')
    await settings.waitForSelector('[data-test="network-p2p-placeholder"]')
    await settings.evaluate(
      "document.getElementById('section-network')?.scrollIntoView({ block: 'start' })",
    )
    await sleep(250)
    mkdirSync(ARTIFACTS_DIR, { recursive: true })
    await settings.screenshot(join(ARTIFACTS_DIR, `network-settings-${Date.now()}.png`))
    await settings.screenshot(join(ARTIFACTS_DIR, `network-p2p-${Date.now()}.png`))

    await clickNavAndExpect(settings, 'startup')
    await sleep(250)
    await settings.screenshot(join(ARTIFACTS_DIR, `startup-settings-${Date.now()}.png`))

    await settings.evaluate("document.documentElement.setAttribute('data-theme', 'dark')")
    await sleep(300)
    const darkBackground = await settings.evaluate(
      'getComputedStyle(document.body).backgroundColor',
    )
    expect(darkBackground).toBe(DESKTOP_DARK_BG)
    await settings.screenshot(join(ARTIFACTS_DIR, `startup-settings-dark-${Date.now()}.png`))
    await settings.evaluate("document.documentElement.removeAttribute('data-theme')")
    await sleep(200)

    await desktop.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(760, 900)
    })
    await sleep(350)
    await settings.click('[data-test="nav-network"]')
    await sleep(200)
    await settings.evaluate(
      "document.getElementById('section-network')?.scrollIntoView({ block: 'start', behavior: 'instant' })",
    )
    await sleep(250)
    await settings.screenshot(join(ARTIFACTS_DIR, `network-settings-narrow-${Date.now()}.png`))
    await desktop.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1200, 900)
    })
    await sleep(300)
    await settings.click('[data-test="nav-startup"]')
    await sleep(250)

    await settings.click('[data-test="startup-open-at-login"]')
    await sleep(500)
    const persistedWindow = JSON.parse(
      readFileSync(join(desktop.userDataDir, 'desktop-config.json'), 'utf8'),
    ) as { window?: { openAtLogin?: boolean } }
    expect(persistedWindow.window?.openAtLogin).toBe(true)
    await clickNavAndExpect(settings, 'about')
    await clickNavAndExpect(settings, 'sensor')
    await settings.screenshot(join(ARTIFACTS_DIR, `sensor-health-${Date.now()}.png`))

    await settings.click('[data-test="open-logs-settings"]')
    await settings.waitForSelector('[data-test="log-viewer"]')
    await settings.waitForSelector('[data-test="log-path-desktop"]')
    mkdirSync(join(desktop.userDataDir, 'logs'), { recursive: true })
    appendFileSync(
      join(desktop.userDataDir, 'logs', 'desktop.log'),
      'E2E_LIVE_LOG_MARKER\n',
      'utf8',
    )
    await settings.waitForText('E2E_LIVE_LOG_MARKER', 15_000)
    await sleep(350)
    await settings.screenshot(
      join(ARTIFACTS_DIR, `sensor-log-desktop-${Date.now()}.png`),
    )

    await settings.evaluate("document.documentElement.setAttribute('data-theme', 'dark')")
    await sleep(300)
    expect(
      await settings.evaluate('getComputedStyle(document.body).backgroundColor'),
    ).toBe(DESKTOP_DARK_BG)
    await settings.screenshot(join(ARTIFACTS_DIR, `sensor-log-dark-${Date.now()}.png`))
    await settings.evaluate("document.documentElement.removeAttribute('data-theme')")
    await sleep(200)

    await settings.click('[data-test="log-tab-sensor"]')
    await settings.waitForSelector('[data-test="log-path-sensor"]')
    await sleep(250)
    await settings.screenshot(join(ARTIFACTS_DIR, `sensor-log-sensor-${Date.now()}.png`))
    await settings.click('[data-test="log-close"]')
    await sleep(150)
    const viewerClosed = await settings.evaluate(
      "document.querySelector('[data-test=\"log-viewer\"]') === null",
    )
    expect(viewerClosed).toBe(true)

    await desktop.close()
    expect(sensor.stopped).toBe(true)
  } finally {
    await desktop.close()
    await sensor.close()
  }
})

test('saves ordered network layers and synchronizes the layer TLS to the sensor', async () => {
  const fixture = await startFixtureServer()
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
    await settings.click('[data-test="nav-network"]')
    await settings.waitForSelector('[data-test="network-layer-expand-0"]')
    await settings.click('[data-test="network-layer-expand-0"]')
    await settings.waitForSelector('[data-test="network-layer-address-0"]')
    await sleep(300)

    await settings.fill('[data-test="network-layer-address-0"]', fixture.url)
    await settings.select('[data-test="network-layer-tls-0"]', 'insecure')
    await settings.check('[data-test="network-layer-insecure-ack-0"]')
    await settings.click('[data-test="network-save"]')
    await settings.waitForText('网络配置已保存并完成探测', 30_000)
    await settings.waitForText('可用')
    await settings.waitForSelector('[data-test="network-layer-current"]')

    const requests = sensor.requests as readonly SensorRequest[]
    const savedPatch = readConfigPatches(requests)
      .filter((patch) => patch['server_url'] === fixture.url)
      .at(-1)
    expect(savedPatch).toBeDefined()
    expect(savedPatch?.['ssl_verify']).toBe(false)
    expect(savedPatch?.['ssl_ca_file']).toBe('')

    await desktop.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1200, 900)
    })
    await sleep(400)
    await settings.evaluate(
      "document.getElementById('section-network')?.scrollIntoView({ block: 'start' })",
    )
    await sleep(350)
    await settings.screenshot(join(ARTIFACTS_DIR, `network-settings-${Date.now()}.png`))
  } finally {
    await desktop.close()
    await sensor.close()
    await fixture.close()
  }
})
