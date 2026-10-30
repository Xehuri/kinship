import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from 'playwright'
import { ARTIFACTS_DIR, launchDesktop } from './helpers/electron.ts'
import { getSettingsPage } from './helpers/settings.ts'
import { startFakeSensor } from './fixtures/fake-sensor.mjs'
import { startFixtureServer } from './fixtures/server.mjs'

const TOKEN_WAIT_MS = 20_000

interface SensorRequest {
  readonly method: string
  readonly url: string
  readonly body: string | null
}

interface TokenBridgeState {
  readonly token: string | null
  readonly events: readonly unknown[]
}

async function readTokenBridgeState(page: Page): Promise<TokenBridgeState> {
  return page.evaluate(() => {
    const host = window as unknown as { __axeuhTokenEvents?: unknown[] }
    return {
      token: window.localStorage.getItem('mobile_token'),
      events: host.__axeuhTokenEvents ?? [],
    }
  })
}

function readConfigPostBody(request: SensorRequest): Record<string, unknown> | null {
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

test('first-run setup trusts the fixture certificate and loads the SPA', async () => {
  const fixture = await startFixtureServer()
  const sensor = await startFakeSensor({
    token: 'e2e-sensor-token',
    instanceId: 'e2e-instance',
  })
  const desktop = await launchDesktop({
    env: {
      AXEUH_DISABLE_TRAY: '1',
      AXEUH_TOKEN_POLL_MS: '200',
      AXEUH_FAKE_SENSOR_URL: sensor.baseUrl,
      AXEUH_FAKE_SENSOR_TOKEN: sensor.token,
      AXEUH_FAKE_SENSOR_INSTANCE_ID: 'e2e-instance',
    },
  })

  try {
    expect(desktop.window.url()).toBe('about:blank')
    const settings = await getSettingsPage(desktop)
    await settings.waitForSelector('[data-test="network-editor"]')
    await settings.fill('[data-test="network-layer-address-0"]', fixture.url)
    await settings.select('[data-test="network-layer-tls-0"]', 'insecure')
    await settings.check('[data-test="network-layer-insecure-ack-0"]')
    await settings.click('[data-test="network-save"]')
    await settings.waitForText('网络配置已保存并完成探测', 30_000)
    await settings.waitForText('可用')
    await settings.waitForSelector('[data-test="network-layer-current"]')

    await desktop.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1200, 900)
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
    mkdirSync(ARTIFACTS_DIR, { recursive: true })
    await settings.screenshot(join(ARTIFACTS_DIR, `setup-network-${Date.now()}.png`))

    await settings.click('[data-test="next-step"]')
    await settings.waitForSelector('[data-test="agent-id"]')
    await settings.fill('[data-test="agent-id"]', 'e2e-setup-agent')
    await settings.fill('[data-test="agent-name"]', 'E2E Setup PC')
    await settings.click('[data-test="finish-setup"]')
    await settings.waitForSelector('[data-test="setup-success"]', 30_000)
    await settings.click('[data-test="enter-main"]')

    await desktop.window.waitForURL((url) => url.toString().includes('/mobile/'), {
      timeout: 30_000,
    })
    await desktop.window.locator('text=Fixture SPA').waitFor({ state: 'visible', timeout: 20_000 })

    await expect
      .poll(async () => (await readTokenBridgeState(desktop.window)).token, {
        timeout: TOKEN_WAIT_MS,
      })
      .toBe('fixture-backend-token')
    const initialTokenState = await readTokenBridgeState(desktop.window)
    expect(initialTokenState.events).toContain('fixture-backend-token')
    expect(desktop.window.url()).not.toContain('fixture-backend-token')
    const timeOriginBeforeRefresh = await desktop.window.evaluate(
      () => window.performance.timeOrigin,
    )

    sensor.setBackendToken('rotated-fixture-token')
    await expect
      .poll(
        async () => {
          const state = await readTokenBridgeState(desktop.window)
          return (
            state.token === 'rotated-fixture-token' &&
            state.events.includes('rotated-fixture-token')
          )
        },
        { timeout: TOKEN_WAIT_MS },
      )
      .toBe(true)

    const rotatedTokenState = await readTokenBridgeState(desktop.window)
    expect(rotatedTokenState.token).toBe('rotated-fixture-token')
    expect(rotatedTokenState.events).toContain('rotated-fixture-token')
    const timeOriginAfterRefresh = await desktop.window.evaluate(
      () => window.performance.timeOrigin,
    )
    expect(timeOriginAfterRefresh).toBe(timeOriginBeforeRefresh)

    const mainWindowStates = await desktop.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => ({
        url: window.webContents.getURL(),
        visible: window.isVisible(),
      })),
    )
    expect(mainWindowStates).toHaveLength(1)
    expect(mainWindowStates[0]?.url).toContain('/mobile/')
    expect(mainWindowStates[0]?.visible).toBe(true)

    const bridgeType = await desktop.window.evaluate(
      () => typeof (window as unknown as { axeuh?: unknown }).axeuh,
    )
    expect(bridgeType).toBe('undefined')

    const before = desktop.window.url()
    await desktop.window.click('#external', { noWaitAfter: true })
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500)
    })
    expect(desktop.window.url()).toBe(before)
    expect(before).toContain('/mobile/')

    // 外部链接被 Electron 取消后 Playwright 仍把主框架视为导航中；force 跳过这段陈旧的等待，点击照常派发。
    await desktop.window.click('#open-settings', { noWaitAfter: true, force: true })
    const settingsAfterOpen = await getSettingsPage(desktop)
    await settingsAfterOpen.waitForText('桌面设置')
    expect(desktop.window.url()).toContain('/mobile/')
    const windowCountAfterSettings = await desktop.app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    )
    expect(windowCountAfterSettings).toBe(1)

    mkdirSync(ARTIFACTS_DIR, { recursive: true })
    const stamp = Date.now()
    await desktop.window.screenshot({
      path: join(ARTIFACTS_DIR, `setup-success-${stamp}.png`),
      fullPage: false,
    })
    await settingsAfterOpen.screenshot(join(ARTIFACTS_DIR, `setup-settings-${stamp}.png`))

    const configPatch = (sensor.requests as readonly SensorRequest[])
      .map((request) => readConfigPostBody(request))
      .filter((patch): patch is Record<string, unknown> => patch !== null)
      .at(-1)
    expect(configPatch).toBeDefined()
    expect(configPatch?.['ssl_verify']).toBe(false)
    expect(configPatch?.['ssl_ca_file']).toBe('')
  } finally {
    await desktop.close()
    await sensor.close()
    await fixture.close()
  }
})
