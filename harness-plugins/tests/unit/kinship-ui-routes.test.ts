import { describe, expect, it } from 'vitest'
import { BridgeError } from '../../packages/kinship-bridge/src/errors.js'
import {
  UI_BIND_PATH,
  UI_CONFIG_PATH,
  UI_STATE_PATH,
  UI_TOKEN_PATH,
  createUiRoutes,
  installUiRoutes,
  normalizeConfigPatch,
  UiError,
} from '../../packages/kinship-bridge/src/ui.js'
import type { UiApiDeps, UiConfigView, UiTokenInfo } from '../../packages/kinship-bridge/src/ui.js'
import type { BindingSnapshot, SessionCatalogRow } from '../../packages/kinship-bridge/src/types.js'

const CONFIG: UiConfigView = {
  host: '127.0.0.1',
  port: 18_766,
  tokenEnv: 'KINSHIP_BRIDGE_TOKEN',
  tokenFile: '',
  policy: 'first',
  sessionId: '',
  rebindOnMissing: false,
  bodyLimitBytes: 65_536,
}

const TOKEN: UiTokenInfo = { source: 'env', env: 'KINSHIP_BRIDGE_TOKEN', path: null, length: 14 }

function row(id: string, createdAt: number, extra: Partial<SessionCatalogRow> = {}): SessionCatalogRow {
  return { id, createdAt, preset: 'kinship', isRoot: true, status: 'idle', title: null, cwd: null, ...extra }
}

function snapshot(sessionId: string | null, status: BindingSnapshot['status'] = 'bound'): BindingSnapshot {
  return { status: sessionId === null ? 'unbound' : status, sessionId, boundAt: sessionId === null ? null : 1, policy: 'first' }
}

interface Harness {
  readonly deps: UiApiDeps
  readonly saved: UiConfigView[]
}

