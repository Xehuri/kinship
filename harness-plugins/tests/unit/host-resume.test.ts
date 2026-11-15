import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { createCordisHost } from '../../packages/kinship-bridge/src/host.js'
import type { BridgeHost, ResumeResult } from '../../packages/kinship-bridge/src/types.js'
import { TestAgent } from '../helpers/fake-agent.js'

function hostFor(resolve: (sessionId: unknown) => Promise<unknown>): {
  readonly host: BridgeHost
  readonly calls: string[]
} {
  const ctx = new Context()
  const calls: string[] = []
  ctx.provide('sessionController', {
    resolveAgent: async (sessionId: unknown) => {
      calls.push(String(sessionId))
      return resolve(sessionId)
    },
  })
  return { host: createCordisHost(ctx), calls }
}

async function resume(host: BridgeHost, sessionId: string): Promise<ResumeResult> {
  if (host.resume === undefined) throw new Error('host has no resume capability')
  return host.resume(sessionId)
}

describe('Cordis host resume', () => {
  it('maps a resolved agent to resumed', async () => {
    const agent = new TestAgent('session-restored', 'kinship')
    const { host, calls } = hostFor(async () => ({ agent }))

    const result = await resume(host, 'session-restored')

    expect(calls).toEqual(['session-restored'])
    expect(result.status).toBe('resumed')
    if (result.status !== 'resumed') return
    expect(result.session.info()).toMatchObject({
      id: 'session-restored',
      preset: 'kinship',
      isRoot: true,
      status: 'idle',
    })
  })

  it('maps session/not-found to missing', async () => {
    const { host } = hostFor(async () => ({ error: { code: 'session/not-found' } }))

    expect(await resume(host, 'gone')).toEqual({ status: 'missing' })
  })

  it('maps any other failure code to unavailable with a stable reason', async () => {
    const { host } = hostFor(async () => ({ error: { code: 'gateway/internal' } }))

    const result = await resume(host, 'broken')

    expect(result.status).toBe('unavailable')
    if (result.status === 'unavailable') expect(result.reason).toContain('gateway/internal')
  })

  it('maps a thrown controller failure to unavailable', async () => {
    const { host } = hostFor(async () => {
      throw new Error('persistence is closed')
    })

    const result = await resume(host, 'broken')

    expect(result.status).toBe('unavailable')
    if (result.status === 'unavailable') expect(result.reason).toContain('persistence is closed')
  })

  it('reports unavailable when the composition has no sessionController', async () => {
    const host = createCordisHost(new Context())

    const result = await resume(host, 'session-restored')

    expect(result.status).toBe('unavailable')
    if (result.status === 'unavailable') expect(result.reason).toContain('sessionController')
  })

  it('rejects a resumed non-kinship preset as missing', async () => {
    const agent = new TestAgent('session-other', 'standard')
    const { host } = hostFor(async () => ({ agent }))

    expect(await resume(host, 'session-other')).toEqual({ status: 'missing' })
  })

  it('rejects a resumed child session as missing', async () => {
    const childAgent = {
      session: {
        id: 'session-child',
        header: { createdAt: 1, parentSession: 'parent', agentPreset: 'kinship' },
      },
      status: 'idle',
    }
    const { host } = hostFor(async () => ({ agent: childAgent }))

    expect(await resume(host, 'session-child')).toEqual({ status: 'missing' })
  })
})
