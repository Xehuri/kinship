// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopConfigManager } from '../../src/main/app-config'

const harness = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void

  interface FakeWindow {
    readonly destroy: ReturnType<typeof vi.fn>
    readonly close: ReturnType<typeof vi.fn>
    readonly isDestroyed: () => boolean
    readonly isMinimized: () => boolean
    readonly restore: ReturnType<typeof vi.fn>
    readonly show: ReturnType<typeof vi.fn>
    readonly focus: ReturnType<typeof vi.fn>
    readonly hide: ReturnType<typeof vi.fn>
    readonly getBounds: () => { x: number; y: number; width: number; height: number }
    readonly getContentBounds: () => { x: number; y: number; width: number; height: number }
    readonly setContentBounds: (bounds: {
      x: number
      y: number
      width: number
      height: number
    }) => void
    readonly on: ReturnType<typeof vi.fn>
    readonly once: (event: string, handler: Handler) => void
    readonly contentView: {
      readonly addChildView: ReturnType<typeof vi.fn>
      readonly removeChildView: ReturnType<typeof vi.fn>
    }
    readonly webContents: {
      readonly id: number
      readonly reload: ReturnType<typeof vi.fn>
      readonly isDestroyed: () => boolean
    }
  }

  interface FakeSettingsView {
    readonly webContents: {
      readonly id: number
      readonly loadURL: (url: string) => Promise<void>
      readonly close: ReturnType<typeof vi.fn>
      readonly isDestroyed: () => boolean
    }
    readonly setBounds: ReturnType<typeof vi.fn>
  }

  const windows: FakeWindow[] = []
  const settingsViews: FakeSettingsView[] = []

  const createWindow = (): FakeWindow => {
    let destroyed = false
    let contentBounds = { x: 0, y: 0, width: 1200, height: 820 }
    const handlers = new Map<string, Handler[]>()

    const addHandler = (event: string, handler: Handler): void => {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
    }

    const window: FakeWindow = {
      destroy: vi.fn(() => {
        destroyed = true
        for (const handler of handlers.get('closed') ?? []) handler()
      }),
      close: vi.fn(),
      isDestroyed: (): boolean => destroyed,
      isMinimized: (): boolean => false,
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      hide: vi.fn(),
      getBounds: () => ({ x: 0, y: 0, width: 1200, height: 820 }),
      getContentBounds: () => contentBounds,
      setContentBounds: (bounds): void => {
        contentBounds = bounds
      },
      on: vi.fn((event: string, handler: Handler): void => addHandler(event, handler)),
      once: (event: string, handler: Handler): void => addHandler(event, handler),
      contentView: {
        addChildView: vi.fn(),
        removeChildView: vi.fn(),
      },
      webContents: {
        id: windows.length + 100,
        reload: vi.fn(),
        isDestroyed: (): boolean => destroyed,
      },
    }

    windows.push(window)
    return window
  }

  const createSettingsView = (): FakeSettingsView => {
    let destroyed = false
    const view: FakeSettingsView = {
      webContents: {
        id: settingsViews.length + 500,
        loadURL: vi.fn(async () => {
          await Promise.resolve()
        }),
        close: vi.fn(() => {
          destroyed = true
        }),
        isDestroyed: (): boolean => destroyed,
      },
      setBounds: vi.fn(),
    }
    settingsViews.push(view)
    return view
  }

  return { windows, settingsViews, createWindow, createSettingsView }
})

vi.mock('electron', () => ({
  screen: {
    getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }],
  },
  BrowserWindow: class {},
  WebContentsView: class {},
}))

vi.mock('../../src/main/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../src/main/windows/main-window', () => ({
  createDesktopWindow: vi.fn(() => harness.createWindow()),
  loadMainUrl: vi.fn(),
}))

vi.mock('../../src/main/windows/settings-view', () => ({
  createSettingsView: vi.fn(() => harness.createSettingsView()),
}))

import { createDesktopWindow, loadMainUrl } from '../../src/main/windows/main-window'
import { createSettingsView } from '../../src/main/windows/settings-view'
import { DesktopWindowManager } from '../../src/main/windows/window-manager'

