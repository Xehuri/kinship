/**
 * Host-level Kinship plan scheduler plugin for dsh.
 *
 * Mounts the ported plan engine (master plan, daily overlay, persistent wake
 * queue) as one host plugin: it reconciles at the configured anchors and on
 * boot, restores the bound Session's wake queue, delivers plan wakes through
 * the sibling `kinship-bridge` service, and exposes the owner-facing plan API
 * the Kinship panel edits.
 *
 * The operator configures no paths: the Kinship backend pushes them through the
 * bridge, which persists `$DSH_HOME/kinship/paths.json` and emits
 * `kinship/paths`. This plugin reads that file at boot, and re-resolves on every
 * event so a push that moves the plan root restarts the engine in place. The
 * master plan then owns the scheduling profile: its `timezone` and its daily
 * `plan.build`/`plan.review` slots become the effective zone and anchors.
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
import type { Config, PlanRootSource, PlanRoots } from './config.js'
import { createDefaultMaster } from './defaults.js'
import { createBridgeDelivery } from './delivery.js'
import { deriveAnchors, selectTimezone } from './plan-profile.js'
import type { AnchorsSource } from './plan-profile.js'
import { readPushedPaths, validatePushedPaths } from './pushed-paths.js'
import type { PushedPaths } from './pushed-paths.js'
import { QueueRegistry } from './queue-registry.js'
import { installPlanUiRoutes } from './routes.js'
import type { PlanQueueCounts } from './routes.js'
import { createPlanStatus, createSnapshotBuilder } from './snapshot.js'
import type { PlanSnapshot, PlanSnapshotState, PlanStatus } from './snapshot.js'
import { JsonMasterPlanStore } from './plan/json-master-plan-store.js'
import type { MasterPlanDocument } from './plan/master-plan.js'
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
export type { Config as ConfigShape, PlanRoots, PlanRootSource } from './config.js'
export type { AnchorsSource, DerivedAnchors } from './plan-profile.js'
export type { PushedPaths, PushedPathsRead } from './pushed-paths.js'

/** Delayed re-check after an agent appears while the boot reconcile was deferred. */
const RETRY_DELAY_MS = 1_000

/** Root provenance the panel and the tests read off the service. */
export interface KinshipPlanSchedulerRoots {
  /** Resolved plan root, or null while nothing resolves. */
  readonly planRoot: string | null
  /** Which candidate resolved it, or null. */
  readonly source: PlanRootSource | null
  /** Epoch milliseconds of the last accepted backend push, or null. */
  readonly pushedAt: number | null
  /** `source` of the accepted push document, or null. */
  readonly pushedSource: string | null
  /** Why the pushed document was refused, or null. */
  readonly pushedProblem: string | null
  /** Anchors the running engine uses. */
  readonly anchors: readonly string[]
  /** Where those anchors came from. */
  readonly anchorsSource: AnchorsSource
  /** Effective scheduler timezone (master first). */
  readonly timezone: string
}

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
  /** Live root, anchor and provenance state. */
  roots(): KinshipPlanSchedulerRoots
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    kinshipPlanScheduler: KinshipPlanSchedulerService
  }
}

/** What the running engine was started with; the snapshot projects it. */
interface ActiveEngine {
  readonly root: string
  readonly source: PlanRootSource
  readonly anchors: readonly string[]
  readonly anchorsSource: AnchorsSource
  readonly timezone: string
}

/**
 * Engine identity of the mounted plugin.
 *
 * Module-level on purpose: `apply` runs once per plugin row and the snapshot and
 * the service read this object long after the boot closure returned. Every
 * `apply` resets it so a reload starts clean.
 */
let activeEngine: ActiveEngine | null = null

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
 * Subscribe to the bridge's `kinship/paths` event.
 *
 * The bridge package owns that declaration in the merged Cordis `Events`
 * interface; this plugin deliberately does not redeclare it, because two
 * declarations with different payload types fail the build and the scheduler
 * must stay installable without the bridge. The one untyped boundary therefore
 * lives here, and every field of the payload is re-validated by
 * `validatePushedPaths`.
 *
 * @param ctx - plugin context.
 * @param listener - receives the raw push document.
 * @returns a disposer removing the listener.
 */
function subscribePaths(ctx: Context, listener: (payload: unknown) => void): () => void {
  const on = ctx.on as unknown as (
    name: string,
    handler: (payload: unknown) => void,
  ) => () => boolean
  const off = on.call(ctx, 'kinship/paths', listener)
  return () => {
    off()
  }
}

/** Epoch milliseconds of the last accepted push, or null. */
function pushedAtOf(pushed: PushedPaths | null): number | null {
  if (pushed === null) return null
  return pushed.stored_at ?? pushed.generated_at
}

