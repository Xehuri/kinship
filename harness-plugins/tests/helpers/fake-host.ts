import type {
  BridgeEvent,
  BridgeHost,
  BridgeLiveEvent,
  BridgeMessageSource,
  BridgeSession,
  ChildRow,
  CompactionSnapshot,
  ModelProviderRow,
  ResumeResult,
  SessionContextRow,
  SessionInfo,
} from '../../packages/kinship-bridge/src/types.js'

export interface SentBridgeMessage {
  readonly text: string
  readonly source: BridgeMessageSource | undefined
  readonly target: 'next-turn' | 'next-step'
}

export class FakeBridgeSession implements BridgeSession {
  private readonly infoValue: Omit<SessionInfo, 'status'>
  private statusValue: 'idle' | 'running'
  private eventsValue: BridgeEvent[]
  private childrenValue: readonly ChildRow[]
  readonly sent: SentBridgeMessage[] = []
  aborted = 0

  constructor(
    info: SessionInfo,
    events: readonly BridgeEvent[] = [],
    children: readonly ChildRow[] = [],
  ) {
    const { status, ...rest } = info
    this.infoValue = rest
    this.statusValue = status
    this.eventsValue = [...events]
    this.childrenValue = children
  }

  info(): SessionInfo {
    return { ...this.infoValue, status: this.statusValue }
  }

  send(text: string, source: BridgeMessageSource | undefined, target: 'next-turn' | 'next-step'): string {
    this.sent.push({ text, source, target })
    return `message-${String(this.sent.length)}`
  }

  abort(): { readonly wasRunning: boolean } {
    const wasRunning = this.statusValue === 'running'
    this.aborted += 1
    this.setStatus('idle')
    return { wasRunning }
  }

  events(): readonly BridgeEvent[] {
    return this.eventsValue
  }

  async children(): Promise<readonly ChildRow[]> {
    return this.childrenValue
  }

  setStatus(status: 'idle' | 'running'): void {
    this.statusValue = status
  }

  setEvents(events: readonly BridgeEvent[]): void {
    this.eventsValue = [...events]
  }
}

export class FakeHost implements BridgeHost {
  private readonly sessions = new Map<string, BridgeSession>()
  private readonly listeners = new Set<(sessionId: string, event: BridgeEvent) => void>()
  private readonly liveListeners = new Set<(sessionId: string, event: BridgeLiveEvent) => void>()
  modelRows: readonly ModelProviderRow[] = [
    { id: 'test', name: 'Test Provider', models: [{ id: 'm1', name: 'Model One' }] },
  ]
  contextRow: SessionContextRow | null = {
    provider: 'test', model: 'm1', contextWindow: 128_000, usedTokens: 1_024, projectedTokens: 1_100,
  }
  compactStatus: 'accepted' | 'busy' | 'unavailable' = 'accepted'
  compactionRow: CompactionSnapshot | null = null

  add(session: BridgeSession): void {
    this.sessions.set(session.info().id, session)
  }

  remove(id: string): void {
    this.sessions.delete(id)
  }

  listSessions(): readonly SessionInfo[] {
    return [...this.sessions.values()].map(session => session.info())
  }

  getSession(id: string): BridgeSession | undefined {
    return this.sessions.get(id)
  }

  subscribe(listener: (sessionId: string, event: BridgeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  subscribeLive(listener: (sessionId: string, event: BridgeLiveEvent) => void): () => void {
    this.liveListeners.add(listener)
    return () => {
      this.liveListeners.delete(listener)
    }
  }

  emit(sessionId: string, event: BridgeEvent): void {
    for (const listener of [...this.listeners]) listener(sessionId, event)
  }

  emitLive(sessionId: string, event: BridgeLiveEvent): void {
    for (const listener of [...this.liveListeners]) listener(sessionId, event)
  }

  async models(): Promise<readonly ModelProviderRow[]> {
    return this.modelRows
  }

  context(): SessionContextRow | null {
    return this.contextRow
  }

  compact(): { readonly status: 'accepted' | 'busy' | 'unavailable' } {
    return { status: this.compactStatus }
  }

  compaction(): CompactionSnapshot | null {
    return this.compactionRow
  }
}

/** A host whose resume capability is scripted by the test. */
export class ResumableFakeHost extends FakeHost {
  readonly resumeRequests: string[] = []
  /** Scripted outcome; defaults to `missing` so an unscripted resume is visible. */
  resumeHandler: (sessionId: string) => Promise<ResumeResult> = async () => ({ status: 'missing' })

  async resume(sessionId: string): Promise<ResumeResult> {
    this.resumeRequests.push(sessionId)
    return this.resumeHandler(sessionId)
  }
}

export function sessionInfo(
  id: string,
  options: Partial<Omit<SessionInfo, 'id'>> = {},
): SessionInfo {
  return {
    id,
    createdAt: options.createdAt ?? 1,
    preset: options.preset === undefined ? 'kinship' : options.preset,
    isRoot: options.isRoot ?? true,
    status: options.status ?? 'idle',
  }
}

export function bridgeEvent(seq: number, type: string, data: unknown, time = 1_000 + seq): BridgeEvent {
  return { seq, type, time, data }
}
