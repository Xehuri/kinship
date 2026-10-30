// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../src/shared/ipc'
import type { AppController } from '../../src/main/app-controller'
import type { SensorPaths } from '../../src/main/lib/sensor-paths'
import type { SensorSupervisor } from '../../src/main/lib/sensor-supervisor'
import type { SensorStatus } from '../../src/shared/types'

const electronHarness = vi.hoisted(() => {
  type Handler = (
    event: { readonly sender: { readonly id: number } },
    ...args: unknown[]
  ) => Promise<unknown>

  const handlers = new Map<string, Handler>()
  return {
    handlers,
    ipcMain: {
      removeHandler(channel: string): void {
        handlers.delete(channel)
      },
      handle(channel: string, handler: Handler): void {
        handlers.set(channel, handler)
      },
    },
    shell: { openPath: vi.fn(async () => '') },
    app: { getPath: () => '/tmp/axeuh-ipc-reset-test' },
    BrowserWindow: class {},
  }
})

vi.mock('electron', () => electronHarness)

const { registerIpcHandlers } = await import('../../src/main/ipc/handlers')

function createPaths(root: string): SensorPaths {
  const runtimeDir = join(root, 'runtime')
  const appDir = join(root, 'app')
  const dataDir = join(root, 'data')
  return {
    rootDir: root,
    candidateRoots: [root],
    runtimeDir,
    appDir,
    pythonExe: join(runtimeDir, 'python.exe'),
    appScript: join(appDir, 'pc_sensor_app.py'),
    dataDir,
    agentConfigPath: join(dataDir, 'config.json'),
    collectionConfigPath: join(dataDir, 'pc_sensor_config.json'),
    logPath: join(dataDir, 'pc-sensor.log'),
    caBundlePath: join(root, 'ca-bundle.pem'),
  }
}

describe('reset-all IPC', () => {
  let directory = ''
  let paths: SensorPaths
  const status: SensorStatus = {
    state: 'stopped',
    enabled: false,
    running: false,
    port: 18888,
    panelUrl: 'http://127.0.0.1:18888/pc-config',
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'axeuh-ipc-reset-'))
    paths = createPaths(directory)
    mkdirSync(paths.dataDir, { recursive: true })
    electronHarness.handlers.clear()
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  function setup() {
    const order: string[] = []
    const supervisor = {
      stop: vi.fn(async () => {
        order.push('stop')
      }),
      resetLocalState: vi.fn(() => {
        order.push('resetLocalState')
      }),
      getStatus: vi.fn(async () => status),
    }
    const controller = {
      getSettingsWebContents: () => ({ id: 7 }),
      resetAll: vi.fn(async () => {
        order.push('resetAll')
      }),
    } as unknown as AppController
    const setLastStatus = vi.fn()
    const broadcastStatus = vi.fn()
    const resetAuthState = vi.fn(() => {
      order.push('resetAuthState')
    })

    registerIpcHandlers({
      controller,
      supervisor: supervisor as unknown as SensorSupervisor,
      paths,
      getLastStatus: () => status,
      setLastStatus,
      broadcastStatus,
      resetAuthState,
    })

    return { order, supervisor, controller, setLastStatus, broadcastStatus, resetAuthState }
  }

  it('stops the sensor, deletes configs, resets auth and desktop config, then returns setup', async () => {
    writeFileSync(paths.agentConfigPath, '{"agent_token":"secret"}', 'utf8')
    writeFileSync(paths.collectionConfigPath, '{"backend_token":"secret"}', 'utf8')
    writeFileSync(paths.caBundlePath, '-----BEGIN CERTIFICATE-----', 'utf8')
    writeFileSync(paths.logPath, 'keep', 'utf8')
    const { order, supervisor, controller, setLastStatus, broadcastStatus, resetAuthState } =
      setup()
    const handler = electronHarness.handlers.get(IPC.APP_RESET_ALL)

    const result = await handler?.({ sender: { id: 7 } })

    expect(result).toEqual({ ok: true, data: undefined })
    expect(supervisor.stop).toHaveBeenCalledTimes(1)
    expect(supervisor.resetLocalState).toHaveBeenCalledTimes(1)
    expect(resetAuthState).toHaveBeenCalledTimes(1)
    expect(controller.resetAll).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['stop', 'resetLocalState', 'resetAuthState', 'resetAll'])
    expect(existsSync(paths.agentConfigPath)).toBe(false)
    expect(existsSync(paths.collectionConfigPath)).toBe(false)
    expect(existsSync(paths.caBundlePath)).toBe(false)
    expect(existsSync(paths.logPath)).toBe(true)
    expect(setLastStatus).toHaveBeenCalledWith(status)
    expect(broadcastStatus).toHaveBeenCalledWith(status)
  })

  it('still resets desktop config but reports RESET_FAILED when sensor config deletion fails', async () => {
    mkdirSync(paths.agentConfigPath)
    const { controller } = setup()
    const handler = electronHarness.handlers.get(IPC.APP_RESET_ALL)

    const result = await handler?.({ sender: { id: 7 } })

    expect(result).toMatchObject({ ok: false, code: 'RESET_FAILED' })
    expect(controller.resetAll).toHaveBeenCalledTimes(1)
  })

  it('rejects senders other than the settings view', async () => {
    const { supervisor, controller, resetAuthState } = setup()
    const handler = electronHarness.handlers.get(IPC.APP_RESET_ALL)

    const result = await handler?.({ sender: { id: 99 } })

    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(supervisor.stop).not.toHaveBeenCalled()
    expect(resetAuthState).not.toHaveBeenCalled()
    expect(controller.resetAll).not.toHaveBeenCalled()
  })
})