/**
 * Mount the plan scheduler and its panel API.
 *
 * @param ctx - host context carrying `agents`.
 * @param config - plugin knobs; `planRoot`/`anchors`/`timezone` are overrides,
 * the Kinship backend's pushed paths and the master plan supply the rest.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  activeEngine = null
  /** Last accepted push document; re-resolved on every `kinship/paths` event. */
  let cachedPushed: PushedPaths | null = null
  /** Why the last push (or the file) was refused, if it was. */
  let pushedProblem: string | null = null
  /** Current resolution; refreshed on boot and on every accepted push. */
  let resolved: PlanRoots = resolveRoots(config, null)

  const status: PlanStatus = createPlanStatus()

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

  /** Anchors/timezone shown while no engine runs: config override or defaults. */
  const idleProfile = (): { anchors: readonly string[]; anchorsSource: AnchorsSource; timezone: string } => {
    const derived = deriveAnchors(null, config.anchors)
    return { anchors: derived.anchors, anchorsSource: derived.source, timezone: selectTimezone(null, config.timezone) }
  }

  /** Live projection state the snapshot builder reads on every call. */
  const viewState = (): PlanSnapshotState => {
    const idle = idleProfile()
    return {
      planRoot: resolved.planRoot,
      stateDir: resolved.stateDir,
      problem: resolved.problem,
      planRootSource: resolved.source,
      pathsPushedAt: pushedAtOf(cachedPushed),
      pathsSource: cachedPushed?.source ?? null,
      pathsProblem: pushedProblem ?? resolved.pushedProblem,
      anchors: activeEngine?.anchors ?? idle.anchors,
      anchorsSource: activeEngine?.anchorsSource ?? idle.anchorsSource,
      timezone: activeEngine?.timezone ?? idle.timezone,
    }
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

  /** Teardown of one engine generation; safe to call when nothing runs. */
  const stopEngine = (): void => {
    const engine = scheduler
    const queueRegistry = registry
    scheduler = undefined
    registry = undefined
    masterStore = undefined
    lastResult = null
    activeEngine = null
    if (engine !== undefined) {
      try {
        engine.dispose()
      } catch (error) {
        warn(`scheduler dispose failed: ${messageOf(error)}`)
      }
    }
    if (queueRegistry !== undefined) {
      try {
        queueRegistry.dispose()
      } catch (error) {
        warn(`wake queue dispose failed: ${messageOf(error)}`)
      }
    }
  }

  /**
   * Build and start one engine generation over `root`.
   *
   * The master is read first because it owns the scheduling profile: its
   * timezone and its daily plan slots decide the effective zone and anchors. A
   * missing or unreadable master is not fatal (the panel offers the seed route);
   * the plugin row's timezone/anchors cover that window.
   *
   * @param root - absolute plan root the generation runs on.
   * @param source - which candidate supplied it, for the panel and the logs.
   */
  async function startEngine(root: string, source: PlanRootSource): Promise<void> {
    if (config.mode === 'off') {
      ctx.logger.info('kinship-plan-scheduler: mode=off, engine not started')
      return
    }
    try {
      const store = new JsonMasterPlanStore({ planRoot: root })
      let master: MasterPlanDocument | null = null
      try {
        master = await store.read()
      } catch {
        master = null
      }
      const timezone = selectTimezone(master, config.timezone)
      const derived = deriveAnchors(master, config.anchors)

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
        stateDir: resolved.stateDir,
        delivery,
        timezone: () => timezone,
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
        timezone,
        anchors: derived.anchors,
        watchdogMs: config.watchdogMs,
        horizonHours: config.horizonHours,
        catchupMaxAgeHours: config.catchupMaxAgeHours,
        debtAfterHours: config.debtAfterHours,
        shadow: config.mode === 'shadow',
        stateRoot: resolved.stateDir,
        observe,
        ledger: ledgerSink,
        ...(config.mode === 'live' ? { queue: proxyQueue } : {}),
      })

      masterStore = store
      registry = queueRegistry
      scheduler = engine
      activeEngine = {
        root,
        source,
        anchors: derived.anchors,
        anchorsSource: derived.source,
        timezone,
      }
      status.degraded = false
      status.lastError = null
      ctx.logger.info(
        'kinship-plan-scheduler: engine ready (planRoot=%s, source=%s, mode=%s, timezone=%s, anchors=%s/%s)',
        root,
        source,
        config.mode,
        timezone,
        derived.anchors.join(','),
        derived.source,
      )

      await runReconcile('boot')
      engine.start()
    } catch (error) {
      status.degraded = true
      status.lastError = messageOf(error)
      ctx.logger.warn('kinship-plan-scheduler: engine setup failed: %s', messageOf(error))
      stopEngine()
    }
  }

  /** Record a root-resolution failure on the panel's health line. */
  const noteRootProblem = (): void => {
    if (resolved.problem === null) return
    status.degraded = true
    status.lastError = resolved.problem
  }

  // Boot: the pushed document wins, so read it before resolving any root.
  const bootRead = readPushedPaths()
  cachedPushed = bootRead.paths
  pushedProblem = bootRead.problem
  resolved = resolveRoots(config, cachedPushed)
  noteRootProblem()
  if (bootRead.problem !== null) {
    ctx.logger.warn('kinship-plan-scheduler: pushed paths refused: %s', bootRead.problem)
  }
  if (config.mode === 'off') {
    ctx.logger.info('kinship-plan-scheduler: mode=off, engine not started')
  } else if (resolved.planRoot === null || resolved.source === null) {
    ctx.logger.warn('kinship-plan-scheduler: engine disabled: %s', resolved.problem ?? 'no plan root')
  } else {
    await startEngine(resolved.planRoot, resolved.source)
  }

  /**
   * Handle one `kinship/paths` push: validate, re-resolve, and restart the
   * engine when the root moved.
   *
   * The bridge's event carries the stored document (or null when it has none).
   * A refused payload falls back to the file the bridge just wrote, since the
   * two should hold the same document; when neither is usable the current
   * resolution and the running engine are kept untouched, because a single bad
   * push must not strand a scheduler that is working. A push that resolves to
   * the same root only refreshes the cached metadata, so the panel shows the new
   * sync time without a restart.
   */
  const onPathsPushed = (payload: unknown): void => {
    if (payload === null) {
      cachedPushed = null
      pushedProblem = null
    } else {
      const fromPayload = validatePushedPaths(payload)
      if (fromPayload.paths !== null) {
        cachedPushed = fromPayload.paths
        pushedProblem = null
      } else {
        const fromFile = readPushedPaths()
        if (fromFile.paths !== null) {
          cachedPushed = fromFile.paths
          pushedProblem = null
        } else {
          pushedProblem = fromPayload.problem ?? fromFile.problem
          ctx.logger.warn(
            'kinship-plan-scheduler: pushed paths refused: %s',
            pushedProblem ?? 'no usable document',
          )
          return
        }
      }
    }
    const candidate = resolveRoots(config, cachedPushed)
    const next =
      candidate.planRoot === null || candidate.source === null
        ? null
        : { root: candidate.planRoot, source: candidate.source }
    if (next === null) {
      if (activeEngine !== null) {
        // Keep the running engine *and* the resolution it was started from, so
        // the panel keeps describing what actually runs.
        ctx.logger.warn(
          'kinship-plan-scheduler: keeping planRoot=%s, the pushed paths resolve to none',
          activeEngine.root,
        )
        return
      }
      resolved = candidate
      noteRootProblem()
      return
    }
    const previous = activeEngine
    resolved = candidate
    noteRootProblem()
    if (previous !== null && previous.root === next.root && scheduler !== undefined) {
      ctx.logger.info(
        'kinship-plan-scheduler: paths synced for planRoot=%s (source=%s)',
        next.root,
        next.source,
      )
      return
    }
    ctx.logger.info(
      'kinship-plan-scheduler: plan root %s -> %s (source=%s), restarting the engine',
      previous?.root ?? '(none)',
      next.root,
      next.source,
    )
    stopEngine()
    void startEngine(next.root, next.source)
  }

  const offPaths = subscribePaths(ctx, onPathsPushed)
  ctx.effect(
    () => () => {
      offPaths()
      stopEngine()
    },
    'kinship-plan-scheduler engine',
  )

  const snapshotBuilder = createSnapshotBuilder({
    mode: config.mode,
    state: viewState,
    status,
    master: async () => (masterStore === undefined ? null : masterStore.read()),
    queue: () => registry ?? null,
    warn,
  })
  const snapshot = (): Promise<PlanSnapshot> => snapshotBuilder.snapshot()

  const rootsOf = (): KinshipPlanSchedulerRoots => {
    const state = viewState()
    return {
      planRoot: state.planRoot,
      source: state.planRootSource,
      pushedAt: state.pathsPushedAt,
      pushedSource: state.pathsSource,
      pushedProblem: state.pathsProblem,
      anchors: [...state.anchors],
      anchorsSource: state.anchorsSource,
      timezone: state.timezone,
    }
  }

  /** Effective timezone for the seed route: the running engine's, else config. */
  const effectiveTimezone = (): string => activeEngine?.timezone ?? selectTimezone(null, config.timezone)

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
        get registry() {
          return registry ?? null
        },
        get scheduler() {
          return scheduler ?? null
        },
        roots: rootsOf,
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
      seedMaster: () => createDefaultMaster({ timezone: effectiveTimezone(), now: Date.now() }),
      reconcile: async () => countsOf(await runReconcile('manual')),
    })
    ctx.logger.info('kinship-plan-scheduler: panel API registered on /api/kinship/ui/plan')
  })
}
