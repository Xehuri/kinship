import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Config,
  apply,
  inject,
  name,
} from '../../packages/kinship-bridge/src/index.js'
import type { KinshipBridgeService } from '../../packages/kinship-bridge/src/index.js'
import type { PushedPaths } from '../../packages/kinship-bridge/src/paths.js'

const homes: string[] = []
const bridges: MountedBridge[] = []
const previousHome = process.env['DSH_HOME']
const previousToken = process.env['KINSHIP_BRIDGE_TOKEN']

/** One mounted plugin: the service, the root context, and its HTTP base URL. */
interface MountedBridge {
  readonly ctx: Context
  readonly service: KinshipBridgeService
  readonly base: string
  dispose(): Promise<void>
}

/** Projection of every JSON body these routes can answer with. */
interface PathsResponse {
  readonly ok?: boolean
  readonly schema?: number
  readonly ai_root?: string
  readonly data_dir?: string
  readonly plan_root?: string
  readonly plan_master?: string
  readonly source?: string
  readonly generated_at?: number
  readonly stored_at?: number
  readonly error?: string
}

/** The push the Kinship backend sends for one deployment. */
const PUSH: PushedPaths = {
  schema: 1,
  ai_root: '/srv/kinship/ai',
  data_dir: '/srv/kinship/ai/data',
  plan_root: '/srv/kinship/ai/data/plan',
  plan_master: '/srv/kinship/ai/data/plan/master.json',
  source: 'kinship-backend',
  generated_at: 1_794_759_000_000,
}

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'kinship-paths-'))
  homes.push(home)
  return home
}

function pathsFile(home: string): string {
  return join(home, 'kinship', 'paths.json')
}

/**
 * Mount the real plugin over a fake empty agent registry.
 *
 * The paths routes never bind a Session, so an empty registry is enough; the
 * token comes from the environment the plugin's default row reads.
 */
async function mount(home: string): Promise<MountedBridge> {
  process.env['DSH_HOME'] = home
  process.env['KINSHIP_BRIDGE_TOKEN'] = 'test-token'
  const ctx = new Context()
  ctx.provide('agents', {
    list: () => [],
    get: () => undefined,
  })
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
  let disposed = false
  const mounted: MountedBridge = {
    ctx,
    service,
    base: `http://127.0.0.1:${String(service.port())}`,
    dispose: async () => {
      if (disposed) return
      disposed = true
      await fiber.dispose()
    },
  }
  bridges.push(mounted)
  return mounted
}

async function call(
  base: string,
  path: string,
  options: RequestInit & { readonly auth?: boolean } = {},
): Promise<{ readonly status: number, readonly body: PathsResponse }> {
  const { auth = true, ...init } = options
  const headers = new Headers(init.headers)
  if (auth) headers.set('authorization', 'Bearer test-token')
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  const response = await fetch(`${base}${path}`, { ...init, headers })
  const text = await response.text()
  const body = (text === '' ? {} : JSON.parse(text)) as PathsResponse
  return { status: response.status, body }
}

