// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readJsonFile, writeJsonAtomic } from '../../src/main/lib/atomic-json'
import {
  DEFAULT_AGENT_CONFIG,
  DEFAULT_COLLECTION_CONFIG,
  buildSensorCollectionConfig,
  buildSensorConfigView,
  buildSensorNetworkConfig,
  buildSensorStatus,
  ensureAgentConfig,
  readAgentConfig,
  readCollectionConfig,
  writeAgentConfig,
  writeCollectionConfig,
} from '../../src/main/lib/sensor-config'
import type {
  SensorAgentConfig,
  SensorCollectionConfig,
} from '../../src/main/lib/sensor-config'

const TOKEN = 'a'.repeat(43)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

describe('sensor config', () => {
  let directory = ''

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'axeuh-sensor-config-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('mirrors the PC sensor defaults without password fields', () => {
    expect(DEFAULT_AGENT_CONFIG).toEqual({
      server_host: '127.0.0.1',
      server_port: 18888,
      agent_token: '',
      instance_id: '',
    })
    expect(DEFAULT_COLLECTION_CONFIG).toEqual({
      enabled: false,
      server_url: '',
      username: '',
      backend_token: '',
      remember_password: false,
      idle_threshold: 300,
      window_enabled: true,
      idle_enabled: true,
      screen_enabled: true,
      ssl_verify: true,
      ssl_ca_file: '',
      agent_id: 'default-agent',
      agent_name: '',
    })
    expect('password' in DEFAULT_COLLECTION_CONFIG).toBe(false)
    expect('password_enc' in DEFAULT_COLLECTION_CONFIG).toBe(false)
  })

  it('creates a loopback agent config with a generated token and instance id when missing', () => {
    const path = join(directory, 'config.json')

    const agent = ensureAgentConfig(path, { preferredPort: 18890 })

    expect(agent.server_host).toBe('127.0.0.1')
    expect(agent.server_port).toBe(18890)
    expect(agent.agent_token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(agent.instance_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(readAgentConfig(path)).toEqual(agent)
  })

  it('preserves a valid token and instance id while updating the port', () => {
    const path = join(directory, 'config.json')
    const existing: SensorAgentConfig = {
      ...DEFAULT_AGENT_CONFIG,
      server_port: 18888,
      agent_token: TOKEN,
      instance_id: 'instance-keep',
    }
    writeAgentConfig(path, existing)

    const agent = ensureAgentConfig(path, { preferredPort: 18895 })

    expect(agent.server_port).toBe(18895)
    expect(agent.agent_token).toBe(TOKEN)
    expect(agent.instance_id).toBe('instance-keep')
  })

  it('preserves unknown agent config keys when rotating a short token', () => {
    const path = join(directory, 'config.json')
    writeJsonAtomic(path, {
      ...DEFAULT_AGENT_CONFIG,
      agent_token: 'short',
      instance_id: 'instance-keep',
      custom_flag: true,
    })

    const agent = ensureAgentConfig(path, { preferredPort: 18888 })

    expect(agent.agent_token).not.toBe('short')
    expect(agent.instance_id).toBe('instance-keep')
    const raw = readJsonFile<unknown>(path)
    expect(isRecord(raw)).toBe(true)
    if (isRecord(raw)) expect(raw['custom_flag']).toBe(true)
  })

  it('recreates a corrupt agent config', () => {
    const path = join(directory, 'config.json')
    writeFileSync(path, '{not-json', 'utf8')

    const agent = ensureAgentConfig(path, { preferredPort: 18888 })

    expect(agent.server_port).toBe(18888)
    expect(agent.agent_token).toHaveLength(43)
    expect(existsSync(`${path}.bak`)).toBe(false)
  })

  it('preserves unknown collection keys', () => {
    const path = join(directory, 'pc_sensor_config.json')
    writeJsonAtomic(path, {
      ...DEFAULT_COLLECTION_CONFIG,
      custom_flag: 'keep-me',
      ssl_verify: false,
    })

    const collection = readCollectionConfig(path)

    expect(collection['custom_flag']).toBe('keep-me')
    const built = buildSensorCollectionConfig(
      collection,
      { enabled: true },
      { serverUrl: 'https://server.test:8768', sslCaFile: '' },
    )
    expect(built.collectionConfig['custom_flag']).toBe('keep-me')
  })

  it('keeps the existing backend token when the patch is masked', () => {
    const existing: SensorCollectionConfig = {
      ...DEFAULT_COLLECTION_CONFIG,
      backend_token: 'existing-token',
    }

    const built = buildSensorCollectionConfig(
      existing,
      { enabled: true, backendToken: '******' },
      { serverUrl: 'https://server.test:8768', sslCaFile: '' },
    )

    expect(built.collectionConfig.backend_token).toBe('existing-token')
    expect(Object.prototype.hasOwnProperty.call(built.apiPatch, 'backend_token')).toBe(false)
  })

  it('never writes a plaintext password into the collection file', () => {
    const path = join(directory, 'pc_sensor_config.json')
    const built = buildSensorCollectionConfig(
      DEFAULT_COLLECTION_CONFIG,
      { enabled: true, password: 'super-secret' },
      { serverUrl: 'https://server.test:8768', sslCaFile: '' },
    )

    expect(built.apiPatch['password']).toBe('super-secret')
    expect('password' in built.collectionConfig).toBe(false)
    expect('password_enc' in built.collectionConfig).toBe(false)

    writeCollectionConfig(path, built.collectionConfig)
    const fileText = readFileSync(path, 'utf8')
    expect(fileText).not.toContain('super-secret')
    expect(fileText).not.toContain('"password"')
    expect(fileText).not.toContain('"password_enc"')
  })

  it('forces ssl_verify true when a CA bundle is configured', () => {
    const existing: SensorCollectionConfig = {
      ...DEFAULT_COLLECTION_CONFIG,
      ssl_verify: false,
    }
    const caFile = '/opt/kinship/ca-bundle.pem'

    const built = buildSensorCollectionConfig(
      existing,
      { enabled: true, sslVerify: false, sslCaFile: caFile },
      { serverUrl: 'https://server.test:8768', sslCaFile: caFile },
    )

    expect(built.collectionConfig.ssl_verify).toBe(true)
    expect(built.collectionConfig.ssl_ca_file).toBe(caFile)
    expect(built.apiPatch['ssl_verify']).toBe(true)
    expect(built.apiPatch['ssl_ca_file']).toBe(caFile)
  })

  it('pushes a configured CA bundle to the sensor even when the patch omits it', () => {
    const caFile = '/opt/kinship/ca-bundle.pem'

    const built = buildSensorCollectionConfig(
      { ...DEFAULT_COLLECTION_CONFIG },
      { enabled: true, sslVerify: true },
      { serverUrl: 'https://server.test:8768', sslCaFile: caFile },
    )

    expect(built.collectionConfig.ssl_ca_file).toBe(caFile)
    expect(built.collectionConfig.ssl_verify).toBe(true)
    expect(built.apiPatch['ssl_ca_file']).toBe(caFile)
    expect(built.apiPatch['ssl_verify']).toBe(true)
  })

  it('omits ssl_ca_file from the patch when no CA bundle exists', () => {
    const built = buildSensorCollectionConfig(
      { ...DEFAULT_COLLECTION_CONFIG },
      { enabled: true, sslVerify: true },
      { serverUrl: 'https://server.test:8768', sslCaFile: '' },
    )

    expect(Object.prototype.hasOwnProperty.call(built.apiPatch, 'ssl_ca_file')).toBe(false)
    expect(built.collectionConfig.ssl_ca_file).toBe('')
  })

  it('maps the patch and server URL into the local collection config', () => {
    const built = buildSensorCollectionConfig(
      {
        ...DEFAULT_COLLECTION_CONFIG,
        agent_id: 'old-agent',
        username: 'old-user',
      },
      {
        enabled: true,
        agentId: 'pc-office',
        agentName: '办公电脑',
        username: 'axeuh',
        rememberPassword: true,
        idleThreshold: 600,
        windowEnabled: false,
        idleEnabled: true,
        screenEnabled: false,
        backendToken: 'new-token',
      },
      { serverUrl: 'https://server.test:8768', sslCaFile: '' },
    )

    expect(built.collectionConfig).toMatchObject({
      enabled: true,
      server_url: 'https://server.test:8768',
      agent_id: 'pc-office',
      agent_name: '办公电脑',
      username: 'axeuh',
      remember_password: true,
      idle_threshold: 600,
      window_enabled: false,
      idle_enabled: true,
      screen_enabled: false,
      backend_token: 'new-token',
      ssl_verify: true,
    })
    expect(built.apiPatch).toEqual({
      enabled: true,
      server_url: 'https://server.test:8768',
      username: 'axeuh',
      remember_password: true,
      idle_threshold: 600,
      window_enabled: false,
      idle_enabled: true,
      screen_enabled: false,
      agent_id: 'pc-office',
      agent_name: '办公电脑',
      backend_token: 'new-token',
    })
  })

  it('builds the view flags from the stored collection config', () => {
    const view = buildSensorConfigView(DEFAULT_AGENT_CONFIG, {
      ...DEFAULT_COLLECTION_CONFIG,
      enabled: true,
      server_url: 'https://server.test:8768',
      agent_id: 'pc-office',
      agent_name: '办公电脑',
      username: 'axeuh',
      password_enc: 'dpapi-ciphertext',
      remember_password: true,
      backend_token: 'backend-token',
      idle_threshold: 600,
      ssl_verify: false,
      ssl_ca_file: '/opt/kinship/ca.pem',
    })

    expect(view).toEqual({
      enabled: true,
      serverUrl: 'https://server.test:8768',
      agentId: 'pc-office',
      agentName: '办公电脑',
      username: 'axeuh',
      hasStoredPassword: true,
      rememberPassword: true,
      hasBackendToken: true,
      idleThreshold: 600,
      windowEnabled: true,
      idleEnabled: true,
      screenEnabled: true,
      sslVerify: false,
      sslCaFile: '/opt/kinship/ca.pem',
    })
  })

  it('falls back to defaults for missing view keys', () => {
    const view = buildSensorConfigView(DEFAULT_AGENT_CONFIG, {})

    expect(view).toEqual({
      enabled: false,
      serverUrl: '',
      agentId: 'default-agent',
      agentName: '',
      username: '',
      hasStoredPassword: false,
      rememberPassword: false,
      hasBackendToken: false,
      idleThreshold: 300,
      windowEnabled: true,
      idleEnabled: true,
      screenEnabled: true,
      sslVerify: true,
      sslCaFile: '',
    })
  })

  it('builds the network collection with candidates and the selected endpoint', () => {
    const built = buildSensorNetworkConfig(
      {
        ...DEFAULT_COLLECTION_CONFIG,
        enabled: true,
        username: 'keep-me',
      },
      {
        transport: {
          mode: 'frp',
          endpointCandidates: [
            { name: 'ipv6', url: 'https://ipv6.example:8443', priority: 10 },
            { name: 'frp', url: 'https://frp.example:8443', priority: 90 },
          ],
          currentEndpoint: 'frp',
        },
        fallbackServerUrl: 'https://server.example:8768',
      },
    )

    expect(built).toMatchObject({
      enabled: true,
      username: 'keep-me',
      server_url: 'https://frp.example:8443',
      endpoint_candidates: [
        { name: 'ipv6', url: 'https://ipv6.example:8443', priority: 10 },
        { name: 'frp', url: 'https://frp.example:8443', priority: 90 },
      ],
    })
  })

  it('keeps the existing server url when no endpoint is selected and no fallback exists', () => {
    const built = buildSensorNetworkConfig(
      {
        ...DEFAULT_COLLECTION_CONFIG,
        server_url: 'https://existing.example:8768',
      },
      {
        transport: {
          mode: 'auto',
          endpointCandidates: [
            { name: 'ipv6', url: 'https://ipv6.example:8443', priority: 10 },
          ],
        },
        fallbackServerUrl: '',
      },
    )

    expect(built.server_url).toBe('https://existing.example:8768')
    expect(built.endpoint_candidates).toEqual([
      { name: 'ipv6', url: 'https://ipv6.example:8443', priority: 10 },
    ])
  })
})