interface ConfigStub {
  readonly config: DesktopConfigManager
  readonly saveBounds: ReturnType<typeof vi.fn>
  readonly saveLastHash: ReturnType<typeof vi.fn>
  setServerUrl(url: string): void
}

function makeConfig(initialUrl = 'https://example.com'): ConfigStub {
  let serverUrl = initialUrl
  const saveBounds = vi.fn()
  const saveLastHash = vi.fn()
  const config = {
    getServerUrl: (): string => serverUrl,
    getServerOrigin: (): string | null =>
      serverUrl.length > 0 ? new URL(serverUrl).origin : null,
    getBounds: (): undefined => undefined,
    getLastHash: (): undefined => undefined,
    saveBounds,
    saveLastHash,
  }
  return {
    config: config as unknown as DesktopConfigManager,
    saveBounds,
    saveLastHash,
    setServerUrl: (url: string): void => {
      serverUrl = url
    },
  }
}

function makeManager(config: ConfigStub): DesktopWindowManager {
  return new DesktopWindowManager({
    config: config.config,
    mainPartition: 'persist:test-main',
    controlPartition: 'persist:test-control',
    preloadPath: '/tmp/axeuh-preload.js',
  })
}

function createdSettingsView(): NonNullable<ReturnType<typeof harness.createSettingsView>> {
  const view = harness.settingsViews[0]
  if (view === undefined) throw new Error('settings view was not created')
  return view
}