afterEach(async () => {
  for (const bridge of bridges.splice(0).reverse()) await bridge.dispose()
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  if (previousToken === undefined) delete process.env['KINSHIP_BRIDGE_TOKEN']
  else process.env['KINSHIP_BRIDGE_TOKEN'] = previousToken
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('kinship paths route', () => {
  it('stores a pushed document, exposes it, and reads it back', async () => {
    const home = tempHome()
    const bridge = await mount(home)
    const before = Date.now()

    const pushed = await call(bridge.base, '/v1/kinship/paths', {
      method: 'POST',
      body: JSON.stringify(PUSH),
    })
    expect(pushed.status).toBe(200)
    expect(pushed.body).toMatchObject({ ok: true, ...PUSH })
    const storedAt = pushed.body.stored_at
    if (storedAt === undefined) throw new Error('missing stored_at')
    expect(typeof storedAt).toBe('number')
    expect(storedAt).toBeGreaterThanOrEqual(before)

    const file = pathsFile(home)
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ...PUSH, stored_at: storedAt })
    expect(statSync(file).mode & 0o777).toBe(0o600)

    expect(bridge.service.paths()).toEqual({ ...PUSH, stored_at: storedAt })

    const fetched = await call(bridge.base, '/v1/kinship/paths')
    expect(fetched.status).toBe(200)
    expect(fetched.body).toEqual({ ...PUSH, stored_at: storedAt })
  })

  it('accepts a push without the optional plan_master', async () => {
    const home = tempHome()
    const bridge = await mount(home)
    const withoutMaster: PushedPaths = {
      schema: 1,
      ai_root: PUSH.ai_root,
      data_dir: PUSH.data_dir,
      plan_root: PUSH.plan_root,
      source: PUSH.source,
      generated_at: PUSH.generated_at,
    }

    const pushed = await call(bridge.base, '/v1/kinship/paths', {
      method: 'POST',
      body: JSON.stringify(withoutMaster),
    })
    expect(pushed.status).toBe(200)
    expect(pushed.body).toMatchObject({ ok: true, ...withoutMaster })
    expect('plan_master' in pushed.body).toBe(false)

    const persisted = JSON.parse(readFileSync(pathsFile(home), 'utf8')) as Record<string, unknown>
    expect('plan_master' in persisted).toBe(false)
    const fetched = await call(bridge.base, '/v1/kinship/paths')
    expect(fetched.status).toBe(200)
    expect('plan_master' in fetched.body).toBe(false)
  })

  it('rejects invalid pushes without writing the file', async () => {
    const home = tempHome()
    const bridge = await mount(home)
    const file = pathsFile(home)

    const rejected: { readonly name: string, readonly body: string }[] = [
      {
        name: 'relative ai_root',
        body: JSON.stringify({ ...PUSH, ai_root: 'relative/ai' }),
      },
      {
        name: 'wrong schema',
        body: JSON.stringify({ ...PUSH, schema: 2 }),
      },
      {
        name: 'missing source',
        body: JSON.stringify({
          schema: PUSH.schema,
          ai_root: PUSH.ai_root,
          data_dir: PUSH.data_dir,
          plan_root: PUSH.plan_root,
          plan_master: PUSH.plan_master,
          generated_at: PUSH.generated_at,
        }),
      },
      {
        name: 'non-integer generated_at',
        body: JSON.stringify({ ...PUSH, generated_at: 1.5 }),
      },
      {
        name: 'malformed JSON',
        body: '{not-json',
      },
    ]

    for (const attempt of rejected) {
      const result = await call(bridge.base, '/v1/kinship/paths', {
        method: 'POST',
        body: attempt.body,
      })
      expect(result.status, attempt.name).toBe(400)
      if (attempt.name !== 'malformed JSON') {
        expect(result.body, attempt.name).toMatchObject({ error: 'bad_request' })
      }
    }

    expect(existsSync(file)).toBe(false)
    expect(bridge.service.paths()).toBeNull()
  })

  it('answers 404 before the first push and requires the bearer token', async () => {
    const home = tempHome()
    const bridge = await mount(home)

    const unauthorized = await call(bridge.base, '/v1/kinship/paths', { auth: false })
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.body).toMatchObject({ error: 'unauthorized' })

    const fetched = await call(bridge.base, '/v1/kinship/paths')
    expect(fetched.status).toBe(404)
    expect(fetched.body).toEqual({ error: 'not_found' })
    expect(bridge.service.paths()).toBeNull()
  })

  it('replays the persisted document after a restart', async () => {
    const home = tempHome()
    const first = await mount(home)
    const pushed = await call(first.base, '/v1/kinship/paths', {
      method: 'POST',
      body: JSON.stringify(PUSH),
    })
    expect(pushed.status).toBe(200)
    const storedAt = pushed.body.stored_at
    await first.dispose()

    const second = await mount(home)
    expect(second.service.paths()).toEqual({ ...PUSH, stored_at: storedAt })
    const fetched = await call(second.base, '/v1/kinship/paths')
    expect(fetched.status).toBe(200)
    expect(fetched.body).toEqual({ ...PUSH, stored_at: storedAt })
  })

  it('ignores a corrupt persisted file and keeps mounting', async () => {
    const home = tempHome()
    const file = pathsFile(home)
    mkdirSync(join(home, 'kinship'), { recursive: true })
    writeFileSync(file, '{not-json', 'utf8')

    const bridge = await mount(home)

    expect(bridge.service.paths()).toBeNull()
    const fetched = await call(bridge.base, '/v1/kinship/paths')
    expect(fetched.status).toBe(404)
    expect(fetched.body).toEqual({ error: 'not_found' })
    expect(readFileSync(file, 'utf8')).toBe('{not-json')

    const warnings = bridge.ctx.logger.buffer.filter(message => message.type === 'warn')
    const named = warnings.filter(message =>
      message.args.some(argument => String(argument).includes('paths.json')),
    )
    expect(named.length).toBeGreaterThan(0)
  })

  it('emits kinship/paths for an accepted push', async () => {
    const home = tempHome()
    const bridge = await mount(home)
    const received: (PushedPaths | null)[] = []
    const off = bridge.ctx.on('kinship/paths', (value) => {
      received.push(value)
    })

    try {
      const pushed = await call(bridge.base, '/v1/kinship/paths', {
        method: 'POST',
        body: JSON.stringify(PUSH),
      })
      expect(pushed.status).toBe(200)
      expect(received).toEqual([{ ...PUSH, stored_at: pushed.body.stored_at }])
      expect(JSON.parse(JSON.stringify(received[0]))).toEqual(received[0])
    } finally {
      off()
    }
  })
})
