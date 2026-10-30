import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright'
import type { ElectronApplication, Page } from 'playwright'

const HELPER_DIR = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(HELPER_DIR, '..', '..')
export const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR ?? join(tmpdir(), 'kinship-desktop-qa')
const POLL_INTERVAL_MS = 100
const WINDOW_TIMEOUT_MS = 20_000

export interface LaunchDesktopOptions {
  readonly env?: Readonly<Record<string, string>>
  readonly args?: readonly string[]
  readonly prepareUserData?: (userDataDir: string) => void
  readonly waitForSpa?: boolean
}

export interface DesktopHandle {
  readonly app: ElectronApplication
  readonly window: Page
  readonly userDataDir: string
  readonly logs: readonly string[]
  readonly screenshotPath: string
  readonly close: () => Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function readSettingsUrl(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(() => {
    const qa = globalThis.__AXEUH_QA__
    if (qa === undefined) return null
    const settings = qa.controller.getSettingsWebContents()
    if (settings === null || settings.isDestroyed()) return null
    const url = settings.getURL()
    return url.length > 0 ? url : null
  })
}

/**
 * 单窗口架构下设置页是 WebContentsView，Playwright 会把它也暴露成 Page。
 * 这里按设置页 URL 排除它，返回 BrowserWindow 自身的 SPA 页面。
 */
async function waitForAnyWindow(
  app: ElectronApplication,
  timeoutMs = WINDOW_TIMEOUT_MS,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pages = app.windows()
    if (pages.length > 0) return pages[0]
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error('等待桌面窗口超时')
}

async function waitForSpaWindow(
  app: ElectronApplication,
  timeoutMs = WINDOW_TIMEOUT_MS,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pages = app.windows()
    const settingsUrl = await readSettingsUrl(app)
    if (settingsUrl === null) {
      if (pages.length === 1) return pages[0]
    } else {
      const settingsPage = pages.find((page) => page.url() === settingsUrl)
      const spaPage = pages.find((page) => page !== settingsPage)
      if (settingsPage !== undefined && spaPage !== undefined) return spaPage
    }
    await sleep(POLL_INTERVAL_MS)
  }

  const urls = app.windows().map((page) => page.url())
  throw new Error(`等待 SPA 窗口超时；当前页面：${urls.join(' | ')}`)
}

export async function launchDesktop(options: LaunchDesktopOptions = {}): Promise<DesktopHandle> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'axeuh-desktop-e2e-'))
  options.prepareUserData?.(userDataDir)
  mkdirSync(ARTIFACTS_DIR, { recursive: true })

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  Object.assign(
    env,
    {
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      AXEUH_QA: '1',
      AXEUH_USER_DATA_DIR: userDataDir,
    },
    options.env,
  )

  const app = await _electron.launch({
    args: ['.', '--no-sandbox', `--user-data-dir=${userDataDir}`, ...(options.args ?? [])],
    cwd: DESKTOP_ROOT,
    env,
  })

  const logs: string[] = []
  app.on('console', (message) => {
    logs.push(`[main:${message.type()}] ${message.text()}`)
  })

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }

  try {
    const window =
      options.waitForSpa === false
        ? await waitForAnyWindow(app)
        : await waitForSpaWindow(app)
    window.on('console', (message) => {
      logs.push(`[renderer:${message.type()}] ${message.text()}`)
    })
    window.on('pageerror', (error) => {
      logs.push(`[pageerror] ${error.message}`)
    })
    await window.waitForLoadState('domcontentloaded')

    const screenshotPath = join(ARTIFACTS_DIR, `desktop-${Date.now()}.png`)
    try {
      await window.screenshot({ path: screenshotPath, timeout: 5_000 })
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error'
      logs.push(`[screenshot] skipped: ${reason}`)
    }

    return { app, window, userDataDir, logs, screenshotPath, close }
  } catch (error) {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
    throw error
  }
}
