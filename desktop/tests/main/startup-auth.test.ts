// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { waitForStartupAuth } from '../../src/main/lib/startup-auth'
import type { SensorStatus } from '../../src/shared/types'

function status(overrides: Partial<SensorStatus> = {}): SensorStatus {
  return {
    state: 'starting',
    enabled: true,
    running: false,
    port: 18888,
    ...overrides,
  }
}

describe('waitForStartupAuth', () => {
  it('returns immediately when the sensor already has a token', async () => {
    let calls = 0
    const result = await waitForStartupAuth({
      getAuthToken: async () => {
        calls += 1
        return { token: 'ready-token', expiresIn: 3600 }
      },
      getStatus: () => status(),
      waitMs: 1000,
      pollMs: 10,
    })

    expect(result).toEqual({ ok: true })
    expect(calls).toBe(1)
  })

  it('polls until a token appears', async () => {
    let now = 0
    let calls = 0
    const result = await waitForStartupAuth({
      getAuthToken: async () => {
        calls += 1
        return calls >= 3 ? { token: 'late-token', expiresIn: null } : null
      },
      getStatus: () => status({ state: 'running', running: true }),
      waitMs: 1000,
      pollMs: 100,
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
    })

    expect(result).toEqual({ ok: true })
    expect(calls).toBe(3)
  })

  it('fails fast when the sensor is terminal', async () => {
    const result = await waitForStartupAuth({
      getAuthToken: async () => null,
      getStatus: () => status({ state: 'runtime-missing', lastError: '缺少运行时' }),
      waitMs: 5000,
      pollMs: 10,
    })

    expect(result).toEqual({
      ok: false,
      code: 'SENSOR_UNAVAILABLE',
      message: '缺少运行时',
    })
  })

  it('returns AUTH_TOKEN_UNAVAILABLE after the bounded wait', async () => {
    let now = 0
    const result = await waitForStartupAuth({
      getAuthToken: async () => null,
      getStatus: () => status({ state: 'running', running: true }),
      waitMs: 250,
      pollMs: 100,
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
    })

    expect(result).toMatchObject({ ok: false, code: 'AUTH_TOKEN_UNAVAILABLE' })
    expect(now).toBeGreaterThanOrEqual(250)
  })

  it('treats a throwing token lookup as unavailable and keeps polling', async () => {
    let calls = 0
    const result = await waitForStartupAuth({
      getAuthToken: async () => {
        calls += 1
        if (calls === 1) throw new Error('transient')
        return { token: 'recovered', expiresIn: null }
      },
      getStatus: () => status(),
      waitMs: 1000,
      pollMs: 10,
    })

    expect(result).toEqual({ ok: true })
    expect(calls).toBe(2)
  })
})
