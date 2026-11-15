/**
 * Owner-facing JSON routes behind the Kinship panel's plan editor.
 *
 * Registered on the dsh Connection's exact Fetch channel exactly like the
 * bridge's own panel routes: the Host/Origin fence and browser-session check
 * already ran, so these routes need no credential of their own. Every write
 * goes through the master store's versioned edit path, then re-reconciles the
 * wake queue, so a panel save and a scheduled reconcile can never disagree
 * about which version they mutated.
 *
 * @module kinship-plan-scheduler/routes
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import {
  MasterPlanConflictError,
  MasterPlanNotFoundError,
  MasterPlanValidationError,
} from './plan/master-plan.js'
import type { MasterPlanDocument } from './plan/master-plan.js'
import type { PlanSnapshot } from './snapshot.js'

/** Absolute route below `/api` that returns one plan snapshot. */
export const PLAN_UI_PATH = '/api/kinship/ui/plan'
/** Absolute route below `/api` that applies master edit operations. */
export const PLAN_UI_OPS_PATH = '/api/kinship/ui/plan/ops'
/** Absolute route below `/api` that forces a reconcile. */
export const PLAN_UI_RECONCILE_PATH = '/api/kinship/ui/plan/reconcile'
/** Absolute route below `/api` that seeds the generic default master plan. */
export const PLAN_UI_SEED_PATH = '/api/kinship/ui/plan/seed'

/** Largest accepted JSON body on the panel's write routes. */
export const PLAN_UI_BODY_LIMIT_BYTES = 16 * 1024

/** Counts returned by the reconcile route. */
export interface PlanQueueCounts {
  readonly added: number
  readonly updated: number
  readonly cancelled: number
}

/** Operations the panel routes need from the plugin. */
export interface PlanUiDeps {
  /** Current panel projection. */
  readonly snapshot: () => Promise<PlanSnapshot>
  /** True when the scheduler engine is mounted and may write. */
  readonly enabled: () => boolean
  /** Apply master edit ops through the versioned store. */
  readonly editMaster: (ops: readonly unknown[], expectedVersion: number, reason: string) => Promise<unknown>
  /** Read the master document, throwing the store's not-found/validation errors. */
  readonly readMaster: () => Promise<unknown>
  /** Create the master document at the given expected version. */
  readonly writeMaster: (document: MasterPlanDocument, expectedVersion: number | null) => Promise<unknown>
  /** Fresh generic master document for the seed route. */
  readonly seedMaster: () => MasterPlanDocument
  /** Reconcile the queue after a write. */
  readonly reconcile: () => Promise<PlanQueueCounts>
}

/** Fetch-shaped handlers, one per route. */
export interface PlanUiRoutes {
  readonly snapshot: () => Promise<Response>
  readonly ops: (request: Request) => Promise<Response>
  readonly reconcile: (request: Request) => Promise<Response>
  readonly seed: (request: Request) => Promise<Response>
}

