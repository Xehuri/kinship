// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readJsonFile } from '../../src/main/lib/atomic-json'
import type { SensorPaths } from '../../src/main/lib/sensor-paths'
import { SensorRuntimeMissingError, SensorSupervisor } from '../../src/main/lib/sensor-supervisor'
import type { SensorSupervisorOptions } from '../../src/main/lib/sensor-supervisor'
import type { SensorStatus } from '../../src/shared/types'

interface FakeSensorOptions {
  readonly token?: string
  readonly backendToken?: string
  readonly instanceId?: string
  readonly agentId?: string
  readonly agentName?: string
  readonly enabled?: boolean
}

interface FakeSensorRequest {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string | undefined>
  readonly body: string | null
}

interface FakeSensor {
  readonly port: number
  readonly baseUrl: string
  readonly token: string
  readonly requests: readonly FakeSensorRequest[]
  readonly config: Record<string, unknown>
  readonly stopped: boolean
  close(): Promise<void>
}

type StartFakeSensor = (options?: FakeSensorOptions) => Promise<FakeSensor>

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function loadFakeSensor(): Promise<StartFakeSensor> {
  const module: unknown = await import('../../e2e/fixtures/fake-sensor.mjs')
  if (!isRecord(module) || typeof module['startFakeSensor'] !== 'function') {
    throw new Error('fake sensor fixture is unavailable')
  }
  return module['startFakeSensor'] as StartFakeSensor
}

function createSupervisor(
  paths: SensorPaths,
  options: {
    readonly fake?: FakeSensor
    readonly instanceId?: string
    readonly getServerUrl?: () => string
    readonly getTransport?: SensorSupervisorOptions['getTransport']
    readonly getTlsPolicy?: SensorSupervisorOptions['getTlsPolicy']
    readonly spawnFn?: SensorSupervisorOptions['spawnFn']
    readonly onStatus?: (status: SensorStatus) => void
    readonly logger?: SensorSupervisorOptions['logger']
  } = {},
): SensorSupervisor {
  return new SensorSupervisor({
    paths,
    parentPid: 4321,
    spawnFn:
      options.spawnFn ??
      (() => {
        throw new Error('spawn must not be called in this test')
      }),
    fakeSensorUrl: options.fake?.baseUrl,
    fakeSensorToken: options.fake?.token,
    fakeSensorInstanceId: options.instanceId,
    getServerUrl: options.getServerUrl ?? (() => 'https://server.test:8768'),
    getTransport: options.getTransport,
    getTlsPolicy: options.getTlsPolicy,
    onStatus: options.onStatus,
    logger: options.logger,
  })
}

