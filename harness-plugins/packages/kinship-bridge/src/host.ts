/**
 * Cordis adapter for the bridge's narrow host surface.
 *
 * The bridge binds exactly one live root dsh Session whose agent preset is
 * `kinship`. This module is the only place that reads `ctx.agents`,
 * `ctx.agentPresets`, `ctx.subagents`, or session events.
 *
 * @module kinship-bridge/host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { subagentsUnavailable } from './errors.js'
import type {
  BridgeEvent,
  BridgeHost,
  BridgeLiveEvent,
  BridgeMessageSource,
  BridgeSession,
  ChildRow,
  CompactionSnapshot,
  ModelProviderRow,
  SessionCatalogRow,
  SessionContextRow,
  SessionInfo,
} from './types.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A message injected by the local Kinship bridge. */
    'kinship:bridge': {
      readonly kind: 'kinship:bridge'
      /** Optional caller label carried from the HTTP request. */
      readonly source?: string
    }
    /** A queued inbox delivery from the Kinship bridge. */
    'kinship:inbox': {
      readonly kind: 'kinship:inbox'
      /** Inbox class (`interrupt`, `notify`, `digest`, ...). */
      readonly class: string
      /** Optional conversation/thread identity. */
      readonly threadId?: string
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Concatenate the text blocks of a ContentBlock[] payload. */
function contentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const block of value) {
    if (!isRecord(block)) continue
    const text = block['text']
    if (typeof text === 'string' && text !== '') parts.push(text)
  }
  return parts.join('\n')
}

function eventOf(event: SessionEvent): BridgeEvent {
  return {
    seq: Number(event.seq),
    type: event.type,
    time: event.time,
    data: event.data,
  }
}

function presetOf(ctx: Context, agent: Agent): string | null {
  const registry = ctx.get('agentPresets')
  const composed = registry?.presetForSession(agent.session) ?? null
  return composed ?? agent.session.header.agentPreset ?? null
}

function infoOf(ctx: Context, agent: Agent): SessionInfo {
  const header = agent.session.header
  return {
    id: String(agent.session.id),
    createdAt: header.createdAt,
    preset: presetOf(ctx, agent),
    isRoot: header.parentSession === undefined && header.origin !== 'subagent',
    status: agent.status,
  }
}

function projectChild(entry: SubagentDescendantListEntry): ChildRow {
  const base = {
    id: String(entry.id),
    parent_id: String(entry.parentId),
    depth: entry.depth,
    ...(entry.path === undefined ? {} : { path: entry.path }),
  }
  if (entry.kind === 'diagnostic') {
    return { ...base, kind: 'diagnostic', reason: entry.reason }
  }
  return {
    ...base,
    kind: 'child',
    mode: entry.mode,
    activity: entry.activity,
    has_children: entry.hasChildren,
    ...('name' in entry && entry.name !== undefined ? { name: entry.name } : {}),
    ...('label' in entry && entry.label !== undefined ? { label: entry.label } : {}),
  }
}

function messageSourceOf(source: BridgeMessageSource | undefined): {
  readonly kind: 'kinship:bridge'
  readonly source?: string
} | {
  readonly kind: 'kinship:inbox'
  readonly class: string
  readonly threadId?: string
} {
  if (source === undefined) return { kind: 'kinship:bridge' }
  if (source.kind === 'bridge') {
    return {
      kind: 'kinship:bridge',
      ...(source.source === undefined || source.source.trim() === '' ? {} : { source: source.source }),
    }
  }
  return {
    kind: 'kinship:inbox',
    class: source.class,
    ...(source.threadId === undefined || source.threadId.trim() === '' ? {} : { threadId: source.threadId }),
  }
}

