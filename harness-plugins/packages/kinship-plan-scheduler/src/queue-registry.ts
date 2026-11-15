/**
 * Session-scoped owner of the persistent wake queue.
 *
 * dsh binds at most one Kinship Session, so the scheduler needs exactly one
 * queue at a time, yet that Session can change (manual rebind, harness
 * restart). This registry derives the queue from the bridge's current binding
 * on every use: it keeps the queue while the session id is stable, and lazily
 * disposes the old queue and restores a fresh one when the id changes.
 *
 * @module kinship-plan-scheduler/queue-registry
 */

import { readFileSync, unlinkSync } from 'node:fs'

import type { PlanDelivery } from './delivery.js'
import { renderWakeEntry } from './plan/wake-render.js'
import { WakeQueue, toWakeEntry } from './wake/queue.js'

/** Minimal logging surface; the plugin passes `ctx.logger`. */
export interface QueueRegistryLogger {
  info: Function
  warn: Function
}

/** Wiring the registry needs from the plugin. */
export interface QueueRegistryOptions {
  /** Absolute scheduler-state root. */
  readonly stateDir: string
  /** Bound-Session delivery port. */
  readonly delivery: PlanDelivery
  /** Current scheduler timezone, read at render time. */
  readonly timezone: () => string
  /** Render/observation warning sink. */
  readonly warn: (message: string, entry?: unknown) => void
  readonly logger: QueueRegistryLogger
}

/** Observation kinds worth a warning line; the rest are routine. */
const NOISY_OBSERVATIONS: ReadonlySet<string> = new Set([
  'error',
  'corrupt',
  'wake.failed',
])

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Release the wake queue's instance lock when this process owns it.
 *
 * `WakeQueue` acquires the lock in `restore()` and the ported engine has no
 * release path because Loom held one queue for the whole process lifetime.
 * dsh rebinds Sessions at runtime (and reloads the plugin on a configuration
 * save), so a stale lock would turn the next queue into `wake-queue:locked`.
 * Only a lock owned by this process is removed; a live foreign pid is left
 * untouched so a second harness instance keeps its exclusion.
 */
function releaseInstanceLock(queue: WakeQueue): void {
  const path = queue.paths().instance
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return
    throw error
  }
  let owner: unknown
  try {
    owner = JSON.parse(raw)
  } catch {
    return
  }
  if (typeof owner !== 'object' || owner === null) return
  if ((owner as { pid?: unknown }).pid !== process.pid) return
  try {
    unlinkSync(path)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
  }
}

export class QueueRegistry {
  readonly #options: QueueRegistryOptions
  #queue: WakeQueue | undefined
  #sessionId: string | null = null
  #disposed = false
  #tail: Promise<unknown> = Promise.resolve()

  constructor(options: QueueRegistryOptions) {
    this.#options = options
  }

  /**
   * Return the queue for the currently bound session, creating and restoring
   * it on first use or when the bound session id changed.
   *
   * @returns the live wake queue.
   * @throws {Error} `no bound session` while the bridge has no session, or the
   * restore error (for example another process holding the instance lock).
   */
  current(): Promise<WakeQueue> {
    return this.#serial(() => this.#current())
  }

  /** The queue the last `current()` call settled on, without any I/O. */
  peek(): WakeQueue | undefined {
    return this.#queue
  }

  /** Session id the cached queue belongs to, or null when there is none. */
  sessionId(): string | null {
    return this.#sessionId
  }

  /** Dispose the cached queue (for example after a manual rebind). */
  disposeCurrent(): Promise<void> {
    return this.#serial(() => {
      this.#disposeCurrent()
    })
  }

  /** Drop every timer this registry owns; later `current()` calls fail. */
  dispose(): void {
    this.#disposed = true
    this.#disposeCurrent()
  }

  #serial<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.#tail.then(fn, fn)
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async #current(): Promise<WakeQueue> {
    if (this.#disposed) throw new Error('queue registry disposed')
    const sessionId = this.#options.delivery.sessionId()
    if (sessionId === null) throw new Error('no bound session')
    const existing = this.#queue
    if (existing !== undefined && this.#sessionId === sessionId) return existing
    if (existing !== undefined) this.#disposeCurrent()

    const queue = new WakeQueue({
      stateRoot: this.#options.stateDir,
      sessionID: sessionId,
      now: Date.now,
      observe: event => {
        if (!NOISY_OBSERVATIONS.has(event.kind)) return
        this.#options.warn(`wake queue ${event.kind}`, event)
      },
      render: entry =>
        renderWakeEntry(toWakeEntry(entry), {
          timezone: this.#options.timezone(),
          warn: this.#options.warn,
        }),
      deliver: async (_sessionId, line) => {
        await this.#options.delivery.deliver(line)
      },
      hasSession: id => this.#options.delivery.sessionId() === id,
    })
    this.#queue = queue
    this.#sessionId = sessionId
    this.#options.logger.info(`kinship-plan-scheduler: wake queue ready for session ${sessionId}`)
    try {
      await queue.restore()
      await queue.watchdogTick()
      return queue
    } catch (error) {
      if (this.#queue === queue) this.#disposeCurrent()
      throw error
    }
  }

  #disposeCurrent(): void {
    const queue = this.#queue
    this.#queue = undefined
    this.#sessionId = null
    if (queue === undefined) return
    queue.dispose()
    try {
      releaseInstanceLock(queue)
    } catch (error) {
      this.#options.warn(`wake queue instance lock could not be released: ${messageOf(error)}`)
    }
  }
}
