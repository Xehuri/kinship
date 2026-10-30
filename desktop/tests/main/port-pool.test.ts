// @vitest-environment node
import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { isPortFree, selectSensorPort } from '../../src/main/lib/port-pool'
import type { SensorPortProbe } from '../../src/main/lib/port-pool'

function select(
  preferred: number,
  probe: (port: number) => Promise<SensorPortProbe>,
  freePorts: readonly number[],
): ReturnType<typeof selectSensorPort> {
  return selectSensorPort({
    preferred,
    maxPort: 18898,
    isPortFree: (port) => Promise.resolve(freePorts.includes(port)),
    probe,
  })
}

describe('selectSensorPort', () => {
  it('keeps the preferred port when it is free', async () => {
    const result = await select(18888, () => Promise.resolve('free'), [])

    expect(result).toEqual({ kind: 'preferred', port: 18888 })
  })

  it('reports a conflict when another sensor owns the preferred port', async () => {
    const result = await select(18888, () => Promise.resolve('sensor'), [])

    expect(result).toEqual({ kind: 'conflict', port: 18888 })
  })

  it('falls back to the next free port when a foreign service owns the preferred port', async () => {
    const result = await select(18888, () => Promise.resolve('foreign'), [18889, 18890])

    expect(result).toEqual({ kind: 'fallback', port: 18889 })
  })

  it('returns none when the foreign service occupies a full scan range', async () => {
    const result = await select(18898, () => Promise.resolve('foreign'), [])

    expect(result).toEqual({ kind: 'none' })
  })

  it('never probes a fallback port that the probe classifies as occupied', async () => {
    const probed: number[] = []
    const result = await selectSensorPort({
      preferred: 18888,
      maxPort: 18890,
      probe: (port) => {
        probed.push(port)
        return Promise.resolve(port === 18888 ? 'foreign' : 'sensor')
      },
      isPortFree: (port) => Promise.resolve(port === 18889),
    })

    expect(result).toEqual({ kind: 'fallback', port: 18889 })
    expect(probed).toEqual([18888])
  })
})

describe('isPortFree', () => {
  it('reports a listening loopback port as occupied and a closed port as free', async () => {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })

    const address = server.address()
    if (address === null || typeof address === 'string') {
      server.close()
      throw new Error('test server did not bind a TCP port')
    }

    try {
      expect(await isPortFree(address.port)).toBe(false)
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    }

    expect(await isPortFree(address.port)).toBe(true)
  })
})
