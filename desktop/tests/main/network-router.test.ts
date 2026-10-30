// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { NetworkRouter } from '../../src/main/lib/network-router'
import type { TransportAdapter } from '../../src/main/lib/network-transport'
import type { NetworkConfig, NetworkLayer, NetworkLayerType } from '../../src/shared/types'

function layer(
  id: string,
  overrides: Partial<NetworkLayer> = {},
): NetworkLayer {
  return {
    id,
    type: 'direct',
    name: id,
    address: `https://${id}.example:8768`,
    enabled: true,
    tlsMode: 'system',
    ...overrides,
  }
}

function config(...layers: NetworkLayer[]): NetworkConfig {
  return { layers }
}

function adapter(
  type: NetworkLayerType,
  probe: TransportAdapter['probe'],
): TransportAdapter {
  return { type, probe }
}

describe('NetworkRouter', () => {
  it('probes enabled layers in order and stops at the first healthy one', async () => {
    const calls: string[] = []
    const direct = adapter('direct', async (entry) => {
      calls.push(entry.id)
      return entry.id === 'second'
        ? { ok: true, latencyMs: 12 }
        : { ok: false, latencyMs: 3, error: '连接被拒绝', code: 'CONNECT_FAILED' }
    })
    const router = new NetworkRouter({
      getNetwork: () => config(layer('first'), layer('second'), layer('third')),
      adapters: {
        direct,
        frp: adapter('frp', async () => {
          throw new Error('should not be called')
        }),
        p2p: adapter('p2p', async () => {
          throw new Error('should not be called')
        }),
      },
      now: () => new Date('2026-10-25T00:00:00.000Z'),
    })

    const outcome = await router.probe()

    expect(calls).toEqual(['first', 'second'])
    expect(outcome.selectedLayerId).toBe('second')
    expect(outcome.statuses.map((status) => status.state)).toEqual([
      'unhealthy',
      'healthy',
      'skipped',
    ])
    expect(outcome.statuses[0]?.checkedAt).toBe('2026-10-25T00:00:00.000Z')
    expect(outcome.statuses[2]?.code).toBe('NOT_PROBED')
  })

  it('reports every failure when no layer is healthy', async () => {
    const failing = adapter('direct', async () => ({
      ok: false,
      latencyMs: 5,
      error: '连接被拒绝',
      code: 'CONNECT_FAILED',
    }))
    const router = new NetworkRouter({
      getNetwork: () => config(layer('home'), layer('frp', { type: 'frp' })),
      adapters: {
        direct: failing,
        frp: failing,
        p2p: adapter('p2p', async () => ({ ok: false, latencyMs: 0 })),
      },
    })

    const outcome = await router.probe()

    expect(outcome.selectedLayerId).toBeUndefined()
    expect(outcome.code).toBe('NO_HEALTHY_LAYER')
    expect(outcome.error).toContain('无法连接服务器')
    expect(outcome.statuses.every((status) => status.state === 'unhealthy')).toBe(true)
  })

  it('skips disabled and P2P layers with explicit codes', async () => {
    const calls: string[] = []
    const router = new NetworkRouter({
      getNetwork: () =>
        config(
          layer('off', { enabled: false }),
          layer('p2p', { type: 'p2p' }),
          layer('ok'),
        ),
      adapters: {
        direct: adapter('direct', async (entry) => {
          calls.push(entry.id)
          return { ok: true, latencyMs: 1 }
        }),
        frp: adapter('frp', async () => ({ ok: false, latencyMs: 0 })),
        p2p: adapter('p2p', async () => ({ ok: false, latencyMs: 0 })),
      },
    })

    const outcome = await router.probe()

    expect(calls).toEqual(['ok'])
    expect(outcome.selectedLayerId).toBe('ok')
    expect(outcome.statuses[0]).toMatchObject({ state: 'skipped', code: 'DISABLED' })
    expect(outcome.statuses[1]).toMatchObject({
      state: 'skipped',
      code: 'P2P_NOT_AVAILABLE',
    })
  })

  it('honours onlyLayerIds, exclusions and startAfter for manual and fallback probes', async () => {
    const calls: string[] = []
    const router = new NetworkRouter({
      getNetwork: () => config(layer('one'), layer('two'), layer('three')),
      adapters: {
        direct: adapter('direct', async (entry) => {
          calls.push(entry.id)
          return { ok: true, latencyMs: 1 }
        }),
        frp: adapter('frp', async () => ({ ok: false, latencyMs: 0 })),
        p2p: adapter('p2p', async () => ({ ok: false, latencyMs: 0 })),
      },
    })

    const only = await router.probe({ onlyLayerIds: ['two'] })
    expect(calls).toEqual(['two'])
    expect(only.selectedLayerId).toBe('two')

    calls.length = 0
    const after = await router.probe({
      startAfterLayerId: 'one',
      excludeLayerIds: ['three'],
    })
    expect(calls).toEqual(['two'])
    expect(after.selectedLayerId).toBe('two')

    calls.length = 0
    const none = await router.probe({ excludeLayerIds: ['one', 'two', 'three'] })
    expect(calls).toEqual([])
    expect(none.code).toBe('NO_FALLBACK_LAYER')
  })
})

describe('NetworkFailoverTracker', () => {
  it('tries each layer at most once per load failure and resets on ready', async () => {
    const { NetworkFailoverTracker } = await import('../../src/main/lib/network-failover')
    const tracker = new NetworkFailoverTracker()

    expect(tracker.canAttempt(1)).toBe(false)
    tracker.recordFailure('one')
    expect(tracker.canAttempt(2)).toBe(true)
    expect(tracker.getExclusions()).toEqual(['one'])
    tracker.recordFailure('two')
    expect(tracker.canAttempt(2)).toBe(false)
    tracker.recordFailure(undefined)
    expect(tracker.getExclusions()).toEqual(['one', 'two'])
    tracker.reset()
    expect(tracker.canAttempt(2)).toBe(true)
    expect(tracker.getExclusions()).toEqual([])
  })
})
