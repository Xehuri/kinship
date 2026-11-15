/**
 * Host-level Kinship plan scheduler plugin for dsh.
 *
 * Mounts the ported plan engine (master plan, daily overlay, persistent wake
 * queue) as one host plugin: it reconciles at the configured anchors and on
 * boot, restores the bound Session's wake queue, delivers plan wakes through
 * the sibling `kinship-bridge` service, and exposes the owner-facing plan API
 * the Kinship panel edits.
 *
 * The plugin is always mounted: when the plan root cannot be resolved the
 * engine stays off and the panel routes still answer, with `scheduler.problem`
 * telling the owner what to configure. `mode: "shadow"` runs reconciliation
 * without touching the queue; `mode: "off"` skips the engine entirely.
 *
 * @module kinship-plan-scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-client-connection'
import { resolveRoots } from './config.js'
import type { Config } from './config.js'
import { createDefaultMaster } from './defaults.js'
import { createBridgeDelivery } from './delivery.js'
import { QueueRegistry } from './queue-registry.js'
import { installPlanUiRoutes } from './routes.js'
import type { PlanQueueCounts } from './routes.js'
import { createPlanStatus, createSnapshotBuilder } from './snapshot.js'
import type { PlanSnapshot, PlanStatus } from './snapshot.js'
import { JsonMasterPlanStore } from './plan/json-master-plan-store.js'
import { JsonPlanOverlayStore } from './plan/json-plan-overlay-store.js'
import { readLegacyPlan } from './plan/legacy.js'
import { PlanLedger } from './plan/plan-ledger.js'
import { PlanScheduler } from './plan/plan-scheduler.js'
import type {
  PlanSchedulerLedgerRow,
  PlanSchedulerObservation,
  PlanSchedulerOptions,
  PlanSchedulerOverlayStore,
  ReconcileReason,
  ReconcileResult,
} from './plan/plan-scheduler.js'

export { Config, inject, name } from './config.js'
export type { Config as ConfigShape, PlanRoots } from './config.js'

/** Delayed re-check after an agent appears while the boot reconcile was deferred. */
const RETRY_DELAY_MS = 1_000

/** Host service exposed for diagnostics and tests; not used by production code. */
export interface KinshipPlanSchedulerService {
  /** Current panel projection. */
  snapshot(): Promise<PlanSnapshot>
  /** Run one reconcile; null when the engine is disabled. */
  reconcile(reason?: ReconcileReason): Promise<ReconcileResult | null>
  /** Session-scoped queue owner, or null when the engine is disabled. */
  readonly registry: QueueRegistry | null
  /** Mounted scheduler, or null when the engine is disabled. */
  readonly scheduler: PlanScheduler | null
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    kinshipPlanScheduler: KinshipPlanSchedulerService
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describeEntry(entry: unknown): string {
  try {
    const text = JSON.stringify(entry)
    return text === undefined ? String(entry) : text
  } catch {
    return String(entry)
  }
}

/**
 * Mount the plan scheduler and its panel API.
 *
 * @param ctx - host context carrying `agents`.
 * @param config - validated plan roots, mode, timezone and timing knobs.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const roots = resolveRoots(config)
  const status: PlanStatus = createPlanStatus()
  if (roots.problem !== null) {
    status.degraded = true
    status.lastError = roots.problem
  }

  /** Warning sink shared by the queue, the renderer and the snapshot builder. */
  const warn = (message: string, entry?: unknown): void => {
    ctx.logger.warn(
      'kinship-plan-scheduler: %s',
      entry === undefined ? message : `${message} (${describeEntry(entry)})`,
    )
  }

  let scheduler: PlanScheduler | undefined
  let registry: QueueRegistry | undefined
  let masterStore: JsonMasterPlanStore | undefined
  let lastResult: ReconcileResult | null = null

