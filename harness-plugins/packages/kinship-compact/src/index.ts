/**
 * `compact_context` for the Kinship preset: the model-callable manual compaction
 * Loom mounts on its main session.
 *
 * Loom's tool starts a compaction worker and lets the current turn suspend at its
 * next LLM call. dsh has no such suspension hook, and its
 * `CompactionEngine.compactNow` is an idle-session operation: during a turn it
 * fails with the `busy` `ManualCompactionError`. A tool always runs inside a
 * turn, so the tool cannot compact synchronously.
 *
 * The tool therefore records the request and returns immediately; a plugin-owned
 * poll waits for the agent to become idle after the turn and compacts exactly
 * once. From the model's point of view the contract still matches Loom's: call
 * `compact_context`, get a short acknowledgement, and let the harness compact.
 * The difference is that the compaction lands in the gap before the next prompt
 * instead of mid-turn.
 *
 * @module kinship-compact
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** Parsed plugin configuration. */
export interface Config {
  /** How often the deferred scan runs while a request is pending. */
  pollIntervalMs: number
  /** Longest a scheduled request is retried before it is dropped. */
  maxWaitMs: number
  /** How many `busy` attempts a scheduled request may spend. */
  maxAttempts: number
}

/** Config schema shown by `dsh --dump-config-schema`. */
export const Config: z<Config> = z.object({
  pollIntervalMs: z.number().step(1).min(1).default(500).description('Poll interval in milliseconds for a scheduled compaction; only runs while a request is pending.'),
  maxWaitMs: z.number().step(1).min(0).default(600_000).description('Milliseconds a scheduled compaction may wait for the agent to become idle before it is dropped.'),
  maxAttempts: z.number().step(1).min(1).default(600).description('Maximum number of busy attempts for one scheduled compaction.'),
})

/** Stable Cordis plugin name. */
export const name = 'kinship-compact'

/** The tool registry and the compaction seam are the required host services. */
export const inject = ['tools', 'compaction']

/** What one `compact_context` call settled on. */
export interface CompactContextOutcome {
  /** `finished` compacted now, `empty` had no safe range, `scheduled` waits for turn end. */
  readonly status: 'finished' | 'empty' | 'scheduled'
  /** Shadowed history items on `finished`; 0 otherwise. */
  readonly items: number
}

/** One deferred compaction waiting for its agent to become idle. */
interface PendingRequest {
  /** Agent whose history should be compacted. */
  readonly agent: Agent
  /** Wall-clock time of the newest request; the `maxWaitMs` budget starts here. */
  readonly requestedAt: number
  /** Busy attempts already spent; compared against `maxAttempts`. */
  attempts: number
}

const SCHEDULED_TEXT = 'Compaction scheduled: it runs when this turn ends.'

const OUTCOME_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    status: { type: 'string' as const, required: true, enum: ['finished', 'empty', 'scheduled'] },
    items: { type: 'integer' as const, required: true },
  },
} as const

