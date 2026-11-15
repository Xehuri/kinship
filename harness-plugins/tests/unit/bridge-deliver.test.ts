import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { BridgeError } from '../../packages/kinship-bridge/src/errors.js'
import {
  Config,
  apply,
  inject,
  name,
} from '../../packages/kinship-bridge/src/index.js'
import type { KinshipBridgeService } from '../../packages/kinship-bridge/src/index.js'
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

interface MountedBridge {
  readonly service: KinshipBridgeService
  dispose(): Promise<void>
}

interface MountOptions {
  /** Persist this Session id before the plugin starts, like a finished restart. */
  readonly storedSessionId?: string
  /** Mount the `sessionController` service the resume path resolves through. */
  readonly resolveAgent?: (sessionId: unknown) => Promise<unknown>
}

/**
 * Apply the real plugin over a fake agent registry under a temp DSH_HOME.
 *
 * This is the seam `bridge-cordis.test.ts` uses for the plugin service; the
 * only fakes are the `agents`/`agentPresets`/`subagents` services and, when a
 * test scripts a resume, `sessionController`.
 */
async function mountBridge(
  agents: Map<string, TestAgent>,
  options: MountOptions = {},
): Promise<MountedBridge> {
  const home = mkdtempSync(join(tmpdir(), 'kinship-deliver-'))
  homes.push(home)
  process.env['DSH_HOME'] = home
  process.env['KINSHIP_BRIDGE_TOKEN'] = 'test-token'

  if (options.storedSessionId !== undefined) {
    const bindingPath = join(home, 'kinship', 'binding.json')
    mkdirSync(dirname(bindingPath), { recursive: true })
    writeFileSync(
      bindingPath,
      `${JSON.stringify({
        schema: 1,
        session_id: options.storedSessionId,
        preset: 'kinship',
        bound_at: 1,
        policy: 'first',
      })}\n`,
      'utf8',
    )
  }

  const ctx = new Context()
  ctx.provide('agents', {
    list: () => [...agents.values()],
    get: (id: unknown) => agents.get(String(id)),
  })
  ctx.provide('agentPresets', {
    presetForSession: (session: { header: { agentPreset?: string } }) => session.header.agentPreset ?? null,
  })
  ctx.provide('subagents', {
    listDescendants: async (_id: unknown) => [],
  })
  if (options.resolveAgent !== undefined) {
    ctx.provide('sessionController', { resolveAgent: options.resolveAgent })
  }

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

  const service = ctx.get('kinshipBridge')
  if (service === undefined) throw new Error('kinshipBridge service missing')
  return {
    service,
    dispose: async () => {
      await fiber.dispose()
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Text of one created user message, joined the way the projection is. */
function textOf(message: UserMessage | undefined): string {
  const parts: string[] = []
  for (const block of message === undefined ? [] : message.content) {
    if (isRecord(block) && typeof block['text'] === 'string' && block['text'] !== '') {
      parts.push(block['text'])
    }
  }
  return parts.join('\n')
}

describe('kinship bridge deliver', () => {
  it('delivers one user message into the bound session', async () => {
    const agent = new TestAgent('session-k', 'kinship')
    const mounted = await mountBridge(new Map([['session-k', agent]]))
    try {
      const result = await mounted.service.deliver('wake up for the plan')

      expect(agent.sent).toHaveLength(1)
      expect(agent.sent[0]?.target).toBe('next-turn')
      expect(agent.sent[0]?.message.source).toMatchObject({
        kind: 'kinship:bridge',
        source: 'plan-scheduler',
      })
      expect(textOf(agent.sent[0]?.message)).toBe('wake up for the plan')
      expect(result.sessionId).toBe(String(agent.session.id))
      expect(result.messageId).not.toBe('')
    } finally {
      await mounted.dispose()
    }
  })

  it('trims surrounding whitespace before sending', async () => {
    const agent = new TestAgent('session-k', 'kinship')
    const mounted = await mountBridge(new Map([['session-k', agent]]))
    try {
      await mounted.service.deliver('  spaced out  \n')

      expect(agent.sent).toHaveLength(1)
      expect(textOf(agent.sent[0]?.message)).toBe('spaced out')
    } finally {
      await mounted.dispose()
    }
  })

  it('rejects empty and whitespace-only text without sending', async () => {
    const agent = new TestAgent('session-k', 'kinship')
    const mounted = await mountBridge(new Map([['session-k', agent]]))
    try {
      await expect(mounted.service.deliver('')).rejects.toBeInstanceOf(BridgeError)
      await expect(mounted.service.deliver('   \n\t ')).rejects.toMatchObject({
        name: 'BridgeError',
        status: 422,
        code: 'invalid_message',
      })
      expect(agent.sent).toHaveLength(0)
    } finally {
      await mounted.dispose()
    }
  })

  it('rejects when the bound session is not live and cannot be resumed', async () => {
    const mounted = await mountBridge(new Map(), { storedSessionId: 'session-gone' })
    try {
      await expect(mounted.service.deliver('wake up')).rejects.toMatchObject({
        name: 'BridgeError',
        status: 409,
        code: 'bound_session_unavailable',
      })
    } finally {
      await mounted.dispose()
    }
  })

  it('rejects when the resume path reports the session as not found', async () => {
    const mounted = await mountBridge(new Map(), {
      storedSessionId: 'session-gone',
      resolveAgent: async () => ({ error: { code: 'session/not-found' } }),
    })
    try {
      await expect(mounted.service.deliver('wake up')).rejects.toMatchObject({
        name: 'BridgeError',
        status: 409,
        code: 'bound_session_missing',
      })
    } finally {
      await mounted.dispose()
    }
  })
})