  const planRoot = roots.planRoot
  if (config.mode !== 'off' && planRoot !== null) {
    try {
      const root = planRoot
      const store = new JsonMasterPlanStore({ planRoot: root })
      const overlayEngine = new JsonPlanOverlayStore({ planRoot: root, master: store })
      // 覆盖层引擎自带的 readLegacy 是 Loom 严格版，dsh 的 v1 文件形状不同，统一走 legacy.ts 的宽容读取。
      const overlayStore: PlanSchedulerOverlayStore = {
        read: date => overlayEngine.read(date),
        readLegacy: async date => readLegacyPlan(root, date),
      }
      const ledger = new PlanLedger({ planRoot: root })
      const ledgerSink = (row: PlanSchedulerLedgerRow): void => {
        void ledger
          .append({
            date: row.date,
            source: 'scheduler',
            event: row.event,
            ...(row.reason === undefined ? {} : { reason: row.reason }),
            ...(row.entry_id === undefined ? {} : { entry_id: row.entry_id }),
          })
          .catch((error: unknown) => {
            warn(`scheduler ledger append failed: ${messageOf(error)}`)
          })
      }
      /** Warn once per distinct failure signature; the watchdog repeats anyway. */
      let lastErrorSignature: string | null = null
      const warnError = (signature: string, message: string): void => {
        if (lastErrorSignature === signature) return
        lastErrorSignature = signature
        warn(message)
      }
      const observe = (event: PlanSchedulerObservation): void => {
        switch (event.kind) {
          case 'reconcile':
            status.degraded = false
            status.lastError = null
            lastErrorSignature = null
            ctx.logger.info(
              'kinship-plan-scheduler: reconciled %s (%s): %s entries',
              event.date,
              event.reason,
              String(event.entries),
            )
            return
          case 'deferred_no_session':
            ctx.logger.info(
              'kinship-plan-scheduler: reconcile deferred, no bound session (%s)',
              event.reason,
            )
            return
          case 'master_error':
            status.degraded = true
            status.lastError = `master: ${event.message}`
            warnError(`master_error:${event.message}`, `master plan error (${event.reason}): ${event.message}`)
            return
          case 'master_fallback':
            status.degraded = true
            status.lastError = `master fallback: ${event.message}`
            warnError(
              `master_fallback:${event.message}`,
              `master plan fallback (${event.reason}): ${event.message}`,
            )
            return
          case 'overlay_error':
            status.lastError = `overlay ${event.date}: ${event.message}`
            warnError(
              `overlay_error:${event.date}:${event.message}`,
              `overlay ${event.date}: ${event.message}`,
            )
            return
          case 'overlay_warning':
            warnError(
              `overlay_warning:${event.date}:${event.warning}`,
              `overlay ${event.date}: ${event.warning}`,
            )
            return
          case 'queue_error':
            status.degraded = true
            status.lastError = `queue: ${event.message}`
            warnError(`queue_error:${event.message}`, `wake queue error: ${event.message}`)
            return
          case 'error':
            status.degraded = true
            status.lastError = `${event.operation}: ${event.message}`
            warnError(`${event.operation}:${event.message}`, `${event.operation}: ${event.message}`)
            return
          case 'shadow':
            ctx.logger.info(
              'kinship-plan-scheduler: shadow reconcile %s: %s entries -> %s',
              event.date,
              String(event.entries),
              event.path,
            )
            return
          case 'coalesced':
            ctx.logger.info(
              'kinship-plan-scheduler: coalesced %s on %s (%s slots)',
              event.id,
              event.date,
              String(event.slots),
            )
            return
          case 'skipped_debt':
          case 'skipped_horizon':
          case 'skipped_no_time':
          case 'duplicate':
            return
          default:
            return
        }
      }

      const delivery = createBridgeDelivery(ctx)
      const queueRegistry = new QueueRegistry({
        stateDir: roots.stateDir,
        delivery,
        timezone: () => config.timezone,
        warn,
        logger: ctx.logger,
      })
      const proxyQueue: PlanSchedulerOptions['queue'] = {
        reconcileSource: (source, entries) =>
          queueRegistry.current().then(queue => queue.reconcileSource(source, entries)),
      }
      const engine = new PlanScheduler({
        masterStore: store,
        overlayStore,
        mainSession: () => delivery.sessionId(),
        timezone: config.timezone,
        anchors: config.anchors,
        watchdogMs: config.watchdogMs,
        horizonHours: config.horizonHours,
        catchupMaxAgeHours: config.catchupMaxAgeHours,
        debtAfterHours: config.debtAfterHours,
        shadow: config.mode === 'shadow',
        stateRoot: roots.stateDir,
        observe,
        ledger: ledgerSink,
        ...(config.mode === 'live' ? { queue: proxyQueue } : {}),
      })

      masterStore = store
      registry = queueRegistry
      scheduler = engine
      ctx.logger.info(
        'kinship-plan-scheduler: engine ready (planRoot=%s, mode=%s)',
        root,
        config.mode,
      )
    } catch (error) {
      status.degraded = true
      status.lastError = messageOf(error)
      ctx.logger.warn('kinship-plan-scheduler: engine setup failed: %s', messageOf(error))
    }
  } else if (config.mode === 'off') {
    ctx.logger.info('kinship-plan-scheduler: mode=off, engine not started')
  } else if (roots.problem !== null) {
    ctx.logger.warn('kinship-plan-scheduler: engine disabled: %s', roots.problem)
  }

