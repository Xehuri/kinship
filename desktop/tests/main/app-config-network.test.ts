// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/axeuh-app-config-network-test' },
}))

import { DesktopConfigManager } from '../../src/main/app-config'
import type { NetworkConfig } from '../../src/shared/types'

const FINGERPRINT = 'cd'.repeat(32)

function network(): NetworkConfig {
  return {
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
        tlsMode: 'insecure',
      },
      {
        id: 'p2p',
        type: 'p2p',
        name: 'p2p',
        address: 'https://p2p.example:9000',
        enabled: false,
        tlsMode: 'system',
      },
    ],
    activeLayerId: 'frp',
  }
}

describe('DesktopConfigManager network model', () => {
  let directory = ''
  let configPath = ''

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'axeuh-app-config-network-'))
    configPath = join(directory, 'desktop-config.json')
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('derives the SPA origin and sensor transport from the active layer', () => {
    const manager = new DesktopConfigManager(configPath)
    manager.load()
    manager.saveNetwork(network())

    expect(manager.getServerUrl()).toBe('https://frp.example:8443')
    expect(manager.getServerOrigin()).toBe('https://frp.example:8443')
    expect(manager.getTransport()).toEqual({
      mode: 'frp',
      endpointCandidates: [
        { name: 'home', url: 'https://home.example:8768', priority: 1 },
        { name: 'frp', url: 'https://frp.example:8443', priority: 2 },
      ],
      currentEndpoint: 'frp',
    })
  })

  it('switches the active layer and keeps server/sensor URLs identical', () => {
    const manager = new DesktopConfigManager(configPath)
    manager.load()
    manager.saveNetwork(network())
    manager.setActiveLayer('home')

    expect(manager.getServerUrl()).toBe('https://home.example:8768')
    expect(manager.getTransport().currentEndpoint).toBe('home')
    expect(manager.getTransport().mode).toBe('auto')
  })

  it('scopes insecure trust to the active host only', () => {
    const manager = new DesktopConfigManager(configPath)
    manager.load()
    manager.saveNetwork(network())

    expect(manager.getTrustPolicy()).toEqual({
      host: 'frp.example',
      allowUntrustedCa: false,
      insecure: true,
    })
    expect(manager.getSensorTlsPolicy()).toEqual({ mode: 'insecure' })
  })

  it('maps pinned trust to a host pin and CA bundle', () => {
    const manager = new DesktopConfigManager(configPath)
    manager.load()
    manager.saveNetwork({
      layers: [
        {
          id: 'pinned',
          type: 'direct',
          name: 'pinned',
          address: 'https://[fd00::1]:8768',
          enabled: true,
          tlsMode: 'pinned',
          fingerprint256: FINGERPRINT,
          caPemPath: '/tmp/ca-bundle.pem',
        },
      ],
      activeLayerId: 'pinned',
    })

    expect(manager.getTrustPolicy()).toEqual({
      host: 'fd00::1',
      allowUntrustedCa: true,
      pin: { host: 'fd00::1', fingerprint256: FINGERPRINT },
    })
    expect(manager.getSensorTlsPolicy()).toEqual({
      mode: 'pinned',
      caPemPath: '/tmp/ca-bundle.pem',
    })
  })

  it('updates the active layer when a legacy server save changes the address', () => {
    const manager = new DesktopConfigManager(configPath)
    manager.load()
    manager.saveNetwork(network())

    manager.saveServer({
      url: 'https://new.example:8768',
      allowUntrustedCa: true,
      tlsPin: { host: 'new.example', fingerprint256: FINGERPRINT },
    })

    expect(manager.getServerUrl()).toBe('https://new.example:8768')
    expect(manager.getActiveLayer()).toMatchObject({
      id: 'frp',
      address: 'https://new.example:8768',
      tlsMode: 'pinned',
    })
    expect(manager.getSensorTlsPolicy()).toMatchObject({ mode: 'pinned' })
  })

  it('saves window preferences without clobbering bounds or last hash', () => {
    const manager = new DesktopConfigManager(configPath)
    manager.load()
    manager.saveBounds({ x: 10, y: 20, width: 1200, height: 800 })
    manager.saveLastHash('#/chat')

    const saved = manager.saveWindowPreferences({
      minimizeToTray: false,
      openAtLogin: true,
    })

    expect(saved).toEqual({ minimizeToTray: false, openAtLogin: true })
    expect(manager.getConfig().window).toEqual({
      minimizeToTray: false,
      openAtLogin: true,
      lastHash: '#/chat',
      bounds: { x: 10, y: 20, width: 1200, height: 800 },
    })
  })

  it('clears all layers when the server URL is cleared', () => {
    const manager = new DesktopConfigManager(configPath)
    manager.load()
    manager.saveNetwork(network())

    manager.saveServer({ url: '', allowUntrustedCa: false })

    expect(manager.getConfig().network).toEqual({ layers: [] })
    expect(manager.getServerUrl()).toBe('')
    expect(manager.getTransport()).toEqual({ mode: 'auto', endpointCandidates: [] })
  })

  it('resets to no layers and default window preferences', () => {
    const manager = new DesktopConfigManager(configPath)
    manager.load()
    manager.saveNetwork(network())
    manager.saveWindowPreferences({ minimizeToTray: false, openAtLogin: true })

    manager.reset()

    expect(manager.getConfig().network).toEqual({ layers: [] })
    expect(manager.getServerUrl()).toBe('')
    expect(manager.getWindowPreferences()).toEqual({
      minimizeToTray: true,
      openAtLogin: false,
    })
  })
})
