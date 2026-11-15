/**
 * Acceptance for `kinship-compact`: one `compact_context` tool over the dsh
 * compaction seam, immediate on an idle agent and deferred until the turn ends
 * on a running one, plus the retry, replacement, timeout, disposal, and error
 * paths of the deferred poll.
 *
 * Everything runs against a fake Cordis context and fake timers, so no harness
 * process, session log, or compaction model is involved.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Mock } from 'vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, apply, inject, name } from '../../packages/kinship-compact/src/index.js'
import type { CompactContextOutcome } from '../../packages/kinship-compact/src/index.js'
import { TestAgent } from '../helpers/fake-agent.js'

/** Small poll interval so one `advanceTimersByTimeAsync` call is one tick. */
const POLL_MS = 10

/** Wall-clock budget used unless a test overrides it. */
const MAX_WAIT_MS = 1_000

/** How many busy attempts a scheduled request may spend unless overridden. */
const MAX_ATTEMPTS = 5

interface FakeCompactResult {
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount: number
}

type CompactMock = Mock<(agent: Agent, signal: AbortSignal) => Promise<FakeCompactResult | null>>

interface Harness {
  readonly tools: ToolDefinition[]
  readonly compactNow: CompactMock
  readonly info: string[]
  readonly warnings: string[]
  readonly tool: ToolDefinition
  dispose(): void
}

interface HarnessOptions {
  readonly pollIntervalMs?: number
  readonly maxWaitMs?: number
  readonly maxAttempts?: number
}

const harnesses: Harness[] = []

/**
 * Compose the plugin over a minimal fake Cordis context.
 *
 * @param options - config overrides for the poll budget.
 * @returns the registered tools, the compaction mock, the log sinks, and a disposer.
 */