  /** One reconcile; never throws, records the last result for the retry gate. */
  const runReconcile = async (reason: ReconcileReason): Promise<ReconcileResult | null> => {
    const engine = scheduler
    if (engine === undefined) return null
    try {
      const result = await engine.reconcile({ reason })
      lastResult = result
      return result
    } catch (error) {
      status.degraded = true
      status.lastError = messageOf(error)
      ctx.logger.warn('kinship-plan-scheduler: reconcile (%s) failed: %s', reason, messageOf(error))
      return null
    }
  }

  const countsOf = (result: ReconcileResult | null): PlanQueueCounts => {
    const queue = result?.queue
    if (queue === undefined || queue === null) return { added: 0, updated: 0, cancelled: 0 }
    return { added: queue.added, updated: queue.updated, cancelled: queue.cancelled }
  }

  const requireMasterStore = (): JsonMasterPlanStore => {
    if (masterStore === undefined) throw new Error('kinship plan scheduler is disabled')
    return masterStore
  }

  const snapshotBuilder = createSnapshotBuilder({
    mode: config.mode,
    planRoot,
    stateDir: roots.stateDir,
    problem: roots.problem,
    timezone: config.timezone,
    anchors: config.anchors,
    status,
    master: masterStore === undefined ? null : () => requireMasterStore().read(),
    queue: registry ?? null,
    warn,
  })
  const snapshot = (): Promise<PlanSnapshot> => snapshotBuilder.snapshot()

  if (scheduler !== undefined) {
    await runReconcile('boot')
    scheduler.start()
    ctx.effect(
      () => () => {
        scheduler?.dispose()
        registry?.dispose()
      },
      'kinship-plan-scheduler engine',
    )
  }

  /**
   * A boot reconcile usually runs before any Session exists and defers; the
   * bridge binds on `agent/created`, so re-check shortly after a Session
   * appears instead of waiting for the next anchor.
   */
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  const offCreated = ctx.on('agent/created', (): undefined => {
    if (lastResult?.status !== 'deferred_no_session') return
    if (scheduler === undefined) return
    if (retryTimer !== null) clearTimeout(retryTimer)
    const handle = setTimeout(() => {
      retryTimer = null
      if (lastResult?.status !== 'deferred_no_session') return
      void runReconcile('manual')
    }, RETRY_DELAY_MS)
    const candidate: { unref?: () => void } = handle
    candidate.unref?.()
    retryTimer = handle
  })
  ctx.effect(
    () => () => {
      offCreated()
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
    },
    'kinship-plan-scheduler agent listener',
  )

  ctx.effect(
    () =>
      ctx.provide('kinshipPlanScheduler', {
        snapshot,
        reconcile: async reason => runReconcile(reason ?? 'manual'),
        registry: registry ?? null,
        scheduler: scheduler ?? null,
      }),
    'kinship-plan-scheduler service',
  )

  ctx.inject(['connection'], (scope) => {
    installPlanUiRoutes(scope, {
      snapshot,
      enabled: () => scheduler !== undefined,
      editMaster: async (ops, expectedVersion, reason) =>
        requireMasterStore().edit(ops, expectedVersion, reason),
      readMaster: async () => requireMasterStore().read(),
      writeMaster: async (document, expectedVersion) =>
        requireMasterStore().write(document, expectedVersion),
      seedMaster: () => createDefaultMaster({ timezone: config.timezone, now: Date.now() }),
      reconcile: async () => countsOf(await runReconcile('manual')),
    })
    ctx.logger.info('kinship-plan-scheduler: panel API registered on /api/kinship/ui/plan')
  })
}