/** One live dsh agent exposed through the bridge contract. */
class CordisBridgeSession implements BridgeSession {
  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
  ) {}

  info(): SessionInfo {
    return infoOf(this.ctx, this.agent)
  }

  send(text: string, source: BridgeMessageSource | undefined, target: 'next-turn' | 'next-step'): string {
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: messageSourceOf(source),
    })
    this.agent.send(message, target, true)
    return String(message.id)
  }

  abort(): { readonly wasRunning: boolean } {
    const wasRunning = this.agent.status === 'running'
    this.agent.cancel({ kind: 'user' }, { keepInbox: false })
    return { wasRunning }
  }

  events(): readonly BridgeEvent[] {
    // Deprecated synchronous reader: the bridge exposes a best-effort read
    // surface and does not own a persisted Session observation handle.
    return this.agent.session.snapshotEvents().map(eventOf)
  }

  async children(signal?: AbortSignal): Promise<readonly ChildRow[]> {
    const subagents = this.ctx.get('subagents')
    if (subagents === undefined) throw subagentsUnavailable()
    const entries = await subagents.listDescendants(
      this.agent.session.id,
      signal,
    )
    return entries.map(projectChild)
  }
}

/** Cordis-backed host used by the plugin and the HTTP server. */
class CordisBridgeHost implements BridgeHost {
  constructor(private readonly ctx: Context) {}

  listSessions(): readonly SessionInfo[] {
    return this.ctx.agents.list().map(agent => infoOf(this.ctx, agent))
  }

  /**
   * Live Sessions plus the copy the dsh panel shows.
   *
   * The title is folded state owned by the session-title service, so a profile
   * without that service reports `null` instead of failing the whole catalog.
   */
  catalog(): readonly SessionCatalogRow[] {
    const titles = this.ctx.get('sessionTitle')
    return this.ctx.agents.list().map((agent) => {
      const info = infoOf(this.ctx, agent)
      let title: string | null = null
      if (titles !== undefined) {
        try {
          title = titles.get(agent.session)?.title ?? null
        } catch {
          title = null
        }
      }
      return { ...info, title, cwd: agent.session.header.cwd ?? null }
    })
  }

  getSession(id: string): BridgeSession | undefined {
    const agent = this.ctx.agents.get(SessionId(id))
    return agent === undefined ? undefined : new CordisBridgeSession(this.ctx, agent)
  }

  subscribe(listener: (sessionId: string, event: BridgeEvent) => void): () => void {
    const dispose = this.ctx.on('session/event', (session, event) => {
      listener(String(session.id), eventOf(event))
    })
    return () => {
      dispose()
    }
  }

  /**
   * Forward live assistant stream publications.
   *
   * `agent/assistant-stream` is a process-local emit event, so these frames
   * never reach the durable log and are absent from `snapshotEvents()`. The
   * `start` frame names the turn and step; later frames of the same attempt
   * omit them, so the bridge remembers the attempt metadata and stamps it back
   * onto every forwarded frame to keep the wire shape uniform.
   */
  subscribeLive(listener: (sessionId: string, event: BridgeLiveEvent) => void): () => void {
    const attempts = new Map<string, { readonly turn: number; readonly step: number }>()
    const dispose = this.ctx.on('agent/assistant-stream', (payload) => {
      const sessionId = String(payload.agent.session.id)
      const frame = payload.frame
      let attempt: { readonly turn: number; readonly step: number } | undefined
      if (frame.type === 'start') {
        attempt = { turn: frame.turn, step: frame.step }
        attempts.set(String(frame.attemptId), attempt)
      } else {
        attempt = attempts.get(String(frame.attemptId))
        if (frame.type === 'end') attempts.delete(String(frame.attemptId))
      }
      const data = {
        session_id: sessionId,
        frame: attempt === undefined ? frame : { ...frame, turn: attempt.turn, step: attempt.step },
      }
      listener(sessionId, { type: 'kinship/assistant-stream', data })
    }, { global: true })
    return () => {
      dispose()
    }
  }

  private agentOf(sessionId: string): Agent | undefined {
    return this.ctx.agents.get(SessionId(sessionId))
  }

