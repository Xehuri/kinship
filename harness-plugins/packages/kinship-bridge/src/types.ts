/**
 * Narrow, Cordis-free types shared by the bridge server, the binding store,
 * and the host adapter. The HTTP layer never imports a dsh service directly.
 *
 * @module kinship-bridge/types
 */

import type { PushedPaths, StoredPaths } from './paths.js'
import type { PushedToolAuth, ToolAuthView } from './tool-auth.js'

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

/**
 * One live Kinship Session with the presentation fields the dsh panel shows.
 *
 * `SessionInfo` is the durable bridge contract and carries no copy, so the
 * panel projection adds the folded title and the creation cwd separately.
 */
export interface SessionCatalogRow extends SessionInfo {
  readonly title: string | null
  readonly cwd: string | null
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

/**
 * Outcome of turning one persisted Session back into a live agent.
 *
 * `missing` means the host answered that the Session does not exist (or is no
 * longer an acceptable root kinship Session); `unavailable` means this
 * composition has no way to resume it at all.
 */
export type ResumeResult =
  | { readonly status: 'resumed'; readonly session: BridgeSession }
  | { readonly status: 'missing' }
  | { readonly status: 'unavailable'; readonly reason: string }

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
  /** `active` means a compaction boundary exists in the history (W51A contract). */
  readonly status: 'none' | 'active'
  readonly covered_count: number
  readonly summary_text: string
  readonly anchor_message_id: string | null
  readonly anchor_timestamp_ms: number | null
  /** True while a compaction transaction is still open. */
  readonly running?: boolean
}

/*
 * 排异（isolation）契约。
 *
 * preset 级插件 `kinship-isolation` 在 kinship preset 作用域里遮蔽 host 的
 * 提示词段、并按工具名前缀限制 host 工具调用，然后把执行结果通过桥接的 host
 * 服务上报给面板。下面的字段名是跨插件共享契约，改动前必须同步
 * `packages/kinship-isolation`。
 */

/** 一条提示词段的遮蔽结果。 */
export interface IsolationSectionReport {
  /** 段名，与 host 级插件注册的段同名。 */
  readonly name: string
  /** 已注册同名空段（能遮蔽 host 的同名段）。 */
  readonly shadowed: boolean
}

/** 一个工具名前缀的限制结果。 */
export interface IsolationToolsReport {
  /** 例如 "memory_" */
  readonly prefix: string
  /** 已经被 restrict 隐藏的工具名。 */
  readonly denied: readonly string[]
  /** 配置了前缀但当前注册表里还没有匹配工具。 */
  readonly pending: boolean
}

/**
 * 一份排异状态快照。
 *
 * 它只存在 bridge 进程的内存里：不落盘、不写日志，harness 重启后由
 * kinship-isolation 重新上报。
 */
export interface IsolationReport {
  /** 线上 schema 版本，当前固定为 1。 */
  readonly schema: 1
  /** 每次插件实例激活生成的随机 id，用于卸载时只清除自己的报告。 */
  readonly instance: string
  /** 排异规则是否已生效。 */
  readonly active: boolean
  /** 例如 "kinship" */
  readonly preset: string
  /** epoch 毫秒 */
  readonly updatedAt: number
  readonly sections: readonly IsolationSectionReport[]
  readonly tools: readonly IsolationToolsReport[]
  /** 限制失败等错误，旧的在前面。 */
  readonly errors: readonly string[]
}

/** The only host surface the HTTP server needs. */
export interface BridgeHost {
  listSessions(): readonly SessionInfo[]
  /**
   * Live Sessions with their folded title and cwd, for the dsh panel.
   * Absent when the harness exposes no title service.
   */
  catalog?(): readonly SessionCatalogRow[]
  getSession(id: string): BridgeSession | undefined
  /**
   * Turn a persisted Session back into a live agent.
   *
   * A harness restart empties the live agent registry while the durable
   * binding still points at the last Kinship Session; resuming is what makes
   * that Session usable again. The capability is optional: when it is absent,
   * this composition has no way to rehydrate a Session and callers keep the
   * `bound_session_missing` contract.
   */
  resume?(sessionId: string): Promise<ResumeResult>
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
  /**
   * Last accepted paths document, or null before the first push.
   *
   * Optional because the transport is also constructed by compositions (and
   * transport tests) that mount no durable paths store; the routes then answer
   * 404 on GET and 503 on POST instead of pretending to persist anything.
   */
  readonly paths?: () => StoredPaths | null
  /** Persist one validated push and return the durable record. */
  readonly savePaths?: (input: PushedPaths) => StoredPaths
  /**
   * Current tool-auth projection, or null before the backend pushes it.
   *
   * Optional for the same reason as `paths`: transport tests and compositions
   * without the memory store answer the unconfigured view instead of pretending
   * a backend was ever pushed.
   */
  readonly toolAuth?: () => ToolAuthView | null
  /** Remember one validated tool-auth push and return its token-free view. */
  readonly saveToolAuth?: (input: PushedToolAuth) => ToolAuthView
}

/** Running bridge server handle. */
export interface BridgeServerHandle {
  /** Bound port (resolved when `port: 0` was requested). */
  port(): number
  /**
   * Replace the accepted bearer token without reopening the listener.
   * Open connections keep running; the next request must present the new token.
   */
  setToken(token: string): void
  /** Stop accepting requests and settle after open connections close. */
  close(): Promise<void>
}