describe('SensorSupervisor', () => {
  let directory = ''
  let paths: SensorPaths

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'axeuh-sensor-supervisor-'))
    paths = createPaths(directory)
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('adopts a running fake sensor, reports status, and shuts it down', async () => {
    const startFakeSensor = await loadFakeSensor()
    const fake = await startFakeSensor({
      token: 'fixture-token',
      instanceId: 'fixture-instance',
    })
    let spawnCalled = false
    const supervisor = createSupervisor(paths, {
      fake,
      instanceId: 'fixture-instance',
      spawnFn: () => {
        spawnCalled = true
        throw new Error('spawn must not be called when adopting')
      },
    })

    try {
      await supervisor.start()

      expect(spawnCalled).toBe(false)
      expect(supervisor.isAdopted()).toBe(true)
      expect(supervisor.getBaseUrl()).toBe(fake.baseUrl)

      const status = await supervisor.getStatus()
      expect(status.state).toBe('external')
      expect(status.running).toBe(true)
      expect(status.enabled).toBe(true)
      expect(status.port).toBe(fake.port)
      expect(status.panelUrl).toBe(`${fake.baseUrl}/pc-config`)
      expect(status.logPath).toBe(paths.logPath)
      expect(status.instanceId).toBe('fixture-instance')
    } finally {
      await supervisor.stop()
      expect(fake.stopped).toBe(true)
      await fake.close()
    }
  })

  it('returns the backend auth token with the agent token', async () => {
    const startFakeSensor = await loadFakeSensor()
    const fake = await startFakeSensor({
      token: 'fixture-token',
      backendToken: 'fixture-backend-token',
      instanceId: 'fixture-instance',
    })
    const logLines: string[] = []
    const supervisor = createSupervisor(paths, {
      fake,
      instanceId: 'fixture-instance',
      logger: {
        info: (message, fields) => logLines.push(`${message} ${JSON.stringify(fields ?? {})}`),
        warn: (message, fields) => logLines.push(`${message} ${JSON.stringify(fields ?? {})}`),
        error: (message, fields) => logLines.push(`${message} ${JSON.stringify(fields ?? {})}`),
      },
    })

    try {
      await supervisor.start()

      const auth = await supervisor.getAuthToken()
      expect(auth).toEqual({ token: 'fixture-backend-token', expiresIn: 3600 })

      const request = fake.requests.find(
        (item) => item.method === 'GET' && item.url === '/pc-sensor/auth-token',
      )
      expect(request).toBeDefined()
      expect(request?.headers['authorization']).toBe('Bearer fixture-token')
      expect(logLines.join('\n')).not.toContain('fixture-backend-token')
    } finally {
      await supervisor.stop()
      await fake.close()
    }
  })

  it('returns null from getAuthToken when the sensor has no backend token', async () => {
    const startFakeSensor = await loadFakeSensor()
    const fake = await startFakeSensor({
      token: 'fixture-token',
      backendToken: '',
      instanceId: 'fixture-instance',
    })
    const supervisor = createSupervisor(paths, {
      fake,
      instanceId: 'fixture-instance',
    })

    try {
      await supervisor.start()
      expect(await supervisor.getAuthToken()).toBeNull()
    } finally {
      await supervisor.stop()
      await fake.close()
    }
  })

  it('returns null from getAuthToken after the supervisor stops', async () => {
    const startFakeSensor = await loadFakeSensor()
    const fake = await startFakeSensor({
      token: 'fixture-token',
      backendToken: 'fixture-backend-token',
      instanceId: 'fixture-instance',
    })
    const supervisor = createSupervisor(paths, {
      fake,
      instanceId: 'fixture-instance',
    })

    await supervisor.start()
    expect(await supervisor.getAuthToken()).not.toBeNull()

    await supervisor.stop()
    expect(await supervisor.getAuthToken()).toBeNull()
    await fake.close()
  })

  it('clears local state and stays reusable after resetLocalState', async () => {
    const startFakeSensor = await loadFakeSensor()
    const fake = await startFakeSensor({
      token: 'fixture-token',
      instanceId: 'fixture-instance',
    })
    const emitted: SensorStatus[] = []
    const supervisor = createSupervisor(paths, {
      fake,
      instanceId: 'fixture-instance',
      onStatus: (status) => {
        emitted.push(status)
      },
    })

    try {
      await supervisor.start()
      expect(supervisor.getToken()).toBe('fixture-token')
      expect((await supervisor.getStatus()).instanceId).toBe('fixture-instance')

      supervisor.resetLocalState()

      expect(supervisor.getToken()).toBe('')
      expect(await supervisor.getAuthToken()).toBeNull()
      const status = await supervisor.getStatus()
      expect(status.state).toBe('stopped')
      expect(status.running).toBe(false)
      expect(status.enabled).toBe(false)
      expect(status.instanceId).toBeUndefined()
      expect(status.lastError).toBeUndefined()
      expect(status.panelUrl).toBe('http://127.0.0.1:18888/pc-config')
      expect(emitted.some((item) => item.state === 'stopped')).toBe(true)

      await supervisor.start()
      const resumed = await supervisor.getStatus()
      expect(resumed.state).toBe('external')
      expect(supervisor.getToken()).toBe('fixture-token')
    } finally {
      await supervisor.stop()
      await fake.close()
    }
  })

  it('marks an adopted sensor as crashed after it disappears', async () => {
    const startFakeSensor = await loadFakeSensor()
    const fake = await startFakeSensor({
      token: 'fixture-token',
      instanceId: 'fixture-instance',
    })
    const emitted: SensorStatus[] = []
    const supervisor = createSupervisor(paths, {
      fake,
      instanceId: 'fixture-instance',
      onStatus: (status) => {
        emitted.push(status)
      },
    })

    try {
      await supervisor.start()
      expect(supervisor.isAdopted()).toBe(true)

      await fake.close()

      const status = await supervisor.getStatus()
      expect(status.state).toBe('crashed')
      expect(status.running).toBe(false)
      expect(status.lastError).toContain('失联')

      const crashed = emitted.filter((item) => item.state === 'crashed')
      expect(crashed.length).toBeGreaterThan(0)
      expect(crashed[crashed.length - 1]?.running).toBe(false)
    } finally {
      supervisor.dispose()
    }
  })

  it('applies a password through the sensor API without writing it to disk', async () => {
    const startFakeSensor = await loadFakeSensor()
    const fake = await startFakeSensor({
      token: 'fixture-token',
      instanceId: 'fixture-instance',
    })
    const supervisor = createSupervisor(paths, {
      fake,
      instanceId: 'fixture-instance',
    })

    try {
      await supervisor.start()
      const view = await supervisor.applyConfig({
        enabled: true,
        agentName: '测试电脑',
        username: 'axeuh',
        rememberPassword: true,
        password: 'plain-password',
        backendToken: 'backend-token',
      })

      const post = fake.requests.filter(
        (request) => request.method === 'POST' && request.url === '/pc-sensor/config',
      )
      expect(post).toHaveLength(1)
      const body = post[0]?.body
      expect(body).not.toBeNull()
      const patch: unknown = body === null || body === undefined ? undefined : JSON.parse(body)
      expect(patch).toMatchObject({
        enabled: true,
        server_url: 'https://server.test:8768',
        agent_name: '测试电脑',
        username: 'axeuh',
        remember_password: true,
        password: 'plain-password',
        backend_token: 'backend-token',
      })

      expect(JSON.stringify(view)).not.toContain('plain-password')
      expect(view.hasStoredPassword).toBe(false)
      expect(view.hasBackendToken).toBe(true)

      const fileText = readFileSync(paths.collectionConfigPath, 'utf8')
      expect(fileText).not.toContain('plain-password')
      const stored = readJsonFile<unknown>(paths.collectionConfigPath)
      expect(isRecord(stored)).toBe(true)
      if (isRecord(stored)) {
        expect('password' in stored).toBe(false)
        expect('password_enc' in stored).toBe(false)
        expect(stored['backend_token']).toBe('backend-token')
      }
    } finally {
      await supervisor.stop()
      await fake.close()
    }
  })

  it('enters conflict when the port is owned by another sensor instance', async () => {
    const startFakeSensor = await loadFakeSensor()
    const fake = await startFakeSensor({
      token: 'fixture-token',
      instanceId: 'other-instance',
      agentId: 'other-agent',
      agentName: 'Other PC',
    })
    let spawnCalled = false
    const supervisor = createSupervisor(paths, {
      fake,
      instanceId: 'mine-instance',
      spawnFn: () => {
        spawnCalled = true
        throw new Error('spawn must not be called on conflict')
      },
    })

    try {
      await supervisor.start()

      expect(spawnCalled).toBe(false)
      expect(supervisor.isAdopted()).toBe(false)
      const status = await supervisor.getStatus()
      expect(status.state).toBe('conflict')
      expect(status.running).toBe(false)
      expect(status.lastError).toContain('other-agent')
      expect(status.lastError).toContain('other-instance')
    } finally {
      await fake.close()
      supervisor.dispose()
    }
  })

  it('reports a missing runtime without spawning', async () => {
    let spawnCalled = false
    const supervisor = createSupervisor(paths, {
      spawnFn: () => {
        spawnCalled = true
        throw new Error('spawn must not be called without a runtime')
      },
    })

    await supervisor.start()
    const status = await supervisor.getStatus()

    expect(spawnCalled).toBe(false)
    expect(status.state).toBe('runtime-missing')
    expect(status.running).toBe(false)
    expect(status.lastError).toContain(paths.pythonExe)
    expect(status.lastError).toContain(paths.appScript)
    expect(status.lastError).toContain('杀毒软件')
    expect(status.lastError).toContain('已检查')
    for (const candidate of paths.candidateRoots) {
      expect(status.lastError).toContain(candidate)
    }
    expect(status.panelUrl).toBe('http://127.0.0.1:18888/pc-config')
    supervisor.dispose()
  })

  it('writes the collection config before reporting a missing runtime', async () => {
    let spawnCalled = false
    const supervisor = createSupervisor(paths, {
      spawnFn: () => {
        spawnCalled = true
        throw new Error('spawn must not be called without a runtime')
      },
    })

    let caught: unknown
    try {
      await supervisor.applyConfig({ idleThreshold: 120 })
    } catch (error) {
      caught = error
    }

    expect(spawnCalled).toBe(false)
    expect(caught).toBeInstanceOf(SensorRuntimeMissingError)
    if (!(caught instanceof SensorRuntimeMissingError)) {
      throw new Error('expected SensorRuntimeMissingError')
    }
    expect(caught.code).toBe('RUNTIME_MISSING')
    expect(caught.message).toContain('杀毒软件')
    expect(caught.message).toContain(paths.candidateRoots[0])

    const stored = readJsonFile<unknown>(paths.collectionConfigPath)
    expect(isRecord(stored)).toBe(true)
    if (isRecord(stored)) {
      expect(stored['idle_threshold']).toBe(120)
      expect(stored['server_url']).toBe('https://server.test:8768')
    }
    supervisor.dispose()
  })

  it('keeps ssl_verify true when applying a CA bundle', async () => {
    const startFakeSensor = await loadFakeSensor()
    const fake = await startFakeSensor({
      token: 'fixture-token',
      instanceId: 'fixture-instance',
    })
    writeFileSync(
      paths.caBundlePath,
      ['-----BEGIN CERTIFICATE-----', 'fixture', ''].join('\n'),
      'utf8',
    )
    const supervisor = createSupervisor(paths, {
      fake,
      instanceId: 'fixture-instance',
    })

    try {
      await supervisor.start()
      const view = await supervisor.applyConfig({
        enabled: true,
        sslVerify: false,
        sslCaFile: paths.caBundlePath,
      })

      expect(view.sslVerify).toBe(true)
      expect(view.sslCaFile).toBe(paths.caBundlePath)
      const stored = readJsonFile<unknown>(paths.collectionConfigPath)
      expect(isRecord(stored)).toBe(true)
      if (isRecord(stored)) {
        expect(stored['ssl_verify']).toBe(true)
        expect(stored['ssl_ca_file']).toBe(paths.caBundlePath)
      }
    } finally {
      await supervisor.stop()
      await fake.close()
    }
  })

  it('posts the CA bundle path when a CA file exists but the patch omits it', async () => {
    const startFakeSensor = await loadFakeSensor()
    const fake = await startFakeSensor({
      token: 'fixture-token',
      instanceId: 'fixture-instance',
    })
    writeFileSync(
      paths.caBundlePath,
      ['-----BEGIN CERTIFICATE-----', 'fixture', ''].join('\n'),
      'utf8',
    )
    const supervisor = createSupervisor(paths, {
      fake,
      instanceId: 'fixture-instance',
    })

    try {
      await supervisor.start()
      const view = await supervisor.applyConfig({ enabled: true, sslVerify: true })

      expect(view.sslVerify).toBe(true)
      expect(view.sslCaFile).toBe(paths.caBundlePath)

      const post = fake.requests.filter(
        (request) => request.method === 'POST' && request.url === '/pc-sensor/config',
      )
      expect(post).toHaveLength(1)
      const body = post[0]?.body
      expect(body).not.toBeNull()
      const patch: unknown = body === null || body === undefined ? undefined : JSON.parse(body)
      expect(patch).toMatchObject({
        ssl_verify: true,
        ssl_ca_file: paths.caBundlePath,
      })
      expect(fake.config['ssl_verify']).toBe(true)
      expect(fake.config['ssl_ca_file']).toBe(paths.caBundlePath)

      const stored = readJsonFile<unknown>(paths.collectionConfigPath)
      expect(isRecord(stored)).toBe(true)
      if (isRecord(stored)) {
        expect(stored['ssl_verify']).toBe(true)
        expect(stored['ssl_ca_file']).toBe(paths.caBundlePath)
      }
    } finally {
      await supervisor.stop()
      await fake.close()
    }
  })

  it('keeps the manually selected endpoint when applying sensor settings', async () => {
    const startFakeSensor = await loadFakeSensor()
    const fake = await startFakeSensor({
      token: 'fixture-token',
      instanceId: 'fixture-instance',
    })
    const supervisor = createSupervisor(paths, {
      fake,
      instanceId: 'fixture-instance',
      getTransport: () => ({
        mode: 'frp',
        endpointCandidates: [
          { name: 'ipv6', url: 'https://ipv6.example:8443', priority: 10 },
          { name: 'frp', url: 'https://frp.example:8443', priority: 90 },
        ],
        currentEndpoint: 'frp',
      }),
    })

    try {
      await supervisor.start()
      await supervisor.applyConfig({ idleThreshold: 120 })

      const post = fake.requests.filter(
        (request) => request.method === 'POST' && request.url === '/pc-sensor/config',
      )
      expect(post).toHaveLength(1)
      const body = post[0]?.body
      expect(body).not.toBeNull()
      const patch: unknown = body === null || body === undefined ? undefined : JSON.parse(body)
      expect(patch).toMatchObject({
        idle_threshold: 120,
        server_url: 'https://frp.example:8443',
      })
    } finally {
      await supervisor.stop()
      await fake.close()
    }
  })

  it('synchronizes transport candidates and the selected endpoint to the sensor', async () => {
    const startFakeSensor = await loadFakeSensor()
    const fake = await startFakeSensor({
      token: 'fixture-token',
      instanceId: 'fixture-instance',
    })
    const supervisor = createSupervisor(paths, {
      fake,
      instanceId: 'fixture-instance',
    })
    const transport = {
      mode: 'frp' as const,
      endpointCandidates: [
        { name: 'ipv6', url: 'https://ipv6.example:8443', priority: 10 },
        { name: 'frp', url: 'https://frp.example:8443', priority: 90 },
      ],
      currentEndpoint: 'frp',
    }

    try {
      await supervisor.start()
      const view = await supervisor.applyNetworkConfig(transport)

      expect(view.serverUrl).toBe('https://frp.example:8443')
      const post = fake.requests.filter(
        (request) => request.method === 'POST' && request.url === '/pc-sensor/config',
      )
      expect(post).toHaveLength(1)
      const body = post[0]?.body
      expect(body).not.toBeNull()
      const patch: unknown = body === null || body === undefined ? undefined : JSON.parse(body)
      expect(patch).toEqual({
        endpoint_candidates: [
          { name: 'ipv6', url: 'https://ipv6.example:8443', priority: 10 },
          { name: 'frp', url: 'https://frp.example:8443', priority: 90 },
        ],
        server_url: 'https://frp.example:8443',
      })

      const stored = readJsonFile<unknown>(paths.collectionConfigPath)
      expect(isRecord(stored)).toBe(true)
      if (isRecord(stored)) {
        expect(stored['server_url']).toBe('https://frp.example:8443')
        expect(stored['endpoint_candidates']).toEqual([
          { name: 'ipv6', url: 'https://ipv6.example:8443', priority: 10 },
          { name: 'frp', url: 'https://frp.example:8443', priority: 90 },
        ])
      }
    } finally {
      await supervisor.stop()
      await fake.close()
    }
  })

  it('syncs the active layer TLS policy to the sensor', async () => {
    const startFakeSensor = await loadFakeSensor()
    const fake = await startFakeSensor({
      token: 'fixture-token',
      instanceId: 'fixture-instance',
    })
    const supervisor = createSupervisor(paths, {
      fake,
      instanceId: 'fixture-instance',
      getTlsPolicy: () => ({ mode: 'insecure' }),
    })

    try {
      await supervisor.start()
      await supervisor.applyNetworkConfig({
        mode: 'auto',
        endpointCandidates: [
          { name: 'home', url: 'https://home.example:8768', priority: 1 },
        ],
        currentEndpoint: 'home',
      })

      const post = fake.requests.filter(
        (request) => request.method === 'POST' && request.url === '/pc-sensor/config',
      )
      const body = post.at(-1)?.body
      const patch: unknown = body === null || body === undefined ? undefined : JSON.parse(body)
      expect(patch).toMatchObject({
        endpoint_candidates: [
          { name: 'home', url: 'https://home.example:8768', priority: 1 },
        ],
        server_url: 'https://home.example:8768',
        ssl_verify: false,
        ssl_ca_file: '',
      })

      const stored = readJsonFile<unknown>(paths.collectionConfigPath)
      expect(isRecord(stored)).toBe(true)
      if (isRecord(stored)) {
        expect(stored['ssl_verify']).toBe(false)
        expect(stored['ssl_ca_file']).toBe('')
      }
    } finally {
      await supervisor.stop()
      await fake.close()
    }
  })

  it('writes network settings locally before reporting a missing runtime', async () => {
    const supervisor = createSupervisor(paths)

    let caught: unknown
    try {
      await supervisor.applyNetworkConfig({
        mode: 'auto',
        endpointCandidates: [
          { name: 'ipv6', url: 'https://ipv6.example:8443', priority: 10 },
        ],
        currentEndpoint: 'ipv6',
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(SensorRuntimeMissingError)
    const stored = readJsonFile<unknown>(paths.collectionConfigPath)
    expect(isRecord(stored)).toBe(true)
    if (isRecord(stored)) {
      expect(stored['server_url']).toBe('https://ipv6.example:8443')
      expect(stored['endpoint_candidates']).toEqual([
        { name: 'ipv6', url: 'https://ipv6.example:8443', priority: 10 },
      ])
    }
    supervisor.dispose()
  })
})

interface LoginFetchCall {
  readonly url: string
  readonly authorization: string | undefined
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('SensorSupervisor.testLogin', () => {
  let directory = ''
  let paths: SensorPaths

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'axeuh-sensor-test-login-'))
    paths = createPaths(directory)
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  function createLoginSupervisor(
    fetchFn: typeof fetch,
    fakeSensor = false,
  ): SensorSupervisor {
    return new SensorSupervisor({
      paths,
      parentPid: 4321,
      spawnFn: () => {
        throw new Error('spawn must not be called in this test')
      },
      fetchFn,
      getServerUrl: () => 'https://server.test:8768',
      fakeSensorUrl: fakeSensor ? 'http://127.0.0.1:19999' : undefined,
      fakeSensorToken: fakeSensor ? 'agent-token' : undefined,
      fakeSensorInstanceId: fakeSensor ? 'fixture-instance' : undefined,
    })
  }

  function sensorBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      running: true,
      enabled: true,
      logged_in: false,
      queue_size: 0,
      auth_error: '',
      instance_id: 'fixture-instance',
      ...overrides,
    }
  }

  it('maps a failed test login and returns the refreshed status', async () => {
    const calls: LoginFetchCall[] = []
    const fetchFn = (async (input: string, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      const headers = init?.headers as Record<string, string> | undefined
      calls.push({ url, authorization: headers?.['Authorization'] })
      if (url.endsWith('/health')) {
        return jsonResponse({
          status: 'ok',
          agent_id: 'agent',
          agent_name: 'PC',
          pid: 1,
          version: '1.0',
        })
      }
      if (url.endsWith('/pc-sensor/status')) {
        return jsonResponse(sensorBody({ auth_error: '用户名或密码错误' }))
      }
      if (url.endsWith('/pc-sensor/test-login')) {
        return jsonResponse({
          success: false,
          logged_in: false,
          auth_error: '用户名或密码错误',
          message: '用户名或密码错误',
        })
      }
      return jsonResponse({}, 404)
    }) as unknown as typeof fetch

    const supervisor = createLoginSupervisor(fetchFn, true)
    try {
      await supervisor.start()
      const result = await supervisor.testLogin()

      expect(result.success).toBe(false)
      expect(result.loggedIn).toBe(false)
      expect(result.message).toBe('用户名或密码错误')
      expect(result.authError).toBe('用户名或密码错误')
      expect(result.status.authError).toBe('用户名或密码错误')
      expect(result.status.loggedIn).toBe(false)

      const loginCall = calls.find((call) => call.url.endsWith('/pc-sensor/test-login'))
      expect(loginCall).toBeDefined()
      expect(loginCall?.authorization).toBe('Bearer agent-token')
    } finally {
      supervisor.dispose()
    }
  })

  it('reports success with the refreshed status', async () => {
    const fetchFn = (async (input: string): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/health')) {
        return jsonResponse({
          status: 'ok',
          agent_id: 'agent',
          agent_name: 'PC',
          pid: 1,
          version: '1.0',
        })
      }
      if (url.endsWith('/pc-sensor/status')) {
        return jsonResponse(sensorBody({ logged_in: true }))
      }
      if (url.endsWith('/pc-sensor/test-login')) {
        return jsonResponse({
          success: true,
          logged_in: true,
          auth_error: '',
          message: '登录成功',
        })
      }
      return jsonResponse({}, 404)
    }) as unknown as typeof fetch

    const supervisor = createLoginSupervisor(fetchFn, true)
    try {
      await supervisor.start()
      const result = await supervisor.testLogin()

      expect(result.success).toBe(true)
      expect(result.loggedIn).toBe(true)
      expect(result.message).toBe('登录成功')
      expect(result.authError).toBeUndefined()
      expect(result.status.loggedIn).toBe(true)
    } finally {
      supervisor.dispose()
    }
  })

  it('returns a failure instead of throwing when the sensor is not running', async () => {
    const fetchFn = (async (): Promise<Response> => {
      throw new Error('fetch must not be called')
    }) as unknown as typeof fetch
    const supervisor = createLoginSupervisor(fetchFn)

    await supervisor.start()
    const result = await supervisor.testLogin()

    expect(result.success).toBe(false)
    expect(result.loggedIn).toBe(false)
    expect(result.message.length).toBeGreaterThan(0)
    expect(result.status.state).toBe('runtime-missing')
    supervisor.dispose()
  })
})

