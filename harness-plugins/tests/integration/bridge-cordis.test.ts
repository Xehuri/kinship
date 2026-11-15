import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Config,
  apply,
  inject,
  name,
} from '../../packages/kinship-bridge/src/index.js'
import { TestAgent } from '../helpers/fake-agent.js'

const homes: string[] = []
const previousHome = process.env['DSH_HOME']
const previousToken = process.env['KINSHIP_BRIDGE_TOKEN']

afterEach(() => {
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  if (previousToken === undefined) delete process.env['KINSHIP_BRIDGE_TOKEN']
  else process.env['KINSHIP_BRIDGE_TOKEN'] = previousToken
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('kinship-bridge Cordis wiring', () => {
  it('serves the bound agent through the plugin service', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kinship-cordis-'))
    homes.push(home)
    process.env['DSH_HOME'] = home
    process.env['KINSHIP_BRIDGE_TOKEN'] = 'test-token'

    const agent = new TestAgent('session-k', 'kinship')
    const ctx = new Context()
    ctx.provide('agents', {
      list: () => [agent],
      get: (id: unknown) => (String(id) === 'session-k' ? agent : undefined),
    })
    ctx.provide('agentPresets', {
      presetForSession: (session: { header: { agentPreset?: string } }) => session.header.agentPreset ?? null,
    })
    ctx.provide('subagents', {
      listDescendants: async (_id: unknown) => [],
    })

    const fiber = ctx.plugin({ name, inject, apply, Config }, {
      host: '127.0.0.1',
      port: 0,
      tokenEnv: 'KINSHIP_BRIDGE_TOKEN',
      tokenFile: '',
      policy: 'first',
      sessionId: '',
      rebindOnMissing: false,
      bodyLimitBytes: 1_024,
    })
    await fiber

    try {
      const service = ctx.get('kinshipBridge')
      expect(service).toBeDefined()
      if (service === undefined) throw new Error('bridge service missing')
      const base = `http://127.0.0.1:${String(service.port())}`

      const health = await fetch(`${base}/v1/health`, {
        headers: { authorization: 'Bearer test-token' },
      })
      expect(health.status).toBe(200)
      expect(await health.json()).toMatchObject({ session_id: 'session-k', preset: 'kinship', status: 'bound' })

      const sent = await fetch(`${base}/v1/session/messages`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: 'from cordis', source: 'test' }),
      })
      expect(sent.status).toBe(202)
      expect(agent.sent).toHaveLength(1)
      expect(agent.sent[0]?.target).toBe('next-turn')
      expect(JSON.stringify(agent.sent[0]?.message.content)).toContain('from cordis')

      const messages = await fetch(`${base}/v1/session/messages`, {
        headers: { authorization: 'Bearer test-token' },
      })
      expect(messages.status).toBe(200)
      const page: unknown = await messages.json()
      expect(page).toMatchObject({ messages: [{ role: 'user', text: 'from cordis' }] })

      const abort = await fetch(`${base}/v1/session/abort`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token' },
      })
      expect(abort.status).toBe(202)
      expect(agent.cancelled).toEqual({ kind: 'user' })

      const children = await fetch(`${base}/v1/session/children`, {
        headers: { authorization: 'Bearer test-token' },
      })
      expect(children.status).toBe(200)
      expect(await children.json()).toMatchObject({ session_id: 'session-k', children: [] })
    } finally {
      await fiber.dispose()
    }
  })
})
