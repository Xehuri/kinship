import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { ElectronApplication } from 'playwright'
import { ARTIFACTS_DIR, launchDesktop } from './helpers/electron.ts'
import { getSettingsPage, type SettingsPage } from './helpers/settings.ts'
import { startFakeSensor } from './fixtures/fake-sensor.mjs'
import { startFixtureServer } from './fixtures/server.mjs'

const DEAD_LAYER_URL = 'https://127.0.0.1:1'

interface PersistedConfig {
  readonly network?: {
    readonly activeLayerId?: string
    readonly layers?: readonly { readonly id: string; readonly address: string }[]
  }
  readonly server?: { readonly url?: string }
  readonly window?: { readonly minimizeToTray?: boolean; readonly openAtLogin?: boolean }
}

interface SensorRequest {
  readonly method: string
  readonly url: string
  readonly body: string | null
}

function writeLayersConfig(
  userDataDir: string,
  layers: readonly Record<string, unknown>[],
): void {
  writeFileSync(
    join(userDataDir, 'desktop-config.json'),
    JSON.stringify({
      schemaVersion: 3,
      network: { layers },
      window: { minimizeToTray: true, openAtLogin: false },
    }),
    'utf8',
  )
}

function readPersisted(userDataDir: string): PersistedConfig {
  return JSON.parse(
    readFileSync(join(userDataDir, 'desktop-config.json'), 'utf8'),
  ) as PersistedConfig
}

function readConfigPatch(request: SensorRequest): Record<string, unknown> | null {
  if (request.method !== 'POST' || request.url !== '/pc-sensor/config') return null
  if (request.body === null) return null
  const parsed: unknown = JSON.parse(request.body)
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null
}

async function openSettings(app: ElectronApplication): Promise<SettingsPage> {
  await app.evaluate(async () => {
    const qa = globalThis.__AXEUH_QA__
    if (qa === undefined) throw new Error('QA bridge is unavailable')
    await qa.controller.openControl('settings')
  })
  return getSettingsPage({ app } as Parameters<typeof getSettingsPage>[0])
}

async function readMainUrls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => window.webContents.getURL()),
  )
}

test('probes layers in order, selects the healthy origin and syncs layer TLS to the sensor', async () => {
  const healthy = await startFixtureServer()
  const sensor = await startFakeSensor({
    token: 'e2e-layer-sensor-token',
    instanceId: 'e2e-layer-instance',
    backendToken: 'e2e-layer-backend-token',
  })
  const desktop = await launchDesktop({
    env: {
      AXEUH_DISABLE_TRAY: '1',
      AXEUH_TOKEN_POLL_MS: '200',
      AXEUH_FAKE_SENSOR_URL: sensor.baseUrl,
      AXEUH_FAKE_SENSOR_TOKEN: sensor.token,
      AXEUH_FAKE_SENSOR_INSTANCE_ID: 'e2e-layer-instance',
    },
    prepareUserData: (dir) => {
      writeLayersConfig(dir, [
        {
          id: 'dead',
          type: 'frp',
          name: 'frp',
          address: DEAD_LAYER_URL,
          enabled: true,
          tlsMode: 'insecure',
        },
        {
          id: 'home',
          type: 'direct',
          name: 'home',
          address: healthy.url,
          enabled: true,
          tlsMode: 'insecure',
        },
      ])
    },
  })

  try {
    await desktop.window.waitForURL((url) => url.toString().includes('/mobile/'), {
      timeout: 30_000,
    })
    await expect
      .poll(
        async () =>
          desktop.window.evaluate(() => localStorage.getItem('mobile_token')),
        { timeout: 20_000 },
      )
      .toBe('e2e-layer-backend-token')

    const persisted = readPersisted(desktop.userDataDir)
    expect(persisted.network?.activeLayerId).toBe('home')
    expect(persisted.server?.url).toBe(healthy.url)

    await expect
      .poll(
        () =>
          sensor.requests
            .map((request) => readConfigPatch(request))
            .filter((patch): patch is Record<string, unknown> => patch !== null)
            .find((patch) => patch['server_url'] === healthy.url) ?? null,
        { timeout: 20_000 },
      )
      .not.toBeNull()

    const patch = sensor.requests
      .map((request) => readConfigPatch(request))
      .filter((patch): patch is Record<string, unknown> => patch !== null)
      .find((entry) => entry['server_url'] === healthy.url)
    expect(patch?.['ssl_verify']).toBe(false)
    expect(patch?.['ssl_ca_file']).toBe('')

    const settings = await openSettings(desktop.app)
    const savePrefs = await settings.evaluate(`(async () => {
      const response = await window.axeuh.saveWindowPreferences({ minimizeToTray: false, openAtLogin: true })
      return response
    })()`)
    expect(savePrefs).toMatchObject({
      ok: true,
      data: { minimizeToTray: false, openAtLogin: true },
    })
    expect(readPersisted(desktop.userDataDir).window).toMatchObject({
      minimizeToTray: false,
      openAtLogin: true,
    })

    mkdirSync(join(desktop.userDataDir, 'logs'), { recursive: true })
    await settings.evaluate(`(async () => {
      window.__axeuhLogEvents = []
      window.__axeuhLogStop = window.axeuh.onLogEvent((event) => window.__axeuhLogEvents.push(event))
      const response = await window.axeuh.startLogStream({ lines: 20, sources: ['desktop'] })
      return response
    })()`)
    appendFileSync(
      join(desktop.userDataDir, 'logs', 'desktop.log'),
      'NETWORK_LAYER_STREAM_MARKER\n',
      'utf8',
    )
    await expect
      .poll(
        () =>
          settings.evaluate(
            `Boolean((window.__axeuhLogEvents || []).find((event) => event.lines && event.lines.includes('NETWORK_LAYER_STREAM_MARKER')))`,
          ),
        { timeout: 15_000 },
      )
      .toBe(true)
    await settings.evaluate(`window.axeuh.stopLogStream()`)

    mkdirSync(ARTIFACTS_DIR, { recursive: true })
    await settings.screenshot(join(ARTIFACTS_DIR, `network-layers-${Date.now()}.png`))
  } finally {
    await desktop.close()
    await sensor.close()
    await healthy.close()
  }
})

