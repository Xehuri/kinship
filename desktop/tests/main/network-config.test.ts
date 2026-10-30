// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  buildServerFromNetwork,
  buildTransportFromNetwork,
  isSelectableLayer,
  networkWithServer,
} from '../../src/shared/network'
import { validateNetworkConfig, validateWindowPreferences } from '../../src/shared/validation'
import type { NetworkConfig } from '../../src/shared/types'

const FINGERPRINT = 'ab'.repeat(32)

function layer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'direct',
    type: 'direct',
    name: 'home',
    address: 'https://home.example:8768',
    enabled: true,
    tlsMode: 'system',
    ...overrides,
  }
}

describe('validateNetworkConfig', () => {
  it('accepts direct IPv4 and IPv6 origins with unique ids', () => {
    const result = validateNetworkConfig({
      layers: [
        layer({ id: 'v4', name: 'v4', address: 'https://192.168.1.10:8768' }),
        layer({ id: 'v6', name: 'v6', address: 'https://[fd00::1]:8768' }),
      ],
      activeLayerId: 'v6',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.network.layers.map((entry) => entry.address)).toEqual([
      'https://192.168.1.10:8768',
      'https://[fd00::1]:8768',
    ])
    expect(result.network.activeLayerId).toBe('v6')
  })

  it('rejects adding or enabling a P2P layer with P2P_NOT_AVAILABLE', () => {
    for (const enabled of [true, false]) {
      const result = validateNetworkConfig({
        layers: [layer({ id: 'p2p', name: 'p2p', type: 'p2p', enabled })],
      })
      expect(result).toEqual({
        ok: false,
        code: 'P2P_NOT_AVAILABLE',
        message: 'P2P 传输尚未接入，后续统一做',
      })
    }
  })

  it('requires a SHA-256 fingerprint for pinned layers', () => {
    const missing = validateNetworkConfig({
      layers: [layer({ tlsMode: 'pinned' })],
    })
    expect(missing).toMatchObject({ ok: false, code: 'INVALID_LAYER' })

    const accepted = validateNetworkConfig({
      layers: [layer({ tlsMode: 'pinned', fingerprint256: FINGERPRINT.toUpperCase() })],
    })
    expect(accepted.ok).toBe(true)
    if (accepted.ok) expect(accepted.network.layers[0]?.fingerprint256).toBe(FINGERPRINT)
  })

  it('drops an active id that refers to a disabled layer', () => {
    const result = validateNetworkConfig({
      layers: [layer({ enabled: false })],
      activeLayerId: 'direct',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.network.activeLayerId).toBeUndefined()
  })

  it('rejects duplicate ids, duplicate names and non-loopback http', () => {
    expect(
      validateNetworkConfig({ layers: [layer(), layer({ name: 'other' })] }),
    ).toMatchObject({ ok: false, code: 'INVALID_LAYER' })
    expect(
      validateNetworkConfig({ layers: [layer(), layer({ id: 'other' })] }),
    ).toMatchObject({ ok: false, code: 'INVALID_LAYER' })
    expect(
      validateNetworkConfig({ layers: [layer({ address: 'http://example.com:8768' })] }),
    ).toMatchObject({ ok: false, code: 'INVALID_LAYER' })
  })

  it('allows http only for loopback', () => {
    const result = validateNetworkConfig({
      layers: [layer({ address: 'http://127.0.0.1:8768' })],
    })
    expect(result.ok).toBe(true)
  })
})

describe('network derivation', () => {
  const network: NetworkConfig = {
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

  it('derives server and transport from the active layer only', () => {
    expect(buildServerFromNetwork(network)).toEqual({
      url: 'https://frp.example:8443',
      allowUntrustedCa: false,
    })
    expect(buildTransportFromNetwork(network)).toEqual({
      mode: 'frp',
      endpointCandidates: [
        { name: 'home', url: 'https://home.example:8768', priority: 1 },
        { name: 'frp', url: 'https://frp.example:8443', priority: 2 },
      ],
      currentEndpoint: 'frp',
    })
  })

  it('derives a pinned server with an IPv6 literal host without brackets', () => {
    const pinned: NetworkConfig = {
      layers: [
        {
          id: 'ipv6',
          type: 'direct',
          name: 'ipv6',
          address: 'https://[fd00::1]:8768',
          enabled: true,
          tlsMode: 'pinned',
          fingerprint256: FINGERPRINT,
        },
      ],
      activeLayerId: 'ipv6',
    }
    expect(buildServerFromNetwork(pinned)).toEqual({
      url: 'https://[fd00::1]:8768',
      allowUntrustedCa: true,
      tlsPin: { host: 'fd00::1', fingerprint256: FINGERPRINT },
    })
  })

  it('updates the active layer when a legacy server is saved', () => {
    const next = networkWithServer(network, {
      url: 'https://new.example:8768',
      allowUntrustedCa: false,
    })
    expect(next.activeLayerId).toBe('frp')
    expect(next.layers.find((entry) => entry.id === 'frp')?.address).toBe(
      'https://new.example:8768',
    )
  })

  it('excludes P2P layers from selectable layers', () => {
    expect(network.layers.filter(isSelectableLayer).map((entry) => entry.id)).toEqual([
      'direct',
      'frp',
    ])
  })
})

describe('validateWindowPreferences', () => {
  it('requires both flags as booleans', () => {
    expect(validateWindowPreferences({ minimizeToTray: true })).toEqual({
      ok: false,
      message: 'openAtLogin 必须是布尔值',
    })
    expect(validateWindowPreferences({ minimizeToTray: 'yes', openAtLogin: false })).toEqual({
      ok: false,
      message: 'minimizeToTray 必须是布尔值',
    })
    expect(validateWindowPreferences({ minimizeToTray: false, openAtLogin: true })).toEqual({
      ok: true,
      preferences: { minimizeToTray: false, openAtLogin: true },
    })
  })
})