describe('sensor TLS mapping', () => {
  it('maps insecure layers to ssl_verify=false without a CA file', () => {
    const built = buildSensorCollectionConfig(
      { ...DEFAULT_COLLECTION_CONFIG, ssl_verify: true },
      {},
      { serverUrl: 'https://frp.example:8443', sslCaFile: '', sslVerify: false },
    )

    expect(built.collectionConfig.ssl_verify).toBe(false)
    expect(built.collectionConfig.ssl_ca_file).toBe('')
    expect(built.apiPatch).toMatchObject({ ssl_verify: false, ssl_ca_file: '' })
  })

  it('maps system layers back to verification on switching away from insecure', () => {
    const built = buildSensorCollectionConfig(
      { ...DEFAULT_COLLECTION_CONFIG, ssl_verify: false },
      {},
      { serverUrl: 'https://home.example:8768', sslCaFile: '', sslVerify: true },
    )

    expect(built.collectionConfig.ssl_verify).toBe(true)
    expect(built.apiPatch).toMatchObject({ ssl_verify: true, ssl_ca_file: '' })
  })

  it('maps pinned CA files to verification with the bundle path', () => {
    const built = buildSensorNetworkConfig(undefined, {
      transport: {
        mode: 'auto',
        endpointCandidates: [
          { name: 'home', url: 'https://home.example:8768', priority: 1 },
        ],
        currentEndpoint: 'home',
      },
      fallbackServerUrl: 'https://home.example:8768',
      sslCaFile: '/tmp/ca-bundle.pem',
      sslVerify: true,
    })

    expect(built.server_url).toBe('https://home.example:8768')
    expect(built.ssl_ca_file).toBe('/tmp/ca-bundle.pem')
    expect(built.ssl_verify).toBe(true)
  })
})

describe('buildSensorStatus', () => {
  const local = { state: 'running' as const, port: 18888, enabled: true }

  it('maps the remote auth_error into authError', () => {
    const status = buildSensorStatus(local, null, {
      running: true,
      enabled: true,
      logged_in: false,
      queue_size: 4,
      auth_error: '用户名或密码错误',
    })

    expect(status.loggedIn).toBe(false)
    expect(status.queueSize).toBe(4)
    expect(status.authError).toBe('用户名或密码错误')
  })

  it('omits authError when the remote status has an empty value', () => {
    const status = buildSensorStatus(local, null, {
      running: true,
      enabled: true,
      logged_in: true,
      auth_error: '',
    })

    expect(status.loggedIn).toBe(true)
    expect(status.authError).toBeUndefined()
  })

  it('omits authError when there is no remote status', () => {
    const status = buildSensorStatus(local)

    expect(status.state).toBe('running')
    expect(status.authError).toBeUndefined()
  })
})