function createHarness(options: HarnessOptions = {}): Harness {
  const tools: ToolDefinition[] = []
  const info: string[] = []
  const warnings: string[] = []
  const disposers: (() => void)[] = []
  const compactNow = vi.fn<(...args: [Agent, AbortSignal]) => Promise<FakeCompactResult | null>>(
    async () => null,
  )

  const ctx = {
    tools: {
      register: (definition: ToolDefinition) => {
        tools.push(definition)
        return () => undefined
      },
    },
    compaction: { compactNow },
    logger: {
      info: (format: string) => {
        info.push(format)
      },
      warn: (format: string) => {
        warnings.push(format)
      },
      error: () => undefined,
      debug: () => undefined,
    },
    effect: (execute: () => () => void) => {
      disposers.push(execute())
      return () => undefined
    },
  } as unknown as Context

  apply(ctx, {
    pollIntervalMs: options.pollIntervalMs ?? POLL_MS,
    maxWaitMs: options.maxWaitMs ?? MAX_WAIT_MS,
    maxAttempts: options.maxAttempts ?? MAX_ATTEMPTS,
  })

  const tool = tools[0]
  if (tool === undefined) throw new Error('apply registered no tool')
  const harness: Harness = {
    tools,
    compactNow,
    info,
    warnings,
    tool,
    dispose: () => {
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
  harnesses.push(harness)
  return harness
}

/** A real Session-backed Agent whose `status` the test flips between turns. */
function makeAgent(status: 'idle' | 'running'): TestAgent {
  return new TestAgent('session-compact', 'kinship', status)
}

/** Invoke the tool body the way the executor does, with only what it reads. */
async function callTool(tool: ToolDefinition, agent: Agent | undefined): Promise<CompactContextOutcome> {
  const exec = {
    agent,
    signal: new AbortController().signal,
    deferContext: () => undefined,
    concludeTurn: () => undefined,
  } as unknown as ToolRunContext
  return await tool.execute({}, exec) as CompactContextOutcome
}

/** Project one canonical outcome to its model-facing text. */
function contentText(tool: ToolDefinition, value: CompactContextOutcome): string {
  const render = tool.output.render
  const blocks = render({}, value as unknown as Parameters<typeof render>[1])
  return blocks.map(block => (block.type === 'text' ? block.text : '')).join('')
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  while (harnesses.length > 0) harnesses.pop()?.dispose()
  vi.useRealTimers()
})

describe('kinship-compact plugin surface', () => {
  it('declares the stable plugin identity and injects the tool and compaction seams', () => {
    expect(name).toBe('kinship-compact')
    expect(inject).toEqual(['tools', 'compaction'])
    expect(Config).toBeDefined()
  })

  it('registers exactly one tool named compact_context with no parameters', () => {
    const harness = createHarness()
    expect(harness.tools.map(tool => tool.name)).toEqual(['compact_context'])
    expect(harness.tool.parameters).toEqual({ type: 'object', properties: {} })
  })

  it('refuses a call with no owning agent session', async () => {
    const harness = createHarness()
    await expect(callTool(harness.tool, undefined)).rejects.toThrow(
      'compact_context requires an owning agent session',
    )
    expect(harness.compactNow).not.toHaveBeenCalled()
  })
})

describe('compact_context on an idle agent', () => {
  it('compacts immediately and reports the shadowed item count', async () => {
    const harness = createHarness()
    harness.compactNow.mockResolvedValue({ shadowedSeqs: [1, 2, 3], shadowedTokenCount: 300 })
    const agent = makeAgent('idle')

    const value = await callTool(harness.tool, agent)

    expect(value).toEqual({ status: 'finished', items: 3 })
    expect(contentText(harness.tool, value)).toBe('Compaction finished (~3 history items).')
    expect(harness.compactNow).toHaveBeenCalledTimes(1)
    expect(harness.compactNow.mock.calls[0]?.[0]).toBe(agent)
    // Nothing is pending, so no poll is armed and the clock cannot compact twice.
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(POLL_MS * 5)
    expect(harness.compactNow).toHaveBeenCalledTimes(1)
  })

  it('reports an empty history honestly and leaves nothing pending', async () => {
    const harness = createHarness()
    harness.compactNow.mockResolvedValue(null)

    const value = await callTool(harness.tool, makeAgent('idle'))

    expect(value).toEqual({ status: 'empty', items: 0 })
    expect(contentText(harness.tool, value)).toBe('No compactable history yet.')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('defers instead of failing when the agent starts a turn before the call', async () => {
    const harness = createHarness()
    harness.compactNow.mockRejectedValueOnce(new ManualCompactionError('busy', 'agent is active'))
    const agent = makeAgent('idle')

    const value = await callTool(harness.tool, agent)

    expect(value).toEqual({ status: 'scheduled', items: 0 })
    expect(harness.warnings).toEqual([])
    expect(vi.getTimerCount()).toBe(1)
  })

  it('surfaces a non-busy compaction failure to the model', async () => {
    const harness = createHarness()
    harness.compactNow.mockRejectedValue(new ManualCompactionError('summary', 'no useful summary'))

    await expect(callTool(harness.tool, makeAgent('idle'))).rejects.toThrow('no useful summary')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('compact_context on a running agent', () => {
  it('schedules the request and compacts once the agent is idle', async () => {
    const harness = createHarness()
    harness.compactNow.mockResolvedValue({ shadowedSeqs: [4, 5], shadowedTokenCount: 80 })
    const agent = makeAgent('running')

    const value = await callTool(harness.tool, agent)

    expect(value).toEqual({ status: 'scheduled', items: 0 })
    expect(contentText(harness.tool, value)).toBe(
      'Compaction scheduled: it runs when this turn ends.',
    )
    expect(harness.compactNow).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)

    // Still running: a tick must not touch the compaction engine.
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(harness.compactNow).not.toHaveBeenCalled()

    agent.status = 'idle'
    await vi.advanceTimersByTimeAsync(POLL_MS)

    expect(harness.compactNow).toHaveBeenCalledTimes(1)
    expect(harness.compactNow.mock.calls[0]?.[0]).toBe(agent)
    expect(harness.info.some(line => line.includes('compacted session session-compact: 2 history items'))).toBe(true)
    // Settled: no later tick may compact the same request again.
    await vi.advanceTimersByTimeAsync(POLL_MS * 5)
    expect(harness.compactNow).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries a busy compaction on later ticks', async () => {
    const harness = createHarness()
    harness.compactNow
      .mockRejectedValueOnce(new ManualCompactionError('busy', 'compaction already running'))
      .mockResolvedValue({ shadowedSeqs: [7], shadowedTokenCount: 70 })
    const agent = makeAgent('running')

    await callTool(harness.tool, agent)
    agent.status = 'idle'

    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(harness.compactNow).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(harness.compactNow).toHaveBeenCalledTimes(2)
    expect(harness.warnings).toEqual([])

    await vi.advanceTimersByTimeAsync(POLL_MS * 5)
    expect(harness.compactNow).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives up after maxAttempts busy outcomes', async () => {
    const harness = createHarness({ maxAttempts: 2 })
    harness.compactNow.mockRejectedValue(new ManualCompactionError('busy', 'compaction already running'))
    const agent = makeAgent('running')

    await callTool(harness.tool, agent)
    agent.status = 'idle'
    await vi.advanceTimersByTimeAsync(POLL_MS * 2)

    expect(harness.compactNow).toHaveBeenCalledTimes(2)
    expect(harness.warnings).toHaveLength(1)
    expect(harness.warnings[0]).toContain('gave up on the compaction scheduled for session session-compact')

    await vi.advanceTimersByTimeAsync(POLL_MS * 5)
    expect(harness.compactNow).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drops the request and warns once after a non-busy error', async () => {
    const harness = createHarness()
    harness.compactNow.mockRejectedValue(new ManualCompactionError('summary', 'no useful summary'))
    const agent = makeAgent('running')

    await callTool(harness.tool, agent)
    agent.status = 'idle'
    await vi.advanceTimersByTimeAsync(POLL_MS)

    expect(harness.compactNow).toHaveBeenCalledTimes(1)
    expect(harness.warnings).toHaveLength(1)
    expect(harness.warnings[0]).toContain('compaction for session session-compact failed: no useful summary')

    await vi.advanceTimersByTimeAsync(POLL_MS * 5)
    expect(harness.compactNow).toHaveBeenCalledTimes(1)
    expect(harness.warnings).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drops the request after maxWaitMs without ever compacting', async () => {
    const harness = createHarness({ pollIntervalMs: 10, maxWaitMs: 25 })
    const agent = makeAgent('running')

    await callTool(harness.tool, agent)
    await vi.advanceTimersByTimeAsync(30)

    expect(harness.compactNow).not.toHaveBeenCalled()
    expect(harness.warnings).toHaveLength(1)
    expect(harness.warnings[0]).toContain('dropped the compaction scheduled for session session-compact')

    agent.status = 'idle'
    await vi.advanceTimersByTimeAsync(POLL_MS * 5)
    expect(harness.compactNow).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('replaces a previous pending request instead of compacting twice', async () => {
    const harness = createHarness()
    harness.compactNow.mockResolvedValue({ shadowedSeqs: [9], shadowedTokenCount: 90 })
    const agent = makeAgent('running')

    await callTool(harness.tool, agent)
    const second = await callTool(harness.tool, agent)

    expect(second).toEqual({ status: 'scheduled', items: 0 })
    // One shared poll for the single pending entry.
    expect(vi.getTimerCount()).toBe(1)

    agent.status = 'idle'
    await vi.advanceTimersByTimeAsync(POLL_MS)

    expect(harness.compactNow).toHaveBeenCalledTimes(1)
  })

  it('clears the timer and the pending request on dispose', async () => {
    const harness = createHarness()
    const agent = makeAgent('running')

    await callTool(harness.tool, agent)
    expect(vi.getTimerCount()).toBe(1)

    harness.dispose()
    expect(vi.getTimerCount()).toBe(0)

    agent.status = 'idle'
    await vi.advanceTimersByTimeAsync(POLL_MS * 5)
    expect(harness.compactNow).not.toHaveBeenCalled()
  })
})
