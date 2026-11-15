/**
 * One persisted Kinship Session binding.
 *
 * Policy:
 * - `first`: the earliest-created live root Session whose preset is `kinship`.
 * - `manual`: no automatic selection; `POST /v1/session/bind` switches it.
 *
 * The binding is written to `$DSH_HOME/kinship/binding.json` with a same-dir
 * temp + fsync + rename so a reader never sees a half-written file.
 *
 * @module kinship-bridge/binding
 */

// allow: SIZE_OK — persistence and policy share one atomic transition; splitting the file would expose a half-switched binding.

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import {
  BridgeError,
  notKinshipSession,
  notRootSession,
  sessionNotFound,
} from './errors.js'
import type {
  BindingController,
  BindingPolicy,
  BindingSnapshot,
  BridgeHost,
  BridgeLogger,
  BridgeSession,
  SessionInfo,
} from './types.js'

/** Persisted binding file schema version. */
export const BINDING_SCHEMA = 1

/** Options for one binding store. */
export interface BindingStoreOptions {
  /** Absolute `binding.json` path. */
  readonly path: string
  readonly policy: BindingPolicy
  /** Optional configured Session id, used by `manual` startup. */
  readonly sessionId: string
  /** Re-select the first Kinship Session when the bound one disappears. */
  readonly rebindOnMissing: boolean
  readonly logger?: BridgeLogger
  readonly now?: () => number
}

interface BindingState {
  readonly sessionId: string
  readonly boundAt: number
}

interface PersistedBinding {
  readonly schema: typeof BINDING_SCHEMA
  readonly session_id: string
  readonly preset: 'kinship'
  readonly bound_at: number
  readonly policy: BindingPolicy
}

let tmpSequence = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPolicy(value: unknown): value is BindingPolicy {
  return value === 'first' || value === 'manual'
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isKinshipCandidate(info: SessionInfo): boolean {
  return info.isRoot && info.preset === 'kinship'
}

/** Default binding path for one Harness home. */
export function defaultBindingPath(home = process.env['DSH_HOME']): string {
  const base = isNonEmptyString(home) ? home : join(homedir(), '.dsh')
  return join(base, 'kinship', 'binding.json')
}

/** Read and validate the persisted binding, or return null. */
function readPersisted(path: string, logger: BridgeLogger | undefined): BindingState | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    logger?.warn(
      'kinship-bridge: ignoring malformed %s: %s',
      path,
      error instanceof Error ? error.message : String(error),
    )
    return null
  }
  if (!isRecord(parsed)) {
    logger?.warn('kinship-bridge: ignoring %s: root is not an object', path)
    return null
  }
  if (parsed['schema'] !== BINDING_SCHEMA) {
    logger?.warn('kinship-bridge: ignoring %s: unsupported schema %s', path, String(parsed['schema']))
    return null
  }
  if (parsed['preset'] !== 'kinship') {
    logger?.warn('kinship-bridge: ignoring %s: preset is not kinship', path)
    return null
  }
  if (!isNonEmptyString(parsed['session_id']) || !isTimestamp(parsed['bound_at'])) {
    logger?.warn('kinship-bridge: ignoring %s: invalid session_id or bound_at', path)
    return null
  }
  if (!isPolicy(parsed['policy'])) {
    logger?.warn('kinship-bridge: ignoring %s: invalid policy', path)
    return null
  }
  return { sessionId: parsed['session_id'], boundAt: parsed['bound_at'] }
}

/** Atomic write of the complete binding record. */
function writePersisted(path: string, record: PersistedBinding): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${String(process.pid)}.${String(++tmpSequence)}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    const fd = openSync(tmp, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError
    }
    throw error
  }
}

/**
 * Durable single-Session binding.
 *
 * One instance owns one `binding.json`; all transitions notify `onChange`
 * listeners after the in-memory state changes.
 */
export class BindingStore implements BindingController {
  private readonly path: string
  private readonly policy: BindingPolicy
  private readonly configuredSessionId: string
  private readonly rebindOnMissing: boolean
  private readonly logger: BridgeLogger | undefined
  private readonly now: () => number
  private readonly listeners = new Set<() => void>()
  private state: BindingState | null
  private missing = false