/** A refusal the panel renders verbatim. */
export class PlanUiError extends Error {
  /**
   * @param status - HTTP status to answer.
   * @param code - stable machine code for the panel's error text.
   * @param message - human sentence shown in the panel.
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'PlanUiError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** JSON response with the panel's no-store policy. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** One failure envelope, identical to the bridge panel's shape. */
function fail(status: number, code: string, message: string): Response {
  return json(status, { ok: false, error: { code, message } })
}

/** Map a thrown refusal onto its envelope. */
function errorResponse(error: unknown): Response {
  if (error instanceof PlanUiError) return fail(error.status, error.code, error.message)
  if (error instanceof MasterPlanConflictError) return fail(409, 'master_conflict', error.message)
  if (error instanceof MasterPlanNotFoundError) return fail(404, 'master_missing', error.message)
  if (error instanceof MasterPlanValidationError) return fail(400, 'invalid_request', error.message)
  return fail(500, 'internal', error instanceof Error ? error.message : String(error))
}

/** Read one bounded JSON object body. */
async function readJson(request: Request): Promise<Record<string, unknown>> {
  let text: string
  try {
    text = await request.text()
  } catch (error) {
    throw new PlanUiError(
      400,
      'invalid_request',
      `Could not read the request body: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (text.length > PLAN_UI_BODY_LIMIT_BYTES) {
    throw new PlanUiError(413, 'body_too_large', `Request body exceeds ${String(PLAN_UI_BODY_LIMIT_BYTES)} bytes.`)
  }
  if (text.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new PlanUiError(400, 'invalid_request', 'Request body is not valid JSON.')
  }
  if (!isRecord(parsed)) throw new PlanUiError(400, 'invalid_request', 'Request body must be a JSON object.')
  return parsed
}

function requireEnabled(deps: PlanUiDeps): void {
  if (deps.enabled()) return
  throw new PlanUiError(
    409,
    'scheduler_disabled',
    'The plan scheduler is disabled; configure planRoot and a non-off mode to enable it.',
  )
}

function asQueued(counts: PlanQueueCounts): PlanQueueCounts {
  return { added: counts.added, updated: counts.updated, cancelled: counts.cancelled }
}

/**
 * Build the four route handlers.
 *
 * @param deps - live plugin state and the operations the panel may perform.
 * @returns one Fetch handler per route.
 */
export function createPlanUiRoutes(deps: PlanUiDeps): PlanUiRoutes {
  return {
    snapshot: async () => {
      try {
        return json(200, await deps.snapshot())
      } catch (error) {
        return errorResponse(error)
      }
    },

    ops: async (request) => {
      try {
        requireEnabled(deps)
        const body = await readJson(request)
        const expectedVersion = body['expectedVersion']
        if (
          typeof expectedVersion !== 'number' ||
          !Number.isInteger(expectedVersion) ||
          expectedVersion < 1
        ) {
          throw new PlanUiError(400, 'invalid_request', 'expectedVersion must be a positive integer.')
        }
        const ops = body['ops']
        if (!Array.isArray(ops)) throw new PlanUiError(400, 'invalid_request', 'ops must be an array.')
        await deps.editMaster(ops, expectedVersion, 'ui:plan-schedule')
        await deps.reconcile()
        return json(200, await deps.snapshot())
      } catch (error) {
        return errorResponse(error)
      }
    },

    reconcile: async (request) => {
      try {
        requireEnabled(deps)
        const body = await readJson(request)
        const reason = body['reason']
        if (reason !== undefined && reason !== 'manual') {
          throw new PlanUiError(400, 'invalid_request', 'reason must be "manual".')
        }
        const queued = asQueued(await deps.reconcile())
        return json(200, { ok: true, queued, snapshot: await deps.snapshot() })
      } catch (error) {
        return errorResponse(error)
      }
    },

    seed: async (request) => {
      try {
        requireEnabled(deps)
        await readJson(request)
        let exists = true
        try {
          await deps.readMaster()
        } catch (error) {
          if (error instanceof MasterPlanNotFoundError) exists = false
          else throw error
        }
        if (exists) {
          throw new PlanUiError(
            409,
            'master_exists',
            'The master plan already exists; edit it instead of seeding.',
          )
        }
        await deps.writeMaster(deps.seedMaster(), null)
        await deps.reconcile()
        return json(200, await deps.snapshot())
      } catch (error) {
        return errorResponse(error)
      }
    },
  }
}

/**
 * Register the plan panel routes on the dsh Connection.
 *
 * The registration belongs to `ctx`, so unloading or reloading this plugin
 * removes the routes and a restarted plugin can claim the same paths again.
 *
 * @param ctx - context carrying `connection`; typically an `inject` child.
 * @param deps - live plugin state and write operations.
 */
export function installPlanUiRoutes(ctx: Context, deps: PlanUiDeps): void {
  const routes = createPlanUiRoutes(deps)
  const connection = ctx.connection
  ctx.effect(
    () =>
      connection.fetch.register({
        path: PLAN_UI_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: routes.snapshot,
      }),
    'kinship-plan-scheduler: plan snapshot route',
  )
  ctx.effect(
    () =>
      connection.fetch.register({
        path: PLAN_UI_OPS_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: routes.ops,
      }),
    'kinship-plan-scheduler: plan ops route',
  )
  ctx.effect(
    () =>
      connection.fetch.register({
        path: PLAN_UI_RECONCILE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: routes.reconcile,
      }),
    'kinship-plan-scheduler: plan reconcile route',
  )
  ctx.effect(
    () =>
      connection.fetch.register({
        path: PLAN_UI_SEED_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: routes.seed,
      }),
    'kinship-plan-scheduler: plan seed route',
  )
}