describe('DesktopWindowManager', () => {
  beforeEach(() => {
    harness.windows.length = 0
    harness.settingsViews.length = 0
    vi.mocked(createDesktopWindow).mockClear()
    vi.mocked(loadMainUrl).mockClear()
    vi.mocked(createSettingsView).mockClear()
  })

  it('creates exactly one BrowserWindow and loads no SPA URL by default', () => {
    const config = makeConfig('')
    const manager = makeManager(config)

    const window = manager.ensureWindow()

    expect(harness.windows).toHaveLength(1)
    expect(window).toBe(harness.windows[0])
    expect(createDesktopWindow).toHaveBeenCalledTimes(1)
    expect(createDesktopWindow).toHaveBeenCalledWith(
      expect.objectContaining({ partition: 'persist:test-main' }),
    )
    expect(loadMainUrl).not.toHaveBeenCalled()
  })

  it('reuses the existing window when ensureWindow is called repeatedly', () => {
    const manager = makeManager(makeConfig())

    const first = manager.ensureWindow()
    const second = manager.ensureWindow()

    expect(first).toBe(second)
    expect(harness.windows).toHaveLength(1)
    expect(createDesktopWindow).toHaveBeenCalledTimes(1)
  })

  it('opens setup on first run by mounting the settings view over an about:blank window', async () => {
    const config = makeConfig('')
    const manager = makeManager(config)

    await manager.openControl('setup')

    expect(harness.windows).toHaveLength(1)
    expect(loadMainUrl).not.toHaveBeenCalled()

    const view = createdSettingsView()
    expect(view.webContents.loadURL).toHaveBeenCalledWith('axeuh://bundle/index.html#/setup')
    expect(harness.windows[0]?.contentView.addChildView).toHaveBeenCalledWith(view)
    expect(view.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1200, height: 820 })
    expect(harness.windows[0]?.show).toHaveBeenCalled()
    expect(harness.windows[0]?.focus).toHaveBeenCalled()
  })

  it('reuses the settings view for later routes in the same window', async () => {
    const manager = makeManager(makeConfig())

    await manager.openControl('settings')
    await manager.openControl('error', { code: 'CERT_INVALID', message: '证书无效' })

    expect(harness.windows).toHaveLength(1)
    expect(createSettingsView).toHaveBeenCalledTimes(1)
    const view = createdSettingsView()
    expect(view.webContents.loadURL).toHaveBeenLastCalledWith(
      'axeuh://bundle/index.html#/error?code=CERT_INVALID&message=%E8%AF%81%E4%B9%A6%E6%97%A0%E6%95%88',
    )
    expect(harness.windows[0]?.contentView.addChildView).toHaveBeenCalledTimes(2)
  })

  it('showMain removes the settings view, loads the SPA in the same window, and focuses it', async () => {
    const config = makeConfig('https://example.com')
    const manager = makeManager(config)
    await manager.openControl('settings')

    manager.showMain()

    const window = harness.windows[0]
    const view = createdSettingsView()
    expect(window?.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(loadMainUrl).toHaveBeenCalledWith(window, 'https://example.com', undefined)
    expect(window?.show).toHaveBeenCalled()
    expect(window?.focus).toHaveBeenCalled()
    expect(manager.getSettingsWebContents()?.id).toBe(view.webContents.id)
  })

  it('does not load the SPA from showMain when no server URL is configured', async () => {
    const config = makeConfig('')
    const manager = makeManager(config)
    await manager.openControl('setup')

    manager.showMain()

    expect(loadMainUrl).not.toHaveBeenCalled()
    expect(harness.windows[0]?.contentView.removeChildView).toHaveBeenCalled()
  })

  it('does not reload the SPA again when it is already loaded for the current server', async () => {
    const manager = makeManager(makeConfig('https://example.com'))
    await manager.openControl('settings')
    manager.showMain()

    manager.showMain()

    expect(loadMainUrl).toHaveBeenCalledTimes(1)
  })

  it('reloads the SPA when the server URL changes without destroying the window', async () => {
    const config = makeConfig('https://example.com')
    const manager = makeManager(config)
    await manager.openControl('settings')
    manager.showMain()

    config.setServerUrl('https://other.example')
    manager.reloadMain()

    expect(harness.windows).toHaveLength(1)
    expect(harness.windows[0]?.destroy).not.toHaveBeenCalled()
    expect(loadMainUrl).toHaveBeenLastCalledWith(
      harness.windows[0],
      'https://other.example',
      undefined,
    )
  })

  it('resizes the settings view with the window content bounds', async () => {
    const manager = makeManager(makeConfig())
    await manager.openControl('settings')
    const window = harness.windows[0]
    const view = createdSettingsView()

    const resizeHandlers = window?.on.mock.calls
      .filter(([event]) => event === 'resize')
      .map(([, handler]) => handler as () => void)
    expect(resizeHandlers).toHaveLength(1)

    const bounds = { x: 0, y: 0, width: 1400, height: 900 }
    window?.setContentBounds(bounds)
    resizeHandlers[0]?.()

    expect(view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1400, height: 900 })
  })

  it('opens the error route full-window when the SPA load fails', async () => {
    const config = makeConfig('https://example.com')
    const manager = makeManager(config)

    await manager.notifyMainLoadFailed('CERT_UNTRUSTED', '证书不受信任', 'https://example.com/mobile/')

    expect(harness.windows).toHaveLength(1)
    expect(loadMainUrl).not.toHaveBeenCalled()
    const view = createdSettingsView()
    expect(view.webContents.loadURL).toHaveBeenCalledWith(
      'axeuh://bundle/index.html#/error?code=CERT_UNTRUSTED&message=%E8%AF%81%E4%B9%A6%E4%B8%8D%E5%8F%97%E4%BF%A1%E4%BB%BB&url=https%3A%2F%2Fexample.com%2Fmobile%2F',
    )
    expect(harness.windows[0]?.contentView.addChildView).toHaveBeenCalledWith(view)
  })

  it('clears window and settings refs when the window is destroyed', async () => {
    const manager = makeManager(makeConfig())
    await manager.openControl('settings')
    const window = harness.windows[0]
    const view = createdSettingsView()

    window?.destroy()

    expect(manager.getMainWindow()).toBeNull()
    expect(manager.getSettingsWebContents()).toBeNull()
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
  })

  it('destroys the single window and closes the settings view through closeMainWindow', async () => {
    const manager = makeManager(makeConfig())
    await manager.openControl('settings')
    const window = harness.windows[0]
    const view = createdSettingsView()

    manager.closeMainWindow()

    expect(window?.destroy).toHaveBeenCalledTimes(1)
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
    expect(manager.getMainWindow()).toBeNull()
    expect(manager.getSettingsWebContents()).toBeNull()
  })

  it('reports no settings webContents before the view exists', () => {
    const manager = makeManager(makeConfig())
    expect(manager.getSettingsWebContents()).toBeNull()
  })
})
