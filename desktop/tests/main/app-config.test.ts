// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/axeuh-desktop-app-config-test' },
}))

import { DesktopConfigManager } from '../../src/main/app-config'
import { DEFAULT_CONFIG } from '../../src/main/lib/config-store'
import type { DesktopConfig } from '../../src/shared/types'

function readConfig(path: string): DesktopConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as DesktopConfig
}

describe('DesktopConfigManager.reset', () => {
  let directory = ''
  let configPath = ''

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'axeuh-desktop-app-config-'))
    configPath = join(directory, 'desktop-config.json')
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('deletes the active config and its backup, then returns fresh defaults', () => {
    const manager = new DesktopConfigManager(configPath)
    manager.load()
    manager.saveTransport({
      mode: 'frp',
      endpointCandidates: [
        { name: 'frp', url: 'https://old.example:8443', priority: 90 },
      ],
      currentEndpoint: 'frp',
    })
    manager.saveServer({
      url: 'https://old.example:8768',
      allowUntrustedCa: true,
      tlsPin: { host: 'old.example', fingerprint256: 'AA:BB' },
    })
    manager.saveServer({
      url: 'https://new.example:8768',
      allowUntrustedCa: true,
    })

    expect(existsSync(configPath)).toBe(true)
    expect(existsSync(`${configPath}.bak`)).toBe(true)
    expect(readFileSync(`${configPath}.bak`, 'utf8')).toContain('old.example')

    manager.reset()

    expect(existsSync(configPath)).toBe(false)
    expect(existsSync(`${configPath}.bak`)).toBe(false)
    expect(manager.getConfig()).toEqual(DEFAULT_CONFIG)
    expect(manager.getServerUrl()).toBe('')
    expect(manager.getServerOrigin()).toBeNull()
  })

  it('is idempotent and remains usable after reset', () => {
    const manager = new DesktopConfigManager(configPath)
    manager.saveServer({ url: 'https://old.example:8768', allowUntrustedCa: false })

    manager.reset()
    manager.reset()

    expect(manager.getConfig()).toEqual(DEFAULT_CONFIG)

    manager.saveServer({ url: 'https://fresh.example:8768', allowUntrustedCa: false })
    manager.saveBounds({ width: 1024, height: 720 })

    expect(manager.getServerUrl()).toBe('https://fresh.example:8768')
    expect(readConfig(configPath).server.url).toBe('https://fresh.example:8768')
    expect(readConfig(configPath).window.bounds).toEqual({ width: 1024, height: 720 })
  })
})
