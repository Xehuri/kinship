// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ConfigCorruptError,
  ConfigInvalidError,
  ConfigUnsupportedError,
  DEFAULT_CONFIG,
  createConfigStore,
} from '../../src/main/lib/config-store'
import { readJsonFile } from '../../src/main/lib/atomic-json'
import type { DesktopConfig } from '../../src/shared/types'

const VALID_FINGERPRINT = 'a'.repeat(64)

function thrownError(run: () => void): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected function to throw')
}

function configWithUrl(url: string): DesktopConfig {
  return {
    ...DEFAULT_CONFIG,
    server: { url, allowUntrustedCa: false },
  }
}

describe('createConfigStore', () => {
  let directory = ''
  let configPath = ''

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'axeuh-desktop-config-'))
    configPath = join(directory, 'desktop-config.json')
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('returns a fresh default config with no network layers when the file is missing', () => {
    const store = createConfigStore(configPath)

    const first = store.load()
    expect(first).toEqual(DEFAULT_CONFIG)
    expect(first.network).toEqual({ layers: [] })
    expect(first.window).toEqual({ minimizeToTray: true, openAtLogin: false })
    expect(existsSync(configPath)).toBe(false)

    first.window.minimizeToTray = false
    expect(store.load().window.minimizeToTray).toBe(true)
  })

  it('round-trips a schema v3 network config', () => {
    const store = createConfigStore(configPath)
    const config: DesktopConfig = {
      schemaVersion: 3,
      server: { url: 'https://frp.example:8443', allowUntrustedCa: false },
      transport: {
        mode: 'frp',
        endpointCandidates: [
          { name: 'home', url: 'https://home.example:8768', priority: 1 },
          { name: 'frp', url: 'https://frp.example:8443', priority: 2 },
        ],
        currentEndpoint: 'frp',
      },
      network: {
        layers: [
          {
            id: 'home',
            type: 'direct',
            name: 'home',
            address: 'https://home.example:8768',
            enabled: true,
            tlsMode: 'system',
          },
          {
            id: 'frp',
            type: 'frp',
            name: 'frp',
            address: 'https://frp.example:8443',
            enabled: true,
            tlsMode: 'system',
          },
        ],
        activeLayerId: 'frp',
      },
      window: { minimizeToTray: false, openAtLogin: true, lastHash: '#/chat' },
    }

    store.save(config)

    expect(store.load()).toEqual(config)
  })

  it('migrates a schemaVersion 1 config to v3 and builds a direct layer', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        server: {
          url: 'https://example.com:8768',
          allowUntrustedCa: false,
        },
        window: {
          minimizeToTray: false,
          openAtLogin: true,
          lastHash: '#/chat',
          bounds: { x: 10, y: 20, width: 1200, height: 800 },
        },
      }),
      'utf8',
    )
    const store = createConfigStore(configPath)

    const migrated = store.load()

    expect(migrated.schemaVersion).toBe(3)
    expect(migrated.server).toEqual({
      url: 'https://example.com:8768',
      allowUntrustedCa: false,
    })
    expect(migrated.network).toEqual({
      layers: [
        {
          id: 'server-direct',
          type: 'direct',
          name: '直连',
          address: 'https://example.com:8768',
          enabled: true,
          tlsMode: 'system',
        },
      ],
      activeLayerId: 'server-direct',
    })
    expect(migrated.window).toEqual({
      minimizeToTray: false,
      openAtLogin: true,
      lastHash: '#/chat',
      bounds: { x: 10, y: 20, width: 1200, height: 800 },
    })
    expect(readJsonFile<DesktopConfig>(configPath)).toEqual(migrated)
    expect(readJsonFile<DesktopConfig>(`${configPath}.bak`)).toMatchObject({ schemaVersion: 1 })
  })

  it('migrates schema v2 transport candidates and keeps the selected endpoint active', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 2,
        server: { url: 'https://home.example:8768', allowUntrustedCa: false },
        transport: {
          mode: 'frp',
          endpointCandidates: [
            { name: 'ipv6', url: 'https://ipv6.example:8443', priority: 10 },
            { name: 'frp', url: 'https://frp.example:8443', priority: 90 },
          ],
          currentEndpoint: 'frp',
        },
        window: { minimizeToTray: true, openAtLogin: false },
      }),
      'utf8',
    )

    const migrated = createConfigStore(configPath).load()

    expect(migrated.network.layers.map((layer) => layer.name)).toEqual([
      '直连',
      'ipv6',
      'frp',
    ])
    expect(migrated.network.activeLayerId).toBe('layer-2')
    expect(migrated.server.url).toBe('https://frp.example:8443')
    expect(migrated.transport.currentEndpoint).toBe('frp')
    expect(readJsonFile<DesktopConfig>(configPath).schemaVersion).toBe(3)
  })

  it('derives network layers from a saved transport for backward compatibility', () => {
    const store = createConfigStore(configPath)
    store.save({
      ...DEFAULT_CONFIG,
      transport: {
        mode: 'frp',
        endpointCandidates: [
          { name: 'ipv6', url: 'https://ipv6.example:8443', priority: 10 },
          { name: 'frp', url: 'https://frp.example:8443', priority: 90 },
        ],
        currentEndpoint: 'frp',
      },
    })

    expect(store.load().transport).toEqual({
      mode: 'frp',
      endpointCandidates: [
        { name: 'ipv6', url: 'https://ipv6.example:8443', priority: 1 },
        { name: 'frp', url: 'https://frp.example:8443', priority: 2 },
      ],
      currentEndpoint: 'frp',
    })
    expect(store.load().network.layers).toHaveLength(2)
  })

  it('keeps the previous file as a .bak on overwrite', () => {
    const store = createConfigStore(configPath)
    store.save(configWithUrl('https://one.example'))
    store.save(configWithUrl('https://two.example'))

    const backup = readJsonFile<DesktopConfig>(`${configPath}.bak`)
    expect(backup.server.url).toBe('https://one.example')
    expect(store.load().server.url).toBe('https://two.example')
  })

  it('throws CONFIG_CORRUPT for invalid JSON and leaves the file untouched', () => {
    writeFileSync(configPath, '{not json', 'utf8')
    const store = createConfigStore(configPath)

    const error = thrownError(() => store.load())
    expect(error).toBeInstanceOf(ConfigCorruptError)
    expect(error).toMatchObject({ code: 'CONFIG_CORRUPT', path: configPath })
    expect(readFileSync(configPath, 'utf8')).toBe('{not json')
  })

  it('throws CONFIG_UNSUPPORTED for an unknown schema version', () => {
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 4 }), 'utf8')
    const store = createConfigStore(configPath)

    const error = thrownError(() => store.load())
    expect(error).toBeInstanceOf(ConfigUnsupportedError)
    expect(error).toMatchObject({ code: 'CONFIG_UNSUPPORTED', path: configPath })
  })

  it('merges nested server and window patches on update', () => {
    const store = createConfigStore(configPath)
    store.save(configWithUrl('https://example.com'))

    const serverPatched = store.update({
      server: {
        allowUntrustedCa: true,
        tlsPin: { host: 'example.com', fingerprint256: VALID_FINGERPRINT },
      },
    })
    expect(serverPatched.server).toEqual({
      url: 'https://example.com',
      allowUntrustedCa: true,
      tlsPin: { host: 'example.com', fingerprint256: VALID_FINGERPRINT },
    })

    const windowPatched = store.update({ window: { minimizeToTray: false } })
    expect(windowPatched.window).toEqual({ minimizeToTray: false, openAtLogin: false })
    expect(windowPatched.server.url).toBe('https://example.com')
    expect(store.load()).toEqual(windowPatched)
  })

  it('normalizes the server URL on save', () => {
    const store = createConfigStore(configPath)
    store.save({ ...DEFAULT_CONFIG, server: { url: 'example.com', allowUntrustedCa: false } })

    expect(store.load().server.url).toBe('https://example.com')
    expect(store.load().network.layers[0]?.address).toBe('https://example.com')
  })

  it('throws CONFIG_INVALID for a URL with a path', () => {
    const store = createConfigStore(configPath)

    const error = thrownError(() => store.save(configWithUrl('https://host/mobile/')))
    expect(error).toBeInstanceOf(ConfigInvalidError)
    expect(error).toMatchObject({ code: 'CONFIG_INVALID', path: configPath })
    expect(existsSync(configPath)).toBe(false)
  })

  it('throws CONFIG_INVALID for an endpoint candidate with a path', () => {
    const store = createConfigStore(configPath)
    const error = thrownError(() =>
      store.save({
        ...DEFAULT_CONFIG,
        transport: {
          mode: 'auto',
          endpointCandidates: [
            { name: 'ipv6', url: 'https://ipv6.example/mobile/', priority: 10 },
          ],
        },
      }),
    )

    expect(error).toBeInstanceOf(ConfigInvalidError)
    expect(error).toMatchObject({ code: 'CONFIG_INVALID', path: configPath })
    expect(existsSync(configPath)).toBe(false)
  })

  it('keeps a valid TLS pin as a pinned layer and drops an incomplete one', () => {
    const store = createConfigStore(configPath)
    const config: DesktopConfig = {
      ...DEFAULT_CONFIG,
      server: {
        url: 'https://example.com',
        allowUntrustedCa: true,
        tlsPin: {
          host: 'example.com',
          fingerprint256: VALID_FINGERPRINT,
          caPemPath: '/tmp/ca.pem',
        },
      },
    }
    store.save(config)

    const loaded = store.load()
    expect(loaded.server.tlsPin).toEqual(config.server.tlsPin)
    expect(loaded.network.layers[0]).toMatchObject({
      tlsMode: 'pinned',
      fingerprint256: VALID_FINGERPRINT,
      caPemPath: '/tmp/ca.pem',
    })

    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        server: { url: '', allowUntrustedCa: false, tlsPin: { host: 'example.com' } },
        window: {},
      }),
      'utf8',
    )
    expect(store.load().server.tlsPin).toBeUndefined()
  })

  it('keeps persisted P2P layers disabled and refuses to make them active', () => {
    const store = createConfigStore(configPath)
    store.save({
      ...DEFAULT_CONFIG,
      network: {
        layers: [
          {
            id: 'direct',
            type: 'direct',
            name: 'home',
            address: 'https://home.example:8768',
            enabled: true,
            tlsMode: 'system',
          },
          {
            id: 'p2p',
            type: 'p2p',
            name: 'p2p',
            address: 'https://p2p.example:8768',
            enabled: true,
            tlsMode: 'system',
          },
        ],
        activeLayerId: 'p2p',
      },
    })

    const loaded = store.load()
    expect(loaded.network.layers.find((layer) => layer.id === 'p2p')?.enabled).toBe(false)
    expect(loaded.network.activeLayerId).toBeUndefined()
    expect(loaded.server.url).toBe('')
  })
})
