/**
 * Panel projection of the plan scheduler: master rows, wake-queue contents and
 * the scheduler's own health.
 *
 * The projection is read-only and self-contained: it re-reads the master file
 * on every call (so the panel never shows a stale schedule), computes the next
 * occurrence per enabled entry with the ported timezone helpers, and projects
 * the wake queue through `peek()` without triggering restore or delivery.
 *
 * @module kinship-plan-scheduler/snapshot
 */

import { MasterPlanNotFoundError } from './plan/master-plan.js'
import type { MasterEntry, MasterPlanDocument } from './plan/master-plan.js'
import { nextOccurrence, zonedNow } from './plan/timezone.js'
import type { WakeQueue, WakeQueueDelivered, WakeQueueEntry, WakeQueueSnapshot } from './wake/queue.js'

/** One master entry as the panel renders it. */
export interface PlanScheduleRow {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly action: string | null
  readonly enabled: boolean
  readonly status: string
  /** Raw master schedule object, passed through unchanged. */
  readonly schedule: unknown
  readonly next_at: number | null
  readonly next_local: string | null
}

/** Scheduler-level health shown at the top of the panel. */
export interface PlanSnapshotScheduler {
  readonly mode: 'live' | 'shadow' | 'off'
  readonly planRoot: string | null
  readonly stateDir: string
  readonly timezone: string
  readonly anchors: readonly string[]
  readonly degraded: boolean
  readonly lastError: string | null
  /** Root-resolution failure, distinct from a runtime error. */
  readonly problem: string | null
  readonly masterPresent: boolean
}

/** One pending wake entry as the panel lists it. */
export interface PlanSnapshotPending {
  readonly id: string
  readonly at: number
  readonly action: string | null
  readonly attempts: number
  readonly title: string
}

/** One delivered wake entry as the panel lists it. */
export interface PlanSnapshotDelivered {
  readonly id: string
  readonly delivered_at: number
  readonly outcome: string | null
}

/** One complete panel snapshot. */
export interface PlanSnapshot {
  readonly ok: true
  readonly scheduler: PlanSnapshotScheduler
  readonly master: {
    readonly version: number
    readonly timezone: string
    readonly updatedAt: number
    readonly entries: readonly PlanScheduleRow[]
  } | null
  readonly queue: {
    readonly sessionId: string | null
    readonly pending: readonly PlanSnapshotPending[]
    readonly delivered: readonly PlanSnapshotDelivered[]
  }
  readonly next: { readonly id: string; readonly title: string; readonly at: number; readonly local: string } | null
}

/**
 * Mutable scheduler health the plugin updates from scheduler and queue
 * observations; the builder only reads it.
 */
export interface PlanStatus {
  degraded: boolean
  lastError: string | null
}

/** Fresh, healthy status holder. */
export function createPlanStatus(): PlanStatus {
  return { degraded: false, lastError: null }
}

/** Wake-queue view the snapshot needs; `QueueRegistry` satisfies it. */
export interface PlanSnapshotQueueSource {
  sessionId(): string | null
  peek(): WakeQueue | undefined
}

/** Wiring for the snapshot builder. */
export interface PlanSnapshotDeps {
  readonly mode: 'live' | 'shadow' | 'off'
  readonly planRoot: string | null
  readonly stateDir: string
  /** Root-resolution failure from `resolveRoots`, if any. */
  readonly problem: string | null
  /** Fallback timezone used while no master document exists. */
  readonly timezone: string
  readonly anchors: readonly string[]
  readonly status: PlanStatus
  /** Master reader, or null while the engine is disabled. */
  readonly master: (() => Promise<MasterPlanDocument>) | null
  /** Wake-queue source, or null while the engine is disabled. */
  readonly queue: PlanSnapshotQueueSource | null
  /** Best-effort warning sink for projection reads that fail. */
  readonly warn?: (message: string) => void
}

/** Builder returned to the plugin and the routes. */
export interface PlanSnapshotBuilder {
  snapshot(): Promise<PlanSnapshot>
}

