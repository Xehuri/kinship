import type { SensorStatus } from '../../shared/types'
import type { SpaAccessResult } from '../app-controller'
import type { SensorAuthToken } from './sensor-supervisor'

export interface StartupAuthOptions {
  readonly getAuthToken: () => Promise<SensorAuthToken | null>
  readonly getStatus: () => SensorStatus | null
  readonly waitMs: number
  readonly pollMs: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

const TERMINAL_STATES = new Set(['runtime-missing', 'conflict', 'crashed'])

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export async function waitForStartupAuth(
  options: StartupAuthOptions,
): Promise<SpaAccessResult> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const deadline = now() + Math.max(0, options.waitMs)

  for (;;) {
    let auth: SensorAuthToken | null = null
    try {
      auth = await options.getAuthToken()
    } catch {
      auth = null
    }
    if (auth !== null && auth.token.length > 0) return { ok: true }

    const status = options.getStatus()
    if (status !== null && TERMINAL_STATES.has(status.state)) {
      return {
        ok: false,
        code: 'SENSOR_UNAVAILABLE',
        message: status.lastError ?? 'PC 采集端不可用',
      }
    }

    if (now() >= deadline) {
      return {
        ok: false,
        code: 'AUTH_TOKEN_UNAVAILABLE',
        message: 'PC 采集端尚未提供后端 Token',
      }
    }
    await sleep(options.pollMs)
  }
}
