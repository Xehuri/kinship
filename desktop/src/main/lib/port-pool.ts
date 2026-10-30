import { createServer } from 'node:net'

export type SensorPortProbe = 'sensor' | 'foreign' | 'free'

export type SensorPortSelection =
  | { readonly kind: 'preferred'; readonly port: number }
  | { readonly kind: 'conflict'; readonly port: number }
  | { readonly kind: 'fallback'; readonly port: number }
  | { readonly kind: 'none' }

export interface SelectSensorPortOptions {
  readonly preferred: number
  readonly maxPort: number
  readonly isPortFree: (port: number) => Promise<boolean>
  readonly probe: (port: number) => Promise<SensorPortProbe>
}

export function isPortFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = createServer()
    let settled = false

    const finish = (free: boolean): void => {
      if (settled) return
      settled = true
      try {
        server.close()
      } finally {
        resolve(free)
      }
    }

    server.once('error', () => finish(false))
    server.once('listening', () => finish(true))

    try {
      server.listen({ host: '127.0.0.1', port, exclusive: true })
    } catch (error) {
      if (!(error instanceof Error)) throw error
      finish(false)
    }
  })
}

export async function selectSensorPort(
  options: SelectSensorPortOptions,
): Promise<SensorPortSelection> {
  const preferredProbe = await options.probe(options.preferred)
  if (preferredProbe === 'free') {
    return { kind: 'preferred', port: options.preferred }
  }
  if (preferredProbe === 'sensor') {
    return { kind: 'conflict', port: options.preferred }
  }

  for (let port = options.preferred + 1; port <= options.maxPort; port += 1) {
    if (await options.isPortFree(port)) {
      return { kind: 'fallback', port }
    }
  }

  return { kind: 'none' }
}