/** Largest delivered tail the panel receives. */
const DELIVERED_TAIL = 10

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `YYYY-MM-DD HH:MM` in the given zone; falls back to UTC for invalid zones. */
function localStamp(epoch: number, timeZone: string): string {
  try {
    const zoned = zonedNow(epoch, timeZone)
    return `${zoned.dateKey} ${pad2(zoned.hour)}:${pad2(zoned.minute)}`
  } catch {
    return new Date(epoch).toISOString().slice(0, 16).replace('T', ' ')
  }
}

function payloadTitle(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const title = (payload as Record<string, unknown>)['title']
  return typeof title === 'string' && title.trim() !== '' ? title : null
}

function rowOf(entry: MasterEntry, timezone: string, now: number): PlanScheduleRow {
  let nextAt: number | null = null
  try {
    nextAt = nextOccurrence(entry.schedule, now, timezone)
  } catch {
    nextAt = null
  }
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    action: entry.action ?? null,
    enabled: entry.enabled,
    status: entry.status ?? 'active',
    schedule: entry.schedule,
    next_at: nextAt,
    next_local: nextAt === null ? null : localStamp(nextAt, timezone),
  }
}

function pendingRow(entry: WakeQueueEntry): PlanSnapshotPending {
  return {
    id: entry.id,
    at: entry.at,
    action: entry.action ?? null,
    attempts: entry.attempts,
    title: payloadTitle(entry.payload) ?? entry.id,
  }
}

function deliveredRow(entry: WakeQueueDelivered): PlanSnapshotDelivered {
  return {
    id: entry.id,
    delivered_at: entry.delivered_at,
    outcome: entry.outcome ?? null,
  }
}

async function readMaster(deps: PlanSnapshotDeps): Promise<{
  master: MasterPlanDocument | null
  present: boolean
}> {
  if (deps.master === null) return { master: null, present: false }
  try {
    return { master: await deps.master(), present: true }
  } catch (error) {
    if (error instanceof MasterPlanNotFoundError) return { master: null, present: false }
    deps.warn?.(`master plan is unreadable: ${messageOf(error)}`)
    return { master: null, present: true }
  }
}

async function readQueue(deps: PlanSnapshotDeps, warn: (message: string) => void): Promise<WakeQueueSnapshot> {
  const queue = deps.queue?.peek()
  if (queue === undefined) return { entries: [], delivered: [] }
  try {
    return await queue.snapshot()
  } catch (error) {
    warn(`wake queue snapshot failed: ${messageOf(error)}`)
    return { entries: [], delivered: [] }
  }
}

/**
 * Build the panel snapshot assembler.
 *
 * @param deps - live plugin state and the store/queue readers.
 * @returns an object whose `snapshot()` produces one panel response.
 */
export function createSnapshotBuilder(deps: PlanSnapshotDeps): PlanSnapshotBuilder {
  const warn = (message: string): void => {
    deps.warn?.(message)
  }
  return {
    async snapshot(): Promise<PlanSnapshot> {
      const now = Date.now()
      const { master, present } = await readMaster(deps)
      const timezone = master?.timezone ?? deps.timezone
      const rows = master === null ? [] : master.entries.map(entry => rowOf(entry, timezone, now))

      let next: PlanSnapshot['next'] = null
      for (const row of rows) {
        if (!row.enabled || row.next_at === null) continue
        if (next === null || row.next_at < next.at) {
          next = { id: row.id, title: row.title, at: row.next_at, local: localStamp(row.next_at, timezone) }
        }
      }

      const queueSnapshot = await readQueue(deps, warn)
      const pending = queueSnapshot.entries.map(pendingRow).sort((left, right) => left.at - right.at || left.id.localeCompare(right.id))
      const delivered = queueSnapshot.delivered.slice(-DELIVERED_TAIL).map(deliveredRow)

      return {
        ok: true,
        scheduler: {
          mode: deps.mode,
          planRoot: deps.planRoot,
          stateDir: deps.stateDir,
          timezone,
          anchors: [...deps.anchors],
          degraded: deps.status.degraded,
          lastError: deps.status.lastError,
          problem: deps.problem,
          masterPresent: present,
        },
        master:
          master === null
            ? null
            : {
                version: master.version,
                timezone: master.timezone,
                updatedAt: master.updated_at,
                entries: rows,
              },
        queue: {
          sessionId: deps.queue?.sessionId() ?? null,
          pending,
          delivered,
        },
        next,
      }
    },
  }
}