test('falls back to the next layer when the main SPA fails to load', async () => {
  const broken = await startFixtureServer({ mobileAbort: true })
  const healthy = await startFixtureServer()
  const sensor = await startFakeSensor({
    token: 'e2e-fallback-sensor-token',
    instanceId: 'e2e-fallback-instance',
    backendToken: 'e2e-fallback-backend-token',
  })
  const desktop = await launchDesktop({
    env: {
      AXEUH_DISABLE_TRAY: '1',
      AXEUH_TOKEN_POLL_MS: '200',
      AXEUH_FAKE_SENSOR_URL: sensor.baseUrl,
      AXEUH_FAKE_SENSOR_TOKEN: sensor.token,
      AXEUH_FAKE_SENSOR_INSTANCE_ID: 'e2e-fallback-instance',
    },
    prepareUserData: (dir) => {
      writeLayersConfig(dir, [
        {
          id: 'broken',
          type: 'direct',
          name: 'broken',
          address: broken.url,
          enabled: true,
          tlsMode: 'insecure',
        },
        {
          id: 'home',
          type: 'direct',
          name: 'home',
          address: healthy.url,
          enabled: true,
          tlsMode: 'insecure',
        },
      ])
    },
  })

  try {
    await expect
      .poll(() => desktop.window.url(), { timeout: 30_000 })
      .toContain(healthy.url)
    const persisted = readPersisted(desktop.userDataDir)
    expect(persisted.network?.activeLayerId).toBe('home')
    expect(persisted.server?.url).toBe(healthy.url)
    await expect
      .poll(
        async () => desktop.window.evaluate(() => localStorage.getItem('mobile_token')),
        { timeout: 20_000 },
      )
      .toBe('e2e-fallback-backend-token')
  } finally {
    await desktop.close()
    await sensor.close()
    await broken.close()
    await healthy.close()
  }
})

test('blocks the remote SPA when no startup token is available', async () => {
  const healthy = await startFixtureServer()
  const sensor = await startFakeSensor({
    token: 'e2e-guard-sensor-token',
    instanceId: 'e2e-guard-instance',
    backendToken: '',
  })
  const desktop = await launchDesktop({
    waitForSpa: false,
    env: {
      AXEUH_DISABLE_TRAY: '1',
      AXEUH_STARTUP_AUTH_WAIT_MS: '1200',
      AXEUH_FAKE_SENSOR_URL: sensor.baseUrl,
      AXEUH_FAKE_SENSOR_TOKEN: sensor.token,
      AXEUH_FAKE_SENSOR_INSTANCE_ID: 'e2e-guard-instance',
    },
    prepareUserData: (dir) => {
      writeLayersConfig(dir, [
        {
          id: 'home',
          type: 'direct',
          name: 'home',
          address: healthy.url,
          enabled: true,
          tlsMode: 'insecure',
        },
      ])
    },
  })

  try {
    const settings = await getSettingsPage(desktop)
    await expect
      .poll(async () => (await settings.url()).includes('#/settings'), { timeout: 20_000 })
      .toBe(true)

    const urls = await readMainUrls(desktop.app)
    expect(urls.filter((url) => url.includes('/mobile/'))).toEqual([])
    expect(urls).toContain('about:blank')

    mkdirSync(ARTIFACTS_DIR, { recursive: true })
    await settings.screenshot(join(ARTIFACTS_DIR, `login-guard-${Date.now()}.png`))
  } finally {
    await desktop.close()
    await sensor.close()
    await healthy.close()
  }
})