  constructor(options: BindingStoreOptions) {
    if (!isAbsolute(options.path)) {
      throw new Error(`kinship-bridge: binding path must be absolute: ${options.path}`)
    }
    this.path = options.path
    this.policy = options.policy
    this.configuredSessionId = options.sessionId.trim()
    this.rebindOnMissing = options.rebindOnMissing
    this.logger = options.logger
    this.now = options.now ?? Date.now
    this.state = readPersisted(this.path, this.logger)
  }

  snapshot(): BindingSnapshot {
    const state = this.state
    if (state === null) {
      return {
        status: 'unbound',
        sessionId: null,
        boundAt: null,
        policy: this.policy,
      }
    }
    return {
      status: this.missing ? 'bound_session_missing' : 'bound',
      sessionId: state.sessionId,
      boundAt: state.boundAt,
      policy: this.policy,
    }
  }

  currentSessionId(): string | null {
    return this.state?.sessionId ?? null
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  bind(sessionId: string, host: BridgeHost): BindingSnapshot {
    const session = host.getSession(sessionId)
    if (session === undefined) throw sessionNotFound(sessionId)
    const info = session.info()
    if (!info.isRoot) throw notRootSession(sessionId)
    if (info.preset !== 'kinship') throw notKinshipSession(sessionId)

    const boundAt = this.now()
    const record: PersistedBinding = {
      schema: BINDING_SCHEMA,
      session_id: sessionId,
      preset: 'kinship',
      bound_at: boundAt,
      policy: this.policy,
    }
    try {
      writePersisted(this.path, record)
    } catch (error) {
      throw new BridgeError(
        500,
        'binding_write_failed',
        `Could not persist the kinship binding: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    this.state = { sessionId, boundAt }
    this.missing = false
    this.logger?.info('kinship-bridge: bound session %s (policy=%s)', sessionId, this.policy)
    this.notify()
    return this.snapshot()
  }

  reconcile(host: BridgeHost): BindingSnapshot {
    const state = this.state
    if (state !== null) {
      const session = host.getSession(state.sessionId)
      if (session !== undefined && isKinshipCandidate(session.info())) {
        if (this.missing) {
          this.missing = false
          this.notify()
        }
        return this.snapshot()
      }

      if (!this.missing) {
        this.missing = true
        this.logger?.warn('kinship-bridge: bound session %s is missing', state.sessionId)
        this.notify()
      }
      if (this.rebindOnMissing && this.policy === 'first') {
        const candidate = this.findFirst(host)
        if (candidate !== undefined) return this.bind(candidate, host)
      }
      return this.snapshot()
    }

    if (this.policy === 'manual') {
      if (this.configuredSessionId !== '') {
        try {
          return this.bind(this.configuredSessionId, host)
        } catch (error) {
          this.logger?.warn(
            'kinship-bridge: configured session %s was not bound: %s',
            this.configuredSessionId,
            error instanceof Error ? error.message : String(error),
          )
        }
      }
      return this.snapshot()
    }

    const candidate = this.findFirst(host)
    if (candidate !== undefined) return this.bind(candidate, host)
    return this.snapshot()
  }

  /** Earliest-created live root Kinship Session. */
  private findFirst(host: BridgeHost): string | undefined {
    const candidates = host
      .listSessions()
      .filter(isKinshipCandidate)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    return candidates[0]?.id
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        this.logger?.warn(
          'kinship-bridge: binding listener failed: %s',
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }
}

/** Resolve the bound Session or throw the exact 409 the contract names. */
export function requireBoundSession(
  binding: BindingController,
  host: BridgeHost,
): { readonly id: string; readonly session: BridgeSession } {
  const snapshot = binding.snapshot()
  if (snapshot.sessionId === null) {
    throw new BridgeError(
      409,
      'no_kinship_session',
      'No root dsh session with agent preset "kinship" is live.',
    )
  }
  if (snapshot.status === 'bound_session_missing') {
    throw new BridgeError(
      409,
      'bound_session_missing',
      `The bound kinship session "${snapshot.sessionId}" is no longer live.`,
    )
  }
  const session = host.getSession(snapshot.sessionId)
  if (session === undefined) {
    throw new BridgeError(
      409,
      'bound_session_missing',
      `The bound kinship session "${snapshot.sessionId}" is no longer live.`,
    )
  }
  return { id: snapshot.sessionId, session }
}
