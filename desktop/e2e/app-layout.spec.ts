import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { ARTIFACTS_DIR, launchDesktop } from './helpers/electron.ts'
import { getSettingsPage } from './helpers/settings.ts'
import { startFakeSensor } from './fixtures/fake-sensor.mjs'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const READ_HEADER_LAYOUT = `(() => {
  const rect = (selector) => {
    const element = document.querySelector(selector)
    if (element === null) return null
    const box = element.getBoundingClientRect()
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width }
  }
  const rail = rect('.rail')
  const title = rect('.settings-head__title')
  const actions = rect('.settings-head__actions')
  const chip = rect('[data-test="active-connection"]')
  const back = rect('[data-test="back-to-main"]')
  const header = rect('.settings-head')
  const scroll = rect('.settings-scroll')
  if (rail === null || title === null || actions === null || chip === null || back === null || header === null || scroll === null) {
    return { ok: false }
  }
  return {
    ok: true,
    railWidth: Math.round(rail.width),
    actionsInside:
      actions.left >= rail.right - 1 &&
      actions.right <= window.innerWidth + 1 &&
      actions.top >= 0,
    chipInside: chip.left >= 0 && chip.right <= window.innerWidth + 1,
    backInside: back.left >= 0 && back.right <= window.innerWidth + 1,
    actionsClearOfTitle:
      actions.top >= title.bottom - 1 || actions.left >= title.right - 1,
    headerAboveScroll: header.bottom <= scroll.top + 1,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }
})()`

const READ_STICKY_LAYOUT = `(() => {
  const strip = document.querySelector('[data-test="health-strip"]')
  const scroll = document.querySelector('.settings-scroll')
  const section = document.getElementById('section-network')
  if (strip === null || scroll === null || section === null) return { ok: false }
  const stripBox = strip.getBoundingClientRect()
  const scrollBox = scroll.getBoundingClientRect()
  const sectionBox = section.getBoundingClientRect()
  return {
    ok: true,
    offset: Math.round(stripBox.top - scrollBox.top),
    radius: getComputedStyle(strip).borderTopLeftRadius,
    sectionBelowStrip: sectionBox.top >= stripBox.bottom - 1,
    scrollTop: Math.round(scroll.scrollTop),
  }
})()`

test('settings layout keeps header actions visible at the 960px minimum and floats the health strip', async () => {
  const sensor = await startFakeSensor({
    token: 'e2e-layout-sensor-token',
    instanceId: 'e2e-layout-instance',
  })
  const desktop = await launchDesktop({
    env: {
      AXEUH_DISABLE_TRAY: '1',
      AXEUH_SERVER_URL: 'http://127.0.0.1:1',
      AXEUH_START_ROUTE: 'settings',
      AXEUH_FAKE_SENSOR_URL: sensor.baseUrl,
      AXEUH_FAKE_SENSOR_TOKEN: sensor.token,
      AXEUH_FAKE_SENSOR_INSTANCE_ID: 'e2e-layout-instance',
    },
  })

  try {
    const settings = await getSettingsPage(desktop)
    await settings.waitForText('桌面设置')
    await settings.waitForSelector('[data-test="health-strip"]')
    mkdirSync(ARTIFACTS_DIR, { recursive: true })
    const stamp = Date.now()

    await desktop.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(960, 900)
    })
    await sleep(400)
    await settings.evaluate("document.querySelector('.settings-scroll')?.scrollTo({ top: 0, behavior: 'instant' })")
    await sleep(200)

    await expect(await settings.evaluate(READ_HEADER_LAYOUT)).toMatchObject({
      ok: true,
      railWidth: 64,
      actionsInside: true,
      chipInside: true,
      backInside: true,
      actionsClearOfTitle: true,
      headerAboveScroll: true,
      horizontalOverflow: false,
    })
    await settings.screenshot(join(ARTIFACTS_DIR, `settings-960-header-${stamp}.png`))

    await settings.evaluate(
      "document.getElementById('section-network')?.scrollIntoView({ block: 'start', behavior: 'instant' })",
    )
    await sleep(250)
    await expect(await settings.evaluate(READ_STICKY_LAYOUT)).toMatchObject({
      ok: true,
      offset: 16,
      radius: '6px',
      sectionBelowStrip: true,
    })
    await expect(await settings.evaluate(READ_HEADER_LAYOUT)).toMatchObject({
      actionsInside: true,
      chipInside: true,
      backInside: true,
      headerAboveScroll: true,
      horizontalOverflow: false,
    })
    await settings.screenshot(join(ARTIFACTS_DIR, `settings-960-network-${stamp}.png`))
    await settings.screenshot(join(ARTIFACTS_DIR, `settings-960-health-strip-${stamp}.png`))

    await desktop.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1200, 900)
    })
    await sleep(400)
    await settings.evaluate("document.querySelector('.settings-scroll')?.scrollTo({ top: 0, behavior: 'instant' })")
    await sleep(200)
    await expect(await settings.evaluate(READ_HEADER_LAYOUT)).toMatchObject({
      ok: true,
      railWidth: 216,
      actionsInside: true,
      chipInside: true,
      backInside: true,
      actionsClearOfTitle: true,
      headerAboveScroll: true,
      horizontalOverflow: false,
    })
    await settings.screenshot(join(ARTIFACTS_DIR, `settings-1200-header-${stamp}.png`))

    await settings.evaluate(
      "document.getElementById('section-network')?.scrollIntoView({ block: 'start', behavior: 'instant' })",
    )
    await sleep(250)
    await expect(await settings.evaluate(READ_STICKY_LAYOUT)).toMatchObject({
      ok: true,
      offset: 16,
      radius: '6px',
      sectionBelowStrip: true,
    })
    await expect(await settings.evaluate(READ_HEADER_LAYOUT)).toMatchObject({
      actionsInside: true,
      chipInside: true,
      backInside: true,
      headerAboveScroll: true,
      horizontalOverflow: false,
    })
    await settings.screenshot(join(ARTIFACTS_DIR, `settings-1200-network-${stamp}.png`))
  } finally {
    await desktop.close()
    await sensor.close()
  }
})
