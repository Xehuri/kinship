/**
 * Acceptance for the bridge's in-memory isolation report and the panel state
 * route that exposes it.
 *
 * `kinship-isolation` reports through the `kinshipBridge` service; the panel
 * reads the same snapshot from `/api/kinship/ui/state`. The real plugin is
 * mounted over a fake agent registry and a fake Connection, so these assertions
 * cover the production wiring instead of a re-implementation.
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { afterEach, describe, expect, it } from 'vitest'
import { Config, apply, inject, name } from '../../packages/kinship-bridge/src/index.js'
import type {
  IsolationReport,
  KinshipBridgeService,
} from '../../packages/kinship-bridge/src/index.js'
import { UI_STATE_PATH } from '../../packages/kinship-bridge/src/ui.js'

const homes: string[] = []
const bridges: MountedBridge[] = []
const previousHome = process.env['DSH_HOME']
const previousToken = process.env['KINSHIP_BRIDGE_TOKEN']

/** One route the fake Connection captured, in the shape `installUiRoutes` registers. */
interface RegisteredRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: string
  readonly fetch: (request: Request) => Promise<Response>
}

/** One mounted plugin: the service and the panel routes it registered. */
interface MountedBridge {
  readonly service: KinshipBridgeService
  readonly routes: RegisteredRoute[]
  dispose(): Promise<void>
}

/** 一份 kinship-isolation 上报，字段与共享契约一致。 */
function report(instance: string, active = true): IsolationReport {
  return {
    schema: 1,
    instance,
    active,
    preset: 'kinship',
    updatedAt: 1_794_759_000_000,
    sections: [{ name: 'memory:index', shadowed: true }],
    tools: [{ prefix: 'memory_', denied: ['memory_search'], pending: false }],
    errors: [],
  }
}

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'kinship-isolation-'))
  homes.push(home)
  return home
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the panel routes')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/**
 * Mount the real plugin over a fake empty agent registry.
 *
 * The panel routes exist only in compositions that serve the Web client, so a
 * fake `connection` records what they register; the state route then answers
 * with the same in-memory report the service holds.
 */
async function mount(home: string): Promise<MountedBridge> {
  process.env['DSH_HOME'] = home
  process.env['KINSHIP_BRIDGE_TOKEN'] = 'test-token'
  const routes: RegisteredRoute[] = []
  const ctx = new Context()
  ctx.provide('agents', {
    list: () => [],
    get: () => undefined,
  })
  ctx.provide('connection', {
    fetch: {
      register: (route: RegisteredRoute) => {
        routes.push(route)
        return async () => {}
      },
    },
  } as never)
  const fiber = ctx.plugin({ name, inject, apply, Config }, {
    host: '127.0.0.1',
    port: 0,
    tokenEnv: 'KINSHIP_BRIDGE_TOKEN',
    tokenFile: '',
    policy: 'first',
    sessionId: '',
    rebindOnMissing: false,
    bodyLimitBytes: 64 * 1024,
  })
  await fiber

  const service = ctx.get('kinshipBridge')
  if (service === undefined) throw new Error('kinship bridge service missing')
  await waitFor(() => routes.some(route => route.path === UI_STATE_PATH))

  let disposed = false
  const mounted: MountedBridge = {
    service,
    routes,
    dispose: async () => {
      if (disposed) return
      disposed = true
      await fiber.dispose()
    },
  }
  bridges.push(mounted)
  return mounted
}

/** Read the panel snapshot through the route the browser would call. */
async function state(bridge: MountedBridge): Promise<Record<string, unknown>> {
  const route = bridge.routes.find(entry => entry.path === UI_STATE_PATH)
  if (route === undefined) throw new Error('state route is not registered')
  const response = await route.fetch(new Request(`http://127.0.0.1${UI_STATE_PATH}`))
  expect(response.status).toBe(200)
  return await response.json() as Record<string, unknown>
}

afterEach(async () => {
  for (const bridge of bridges.splice(0).reverse()) await bridge.dispose()
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  if (previousToken === undefined) delete process.env['KINSHIP_BRIDGE_TOKEN']
  else process.env['KINSHIP_BRIDGE_TOKEN'] = previousToken
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('kinship bridge isolation report', () => {
  it('reports null until kinship-isolation pushes a snapshot', async () => {
    const home = tempHome()
    const bridge = await mount(home)

    const empty = await state(bridge)
    expect(empty).toHaveProperty('isolation')
    expect(empty['isolation']).toBeNull()

    const pushed = report('instance-a')
    bridge.service.reportIsolation(pushed)
    const answered = await state(bridge)
    expect(answered['isolation']).toEqual(pushed)

    // 报告是内存态：DSH_HOME 下没有任何排异状态文件。
    const files = readdirSync(home, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
    expect(files.some(file => file.includes('isolation'))).toBe(false)
  })

  it('replaces the report and clears only the matching instance', async () => {
    const bridge = await mount(tempHome())
    const first = report('instance-a')
    const second = report('instance-b', false)

    bridge.service.reportIsolation(first)
    expect((await state(bridge))['isolation']).toEqual(first)

    // HMR：新实例直接替换旧报告，旧实例卸载时不能删掉新实例的状态。
    bridge.service.reportIsolation(second)
    expect((await state(bridge))['isolation']).toEqual(second)

    bridge.service.clearIsolation(first.instance)
    expect((await state(bridge))['isolation']).toEqual(second)

    bridge.service.clearIsolation(second.instance)
    expect((await state(bridge))['isolation']).toBeNull()

    // 空存储上清除任意实例都是幂等的。
    bridge.service.clearIsolation(second.instance)
    expect((await state(bridge))['isolation']).toBeNull()

    // 同一实例也可以先上报再清除，不需要先清空。
    bridge.service.reportIsolation(first)
    bridge.service.clearIsolation(first.instance)
    expect((await state(bridge))['isolation']).toBeNull()
  })
})