function renderOutcome(_args: unknown, value: CompactContextOutcome): { type: 'text'; text: string }[] {
  if (value.status === 'scheduled') return [{ type: 'text', text: SCHEDULED_TEXT }]
  if (value.status === 'empty') return [{ type: 'text', text: 'No compactable history yet.' }]
  return [{ type: 'text', text: `Compaction finished (~${String(value.items)} history items).` }]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Mount `compact_context` and the deferred-compaction poll over `ctx.compaction`. */
export function apply(ctx: Context, config: Config): void {
  /** At most one request per agent session; a newer call replaces the older one. */
  const pending = new Map<string, PendingRequest>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const info = (text: string): void => {
    ctx.logger.info(`kinship-compact: ${text}`)
  }
  const warn = (text: string): void => {
    ctx.logger.warn(`kinship-compact: ${text}`)
  }

  /** Run one manual compaction against whatever the engine serves this context. */
  const compactNow = async (agent: Agent): Promise<CompactionResult | null> =>
    ctx.compaction.compactNow(agent, new AbortController().signal)

  /**
   * Drop one request unless a newer call replaced it while the scan was awaiting.
   *
   * @param key - session key of the request.
   * @param request - exact entry the scan is settling.
   * @returns whether this scan still owned the entry.
   */
  const settle = (key: string, request: PendingRequest): boolean => {
    if (pending.get(key) !== request) return false
    pending.delete(key)
    return true
  }

  /** Arm the next scan; nothing is scheduled while no request is pending. */
  const arm = (): void => {
    if (disposed || timer !== null || pending.size === 0) return
    const handle = setTimeout(() => {
      timer = null
      void tick()
    }, config.pollIntervalMs)
    handle.unref?.()
    timer = handle
  }

  /** Try every pending request once; running agents are simply left for the next tick. */
  const scan = async (): Promise<void> => {
    for (const [key, request] of [...pending.entries()]) {
      if (disposed) return
      const waitedMs = Date.now() - request.requestedAt
      if (waitedMs > config.maxWaitMs) {
        settle(key, request)
        warn(`dropped the compaction scheduled for session ${key} after ${String(waitedMs)}ms`)
        continue
      }
      if (request.agent.status !== 'idle') continue
      try {
        const result = await compactNow(request.agent)
        if (!settle(key, request)) continue
        if (result === null) info(`session ${key} had no compactable history`)
        else {
          info(
            `compacted session ${key}: ${String(result.shadowedSeqs.length)} history items (~${String(result.shadowedTokenCount)} tokens)`,
          )
        }
      } catch (error) {
        if (error instanceof ManualCompactionError && error.code === 'busy') {
          request.attempts += 1
          if (request.attempts >= config.maxAttempts) {
            settle(key, request)
            warn(`gave up on the compaction scheduled for session ${key} after ${String(request.attempts)} busy attempts`)
          }
          continue
        }
        if (!settle(key, request)) continue
        warn(`compaction for session ${key} failed: ${messageOf(error)}`)
      }
    }
  }

  /** One poll: scan, then re-arm while work remains. */
  const tick = async (): Promise<void> => {
    await scan()
    arm()
  }

  /** Record a request for one agent and make sure the poll is running. */
  const schedule = (agent: Agent): void => {
    const key = String(agent.session.id)
    pending.set(key, { agent, requestedAt: Date.now(), attempts: 0 })
    info(`scheduled a compaction for session ${key}; it runs when the turn ends`)
    arm()
  }

  ctx.tools.register(defineTool({
    name: 'compact_context',
    description:
      'Compact this session\'s older context into a summary. Returns immediately: the request runs as '
      + 'soon as the current turn ends. Use it only when no higher-priority work is unfinished, because '
      + 'the summarized history is no longer available verbatim.',
    parameters: {},
    output: {
      schema: OUTCOME_SCHEMA,
      render: renderOutcome,
    },
    async execute(_args, exec): Promise<CompactContextOutcome> {
      const agent = exec.agent
      if (agent === undefined) throw new Error('compact_context requires an owning agent session')
      if (agent.status === 'idle') {
        try {
          const result = await compactNow(agent)
          if (result === null) return { status: 'empty', items: 0 }
          return { status: 'finished', items: result.shadowedSeqs.length }
        } catch (error) {
          // The turn can start between the status read and the call; defer instead
          // of surfacing a race the model cannot act on.
          if (!(error instanceof ManualCompactionError) || error.code !== 'busy') throw error
        }
      }
      schedule(agent)
      return { status: 'scheduled', items: 0 }
    },
  }))

  ctx.effect(() => () => {
    disposed = true
    pending.clear()
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }, 'kinship-compact scheduled compaction')

  ctx.logger.info(
    `kinship-compact: compact_context mounted (poll=${String(config.pollIntervalMs)}ms, maxWait=${String(config.maxWaitMs)}ms)`,
  )
}