function harness(options: {
  readonly sessions?: readonly SessionCatalogRow[]
  readonly binding?: BindingSnapshot
  readonly editable?: boolean
  readonly save?: (next: UiConfigView) => Promise<void>
  readonly bind?: (sessionId: string) => BindingSnapshot
} = {}): Harness {
  const saved: UiConfigView[] = []
  const binding = options.binding ?? snapshot('session-a')
  const sessions = options.sessions ?? [row('session-a', 10, { title: 'kinship主会话', cwd: '/ai' }), row('session-b', 20)]
  const deps: UiApiDeps = {
    host: {
      listSessions: () => sessions,
      catalog: () => sessions,
      getSession: () => undefined,
      subscribe: () => () => {},
    },
    binding: {
      snapshot: () => binding,
      currentSessionId: () => binding.sessionId,
      bind: options.bind ?? (() => binding),
      reconcile: () => binding,
      onChange: () => () => {},
    },
    bridge: () => ({ host: CONFIG.host, port: CONFIG.port, version: '0.1.0', dsh: '0.2.2-rc.3' }),
    config: () => CONFIG,
    editable: () => options.editable ?? true,
    tokenInfo: () => TOKEN,
    token: action => ({ token: action === 'reveal' ? 'test-env-token' : 'rotated-token', info: TOKEN }),
    saveConfig: async (next) => {
      saved.push(next)
      await options.save?.(next)
    },
    bind: options.bind ?? (() => binding),
  }
  return { deps, saved }
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

function post(path: string, payload: unknown): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

describe('kinship panel state', () => {
  it('reports the bridge, binding, token source and live Sessions oldest first', async () => {
    const { deps } = harness()
    const answer = await body(await createUiRoutes(deps).state())

    expect(answer['ok']).toBe(true)
    expect(answer['bridge']).toEqual({
      url: 'http://127.0.0.1:18766',
      host: '127.0.0.1',
      port: 18_766,
      version: '0.1.0',
      dsh: '0.2.2-rc.3',
    })
    expect(answer['binding']).toEqual(snapshot('session-a'))
    expect(answer['session']).toMatchObject({ id: 'session-a', title: 'kinship主会话', cwd: '/ai', bound: true })
    expect((answer['sessions'] as Array<Record<string, unknown>>).map(item => item['id'])).toEqual(['session-a', 'session-b'])
    expect(answer['token']).toEqual(TOKEN)
    expect(answer['config']).toEqual(CONFIG)
    expect(answer['editable']).toBe(true)
  })

  it('brackets an IPv6 listener and reports a missing bound Session', async () => {
    const { deps } = harness({ binding: snapshot('session-gone', 'bound_session_missing') })
    const missing = { ...deps, bridge: () => ({ host: '::1', port: 18_765, version: '0.1.0', dsh: 'x' }) }
    const answer = await body(await createUiRoutes(missing).state())
    expect((answer['bridge'] as Record<string, unknown>)['url']).toBe('http://[::1]:18765')
    expect(answer['session']).toBeNull()
    expect((answer['binding'] as Record<string, unknown>)['status']).toBe('bound_session_missing')
  })

  it('omits Sessions of other presets and subagent children', async () => {
    const sessions = [
      row('root-kinship', 1),
      row('other-preset', 2, { preset: 'standard' }),
      row('child', 3, { isRoot: false }),
    ]
    const { deps } = harness({ sessions, binding: snapshot(null) })
    const answer = await body(await createUiRoutes(deps).state())
    expect((answer['sessions'] as Array<Record<string, unknown>>).map(item => item['id'])).toEqual(['root-kinship'])
    expect(answer['session']).toBeNull()
  })
})

describe('kinship panel configuration writes', () => {
  it('merges a partial patch over the running configuration', async () => {
    const { deps, saved } = harness()
    const response = await createUiRoutes(deps).config(post(UI_CONFIG_PATH, {
      config: { port: 18_800, policy: 'manual', rebindOnMissing: true },
    }))
    expect(response.status).toBe(200)
    expect(await body(response)).toEqual({
      ok: true,
      config: { ...CONFIG, port: 18_800, policy: 'manual', rebindOnMissing: true },
      restarted: true,
    })
    expect(saved).toHaveLength(1)
    expect(saved[0]).toEqual({ ...CONFIG, port: 18_800, policy: 'manual', rebindOnMissing: true })
  })

  it('refuses an unknown field and a non-loopback address', async () => {
    const { deps, saved } = harness()
    const routes = createUiRoutes(deps)

    const unknown = await routes.config(post(UI_CONFIG_PATH, { config: { nope: 1 } }))
    expect(unknown.status).toBe(400)
    expect((await body(unknown))['error']).toMatchObject({ code: 'unknown_field' })

    const remote = await routes.config(post(UI_CONFIG_PATH, { config: { host: '0.0.0.0' } }))
    expect(remote.status).toBe(400)
    expect((await body(remote))['error']).toMatchObject({ code: 'invalid_config' })

    const badPort = await routes.config(post(UI_CONFIG_PATH, { config: { port: 70_000 } }))
    expect(badPort.status).toBe(400)

    expect(saved).toHaveLength(0)
  })

  it('reports the profile refusal when this deployment cannot persist', async () => {
    const { deps } = harness({ editable: false })
    const response = await createUiRoutes(deps).config(post(UI_CONFIG_PATH, { config: { port: 18_800 } }))
    expect(response.status).toBe(409)
    expect((await body(response))['error']).toMatchObject({ code: 'config_read_only' })
  })

  it('passes a configuration error through as a rejection', async () => {
    const { deps } = harness({
      save: async () => {
        throw new UiError(400, 'save_failed', 'Configuration for "kinship-bridge" is overridden by a home patch')
      },
    })
    const response = await createUiRoutes(deps).config(post(UI_CONFIG_PATH, { config: { port: 18_800 } }))
    expect(response.status).toBe(400)
    expect(await body(response)).toEqual({
      ok: false,
      error: { code: 'save_failed', message: 'Configuration for "kinship-bridge" is overridden by a home patch' },
    })
  })

  it('rejects a body without a config object', async () => {
    const { deps } = harness()
    const response = await createUiRoutes(deps).config(post(UI_CONFIG_PATH, { port: 1 }))
    expect(response.status).toBe(400)
    expect((await body(response))['error']).toMatchObject({ code: 'invalid_request' })
  })
})

describe('kinship panel token and binding actions', () => {
  it('reveals the token only when asked', async () => {
    const { deps } = harness()
    const routes = createUiRoutes(deps)
    const reveal = await routes.token(post(UI_TOKEN_PATH, { action: 'reveal' }))
    expect(await body(reveal)).toEqual({ ok: true, token: 'test-env-token', token_info: TOKEN })

    const rotate = await routes.token(post(UI_TOKEN_PATH, { action: 'rotate' }))
    expect(await body(rotate)).toEqual({ ok: true, token: 'rotated-token', token_info: TOKEN })

    const invalid = await routes.token(post(UI_TOKEN_PATH, { action: 'drop' }))
    expect(invalid.status).toBe(400)
  })

  it('binds a named Session and maps a contract refusal', async () => {
    const refused = () => { throw new BridgeError(404, 'session_not_found', 'No live session "nope".') }
    const { deps } = harness({ bind: refused })
    const response = await createUiRoutes(deps).bind(post(UI_BIND_PATH, { sessionId: 'nope' }))
    expect(response.status).toBe(404)
    expect(await body(response)).toEqual({ ok: false, error: { code: 'session_not_found', message: 'No live session "nope".' } })

    const ok = harness({ bind: id => snapshot(id) })
    const bound = await createUiRoutes(ok.deps).bind(post(UI_BIND_PATH, { sessionId: 'session-b' }))
    expect(bound.status).toBe(200)
    expect((await body(bound))['binding']).toEqual(snapshot('session-b'))
  })

  it('requires a session id', async () => {
    const { deps } = harness()
    const response = await createUiRoutes(deps).bind(post(UI_BIND_PATH, {}))
    expect(response.status).toBe(400)
    expect((await body(response))['error']).toMatchObject({ code: 'invalid_request' })
  })
})

describe('kinship panel route registration', () => {
  it('claims the four owner routes on the Connection channel', () => {
    const registered: Array<{ path: string, methods: readonly string[], requestBody: string }> = []
    const effects: Array<() => void> = []
    const ctx = {
      connection: {
        fetch: {
          register: (route: { path: string, methods: readonly string[], requestBody: string }) => {
            registered.push(route)
            return async () => {}
          },
        },
      },
      effect: (callback: () => () => void) => {
        effects.push(callback())
        return () => {}
      },
    }
    installUiRoutes(ctx as never, harness().deps)
    expect(registered.map(route => route.path)).toEqual([UI_STATE_PATH, UI_CONFIG_PATH, UI_TOKEN_PATH, UI_BIND_PATH])
    expect(registered.map(route => route.methods)).toEqual([['GET'], ['POST'], ['POST'], ['POST']])
    expect(registered.every(route => route.requestBody === 'buffered')).toBe(true)
    expect(effects).toHaveLength(4)
  })
})

describe('normalizeConfigPatch', () => {
  it('accepts every documented field', () => {
    const next = normalizeConfigPatch({
      host: '::1',
      port: 0,
      tokenEnv: 'OTHER_TOKEN',
      tokenFile: '/run/secrets/bridge-token',
      policy: 'manual',
      sessionId: ' session-x ',
      rebindOnMissing: true,
      bodyLimitBytes: 1_048_576,
    }, CONFIG)
    expect(next).toEqual({
      host: '::1',
      port: 0,
      tokenEnv: 'OTHER_TOKEN',
      tokenFile: '/run/secrets/bridge-token',
      policy: 'manual',
      sessionId: 'session-x',
      rebindOnMissing: true,
      bodyLimitBytes: 1_048_576,
    })
  })

  it('refuses a relative token file and an unsafe environment name', () => {
    expect(() => normalizeConfigPatch({ tokenFile: 'relative/path' }, CONFIG)).toThrow(UiError)
    expect(() => normalizeConfigPatch({ tokenEnv: '1BAD' }, CONFIG)).toThrow(/environment variable/)
  })

  it('refuses a non-boolean rebind flag', () => {
    expect(() => normalizeConfigPatch({ rebindOnMissing: 'yes' }, CONFIG)).toThrow(/true or false/)
  })
})