  async models(): Promise<readonly ModelProviderRow[]> {
    const llm = this.ctx.get('llm')
    if (llm === undefined) return []
    const rows: ModelProviderRow[] = []
    for (const provider of llm.listProviders()) {
      try {
        const models = await llm.listModels(provider.id)
        rows.push({
          id: provider.id,
          name: provider.name,
          models: models.map(model => ({ id: model.id, name: model.name })),
        })
      } catch {
        rows.push({ id: provider.id, name: provider.name, models: [] })
      }
    }
    return rows
  }

  context(sessionId: string): SessionContextRow | null {
    const agent = this.agentOf(sessionId)
    if (agent === undefined) return null
    const route = agent.session.requestContext()
    const meter = this.ctx.get('tokenMeter')
    let pressure: { readonly pressureTokens?: number, readonly projectedTokens?: number, readonly contextWindow?: number } | undefined
    if (meter !== undefined) {
      try {
        pressure = meter.contextPressure(agent.session)
      } catch {
        pressure = undefined
      }
    }
    return {
      provider: route?.provider ?? null,
      model: route?.model ?? null,
      contextWindow: route?.contextWindow ?? pressure?.contextWindow ?? null,
      usedTokens: pressure?.pressureTokens ?? null,
      projectedTokens: pressure?.projectedTokens ?? null,
    }
  }

  compact(sessionId: string): { readonly status: 'accepted' | 'busy' | 'unavailable' } {
    const agent = this.agentOf(sessionId)
    if (agent === undefined) return { status: 'unavailable' }
    const commands = this.ctx.get('commands')
    if (commands === undefined) return { status: 'unavailable' }
    if (agent.status === 'running') return { status: 'busy' }
    // The command result is durable (command/run, command/done, compaction/*);
    // the HTTP call only reports acceptance, so it never blocks on the summary.
    void commands.execute(agent, '/compact', [], new AbortController().signal).then((result) => {
      if (result === undefined) {
        this.ctx.logger.warn('kinship-bridge: /compact is not registered in this harness composition')
      }
    }).catch((error: unknown) => {
      this.ctx.logger.warn(
        'kinship-bridge: manual compaction failed: %s',
        error instanceof Error ? error.message : String(error),
      )
    })
    return { status: 'accepted' }
  }

  compaction(sessionId: string): CompactionSnapshot | null {
    const agent = this.agentOf(sessionId)
    if (agent === undefined) return null
    const open = new Set<string>()
    let summary: Record<string, unknown> | undefined
    let summaryTime = 0
    let anchorId: string | null = null
    let anchorTime: number | null = null
    for (const event of agent.session.snapshotEvents()) {
      if (event.type === 'compaction/start' && isRecord(event.data)) {
        const id = event.data['compactionId']
        if (typeof id === 'string' && id !== '') open.add(id)
      } else if (event.type === 'compaction/end' && isRecord(event.data)) {
        const id = event.data['compactionId']
        if (typeof id === 'string') open.delete(id)
      } else if (event.type === 'compaction/summary' && isRecord(event.data)) {
        summary = event.data
        summaryTime = event.time
        anchorId = null
        anchorTime = null
      } else if (event.type === 'user/message' && summary !== undefined && anchorId === null && isRecord(event.data)) {
        const id = event.data['id']
        if (typeof id === 'string' && id !== '') {
          anchorId = id
          anchorTime = event.time
        }
      }
    }
    if (summary === undefined) return null
    const shadowed = Array.isArray(summary['shadowedSeqs']) ? summary['shadowedSeqs'] : []
    // `status` follows the Kinship W51A contract: `active` means a compaction
    // boundary exists in the history, not that a compaction is still running.
    // The durable lock state (`open`) is exposed separately.
    return {
      status: 'active',
      covered_count: shadowed.length,
      summary_text: contentText(summary['summary']),
      anchor_message_id: anchorId,
      anchor_timestamp_ms: anchorTime ?? (summaryTime > 0 ? summaryTime : null),
      running: open.size > 0,
    }
  }
}

/** Build the bridge host from a Cordis context. */
export function createCordisHost(ctx: Context): BridgeHost {
  return new CordisBridgeHost(ctx)
}
