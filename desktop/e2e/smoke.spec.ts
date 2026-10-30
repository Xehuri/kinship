import { existsSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { launchDesktop } from './helpers/electron.ts'

test('launches a single desktop window with the Kinship title', async () => {
  const desktop = await launchDesktop()
  try {
    expect(desktop.window.isClosed()).toBe(false)
    expect(desktop.window.url()).toBe('about:blank')

    const windowCount = await desktop.app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    )
    expect(windowCount).toBe(1)

    const windowTitle = await desktop.app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle() ?? '',
    )
    expect(windowTitle).toMatch(/Kinship/)

    const menuIsNull = await desktop.app.evaluate(
      ({ Menu }) => Menu.getApplicationMenu() === null,
    )
    expect(menuIsNull).toBe(true)
    expect(existsSync(desktop.screenshotPath)).toBe(true)
    expect(desktop.userDataDir).toContain('axeuh-desktop-e2e-')
  } finally {
    await desktop.close()
  }
})
