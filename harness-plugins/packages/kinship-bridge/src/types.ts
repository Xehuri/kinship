/**
 * Narrow, Cordis-free types shared by the bridge server, the binding store,
 * and the host adapter. The HTTP layer never imports a dsh service directly.
 *
 * @module kinship-bridge/types
 */

/** How the bridge chooses its single bound Session. */
export type BindingPolicy = 'first' | 'manual'

/** Binding lifecycle as reported by `GET /v1/health` and `GET /v1/session`. */
export type BindingStatus = 'unbound' | 'bound' | 'bound_session_missing'

/** Live agent lifecycle, mirrored from `Agent.status`. */
export type AgentStatus = 'idle' | 'running'

/** One live Session as the bridge sees it. */
export interface SessionInfo {
  readonly id: string
  /** Durable creation time in epoch milliseconds. */
  readonly createdAt: number
  /** Current agent preset id, or null when the Session runs preset-free. */
  readonly preset: string | null
  /** Root Session definition: no parent and not a subagent child. */
  readonly isRoot: boolean
  readonly status: AgentStatus
}

/** One committed Session event in a JSON-safe projection. */
export interface BridgeEvent {
  readonly seq: number
  readonly type: string
  /** Epoch milliseconds. */
  readonly time: number
  /** Event payload (`SessionEvent.data`). */
  readonly data: unknown
}

/** One subagent catalog row, projected for the HTTP contract. */
export interface ChildRow {
  readonly id: string
  readonly parent_id: string
  readonly depth: number
  readonly kind: 'child' | 'diagnostic'
  readonly mode?: string
  readonly name?: string
  readonly label?: string
  readonly path?: string
  readonly activity?: 'running' | 'inactive'
  readonly has_children?: boolean
  readonly reason?: string
  readonly created_at?: number
}

/** Source carried by a bridge-injected user message. */
export type BridgeMessageSource =
  | {
    readonly kind: 'bridge'
    /** Optional caller label from `POST /v1/session/messages`. */
    readonly source?: string
  }
  | {
    readonly kind: 'inbox'
    /** Inbox class (`interrupt`, `notify`, `digest`, ...). */
    readonly class: string
    /** Optional thread identity from `POST /v1/inbox`. */
    readonly threadId?: string
  }

/** Operations the HTTP server needs from one live Session. */
export interface BridgeSession {
  info(): SessionInfo
  /**
   * Deliver one user message. `target` selects the dsh inbox boundary.
   * @returns the created message id.
   */
  send(text: string, source: BridgeMessageSource | undefined, target: 'next-turn' | 'next-step'): string
  /** Abort the active turn; a no-op when the agent is idle. */
  abort(): { readonly wasRunning: boolean }
  /** Full committed event log, oldest first. */
  events(): readonly BridgeEvent[]
  /** Durable subagent descendants, if the host exposes the subagent service. */
  children(signal?: AbortSignal): Promise<readonly ChildRow[]>
}

/** One live (non-durable) assistant stream publication, projected for SSE. */
export interface BridgeLiveEvent {
  /** Stable extra event type appended to the contract's event stream. */
  readonly type: 'kinship/assistant-stream'
  /** `{session_id, frame}`; `frame` carries `turn`/`step` for chunk and end frames. */
  readonly data: unknown
}

/** One provider row from the harness model catalog. */
export interface ModelProviderRow {
  readonly id: string
  readonly name: string
  readonly models: readonly { readonly id: string; readonly name: string }[]
}

/** Live model route and context occupancy for the bound Session. */
export interface SessionContextRow {
  readonly provider: string | null
  readonly model: string | null
  readonly contextWindow: number | null
  readonly usedTokens: number | null
  readonly projectedTokens: number | null
}

/** Durable compaction snapshot derived from the Session event log. */
export interface CompactionSnapshot {
  readonly status: 'none' | 'active'
  readonly covered_count: number
  readonly summary_text: string
  readonly anchor_message_id: string | null
  readonly anchor_timestamp_ms: number | null
}

/** The only host surface the HTTP server needs. */
export interface BridgeHost {
  listSessions(): readonly SessionInfo[]
  getSession(id: string): BridgeSession | undefined
  /** Subscribe to committed Session events; returns an unsubscribe function. */
  subscribe(listener: (sessionId: string, event: BridgeEvent) => void): () => void
  /**
   * Subscribe to live assistant stream publications. These never enter the
   * durable log; an implementation may omit this when the harness has no live
   * stream (the server then only forwards durable events).
   */
  subscribeLive?(listener: (sessionId: string, event: BridgeLiveEvent) => void): () => void
  /** Harness model catalog; empty providers when the harness exposes none. */
  models?(): Promise<readonly ModelProviderRow[]>
  /** Current model route and context occupancy, or null when unavailable. */
  context?(sessionId: string): SessionContextRow | null
  /** Compact the bound idle Session; `accepted` returns before the summary settles. */
  compact?(sessionId: string): { readonly status: 'accepted' | 'busy' | 'unavailable' }
  /** Latest durable compaction, or null when the Session has none. */
  compaction?(sessionId: string): CompactionSnapshot | null
}

/** Current binding state. */
export interface BindingSnapshot {
  readonly status: BindingStatus
  readonly sessionId: string | null
  readonly boundAt: number | null
  readonly policy: BindingPolicy
}

/** Binding operations used by the HTTP server and plugin startup. */
export interface BindingController {
  snapshot(): BindingSnapshot
  /** Bound Session id, or null when unbound. A missing bound Session still returns its id. */
  currentSessionId(): string | null
  /** Validate and switch the binding atomically. */
  bind(sessionId: string, host: BridgeHost): BindingSnapshot
  /** Re-evaluate the persisted binding against the live host. */
  reconcile(host: BridgeHost): BindingSnapshot
  /** Notify after a binding transition; returns an unsubscribe function. */
  onChange(listener: () => void): () => void
}

/** Minimal logging surface; the plugin passes `ctx.logger`. */
export interface BridgeLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** Options for one bridge HTTP server. */
export interface BridgeServerOptions {
  readonly host: BridgeHost
  readonly binding: BindingController
  readonly token: string
  readonly hostname: string
  readonly port: number
  readonly version: string
  readonly dshVersion: string
  readonly bodyLimitBytes: number
  readonly logger?: BridgeLogger
}

/** Running bridge server handle. */
export interface BridgeServerHandle {
  /** Bound port (resolved when `port: 0` was requested). */
  port(): number
  /** Stop accepting requests and settle after open connections close. */
  close(): Promise<void>
}
