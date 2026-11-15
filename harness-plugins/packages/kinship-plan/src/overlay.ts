/**
 * Overlay write-back for the daily plan tools (master + overlay model).
 *
 * dsh can run beside Loom's plan layout: the master
 * (`{planRoot}/plan/master.json`) holds the persistent schedule and the day's
 * overlay (`{planRoot}/daily/{date}/plan-{date}.overlay.json`) holds only the
 * diff. When the v1 `plan-{date}.json` truth file cannot serve (missing, closed,
 * or without the requested item) the plan tools write the day's overlay instead
 * of inventing a v1 file beside it.
 *
 * The write semantics are the ones Loom's `plan-overlay-tool.ts` established:
 * one op per id, merge into an existing add/update, refuse updating an id the
 * overlay removed, CAS on the overlay version, and one ledger row per mutation.
 * This module owns only the master/overlay/ledger wiring; it never touches the
 * v1 truth file and never writes the master.
 *
 * @module kinship-plan/overlay
 */

// allow: SIZE_OK — one write-back state machine: creation, op merging, CAS, and the ledger must stay in lockstep.

import { JsonMasterPlanStore } from 'kinship-plan-scheduler/plan/json-master-plan-store'
import { JsonPlanOverlayStore } from 'kinship-plan-scheduler/plan/json-plan-overlay-store'
import {
  MasterPlanNotFoundError,
  materializeMasterEntries,
  type MasterEntry,
  type MasterPlanDocument,
} from 'kinship-plan-scheduler/plan/master-plan'
import { PlanLedger } from 'kinship-plan-scheduler/plan/plan-ledger'
import {
  PlanOverlayConflictError,
  PlanOverlayNotFoundError,
  PlanOverlayValidationError,
  mergeOverlay,
  requireOverlayDate,
  type EffectivePlanEntry,
  type PlanOverlayDocument,
  type PlanOverlayItem,
  type PlanOverlayOp,
  type PlanOverlayPatch,
} from 'kinship-plan-scheduler/plan/plan-overlay'
import type { PlanCoverage } from 'kinship-plan-scheduler/plan/plan-store'
import { PlanValidationError, type PlanDoneStatus } from './schema.js'

export interface OverlayPlanSupportOptions {
  /** Test clock; defaults to `Date.now`. */
  readonly now?: () => number
}

/** One effective entry projected for the model. */
export interface OverlayEntryView {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly action?: string
  readonly status: string
  readonly at?: string
}

export interface OverlayEffectiveView {
  readonly source: 'overlay' | 'master'
  readonly date: string
  readonly overlayVersion: number | null
  readonly overlayStatus: string | null
  readonly entries: readonly OverlayEntryView[]
}

export interface OverlayNoteResult {
  readonly overlayVersion: number
  readonly noteCount: number
}

export interface OverlayDoneInput {
  readonly date: string
  readonly id: string
  readonly status?: PlanDoneStatus
  readonly evidence?: string
  /** Caller CAS expectation; when present it must equal the current overlay version. */
  readonly expectedVersion?: number
}

export interface OverlayDoneResult {
  readonly overlayVersion: number
  readonly status: string
}

/** The write-back surface the plan tools consume. */
export interface OverlayPlanSupport {
  readEffective(date: string): Promise<OverlayEffectiveView>
  note(date: string, text: string): Promise<OverlayNoteResult>
  done(input: OverlayDoneInput): Promise<OverlayDoneResult>
}

/** An overlay write/can't-read needs the master plan, and none exists. */
export class PlanMasterRequiredError extends Error {
  readonly path: string

  constructor(operation: string, path: string) {
    super(
      `[plan:overlay] master plan is required for ${operation}; the v1 fallback cannot create an overlay without it: ${path}`,
    )
    this.name = 'PlanMasterRequiredError'
    this.path = path
  }
}

/** The requested id is absent from the effective plan or removed by an op. */
export class PlanOverlayItemUnavailableError extends Error {
  readonly date: string
  readonly itemId: string

  constructor(date: string, itemId: string, reason: string) {
    super(`[plan:overlay] date ${date} item ${itemId}: ${reason}`)
    this.name = 'PlanOverlayItemUnavailableError'
    this.date = date
    this.itemId = itemId
  }
}

function clockMillis(now: () => number): number {
  const at = now()
  if (!Number.isInteger(at) || at < 0) {
    throw new PlanOverlayValidationError(
      'now',
      `clock must return a non-negative integer millisecond timestamp: ${String(at)}`,
    )
  }
  return at
}

function opTargetId(op: PlanOverlayOp): string | null {
  switch (op.op) {
    case 'add':
      return op.item.id
    case 'update':
    case 'remove':
      return op.id
    case 'note':
      return null
  }
}

/** Apply `patch` onto an overlay-add item without dropping untouched fields. */
function applyItemPatch(item: PlanOverlayItem, patch: PlanOverlayPatch): PlanOverlayItem {
  const next: Record<string, unknown> = { ...item }
  for (const key of Object.keys(patch) as (keyof PlanOverlayPatch)[]) {
    const value = patch[key]
    if (value === null) {
      delete next[key]
      continue
    }
    if (value !== undefined) next[key] = value
  }
  return next as unknown as PlanOverlayItem
}

function mergePatch(base: PlanOverlayPatch, patch: PlanOverlayPatch): PlanOverlayPatch {
  return { ...base, ...patch }
}

/**
 * Write one entry update into `ops` while keeping the "at most one op per id"
 * invariant: an existing add is patched in place, an existing update is merged,
 * and an id the day already removed is refused.
 */
function upsertEntryPatch(
  ops: readonly PlanOverlayOp[],
  id: string,
  patch: PlanOverlayPatch,
): readonly PlanOverlayOp[] {
  const index = ops.findIndex(op => opTargetId(op) === id)
  if (index === -1) return [...ops, { op: 'update', id, patch }]
  const existing = ops[index]
  if (existing === undefined) return [...ops, { op: 'update', id, patch }]
  const next = [...ops]
  switch (existing.op) {
    case 'add':
      next[index] = { op: 'add', item: applyItemPatch(existing.item, patch) }
      return next
    case 'update':
      next[index] = { op: 'update', id, patch: mergePatch(existing.patch, patch) }
      return next
    case 'remove':
      throw new PlanOverlayValidationError(
        `ops.${id}`,
        '条目已被当日覆盖层移除，不能更新',
      )
    case 'note':
      return [...ops, { op: 'update', id, patch }]
  }
}

function masterEntryView(entry: MasterEntry): OverlayEntryView {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    ...(entry.action === undefined ? {} : { action: entry.action }),
    status: 'planned',
    at: entry.schedule.at,
  }
}

function effectiveEntryView(entry: EffectivePlanEntry): OverlayEntryView {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title ?? entry.intent ?? '',
    ...(entry.action === undefined ? {} : { action: entry.action }),
    status: entry.status,
    ...(entry.at === undefined ? {} : { at: entry.at }),
  }
}

/** The overlay schema requires at least one checkpoint; a master needs anchors. */
function overlayCoverage(master: MasterPlanDocument): PlanCoverage {
  const checkpoints = master.entries
    .filter(entry => entry.kind === 'anchor')
    .map(entry => entry.id)
    .sort()
  return { profile: 'merged_7', checkpoints, debt: [] }
}

interface EnsuredOverlay {
  readonly overlay: PlanOverlayDocument
  readonly created: boolean
}

/**
 * Build the master/overlay/ledger-backed write-back support for one plan root.
 * The root is always explicit and never guessed here.
 */
export function createOverlayPlanSupport(
  planRoot: string,
  options: OverlayPlanSupportOptions = {},
): OverlayPlanSupport {
  const now = options.now ?? Date.now
  const masterStore = new JsonMasterPlanStore({ planRoot, now })
  const overlayStore = new JsonPlanOverlayStore({ planRoot, master: masterStore, now })
  const ledger = new PlanLedger({ planRoot, now })

  async function readMaster(operation: string): Promise<MasterPlanDocument> {
    try {
      return await masterStore.read()
    } catch (error) {
      if (error instanceof MasterPlanNotFoundError) {
        throw new PlanMasterRequiredError(operation, masterStore.paths().json)
      }
      throw error
    }
  }

  async function readOverlayOrNull(day: string): Promise<PlanOverlayDocument | null> {
    try {
      return await overlayStore.read(day)
    } catch (error) {
      if (error instanceof PlanOverlayNotFoundError) return null
      throw error
    }
  }

  /**
   * Return the day's overlay, creating version 1 over the current master when
   * it is missing. `initialNotes` rides along on creation so a first note lands
   * in version 1 instead of costing a second revision.
   */
  async function ensureOverlay(
    day: string,
    initialNotes: readonly string[] = [],
  ): Promise<EnsuredOverlay> {
    const existing = await readOverlayOrNull(day)
    if (existing !== null) return { overlay: existing, created: false }
    const master = await readMaster('overlay write-back')
    try {
      const overlay = await overlayStore.write({
        date: day,
        base_version: master.version,
        ops: [],
        coverage: overlayCoverage(master),
        notes: initialNotes,
      })
      return { overlay, created: true }
    } catch (error) {
      if (error instanceof PlanOverlayConflictError) {
        // Another process created it between our read and our write; adopt it.
        return { overlay: await overlayStore.read(day), created: false }
      }
      throw error
    }
  }

  async function readEffective(date: string): Promise<OverlayEffectiveView> {
    const day = requireOverlayDate(date)
    const overlay = await readOverlayOrNull(day)
    const master = await readMaster('plan_overlay_read')
    if (overlay === null) {
      return {
        source: 'master',
        date: day,
        overlayVersion: null,
        overlayStatus: null,
        entries: materializeMasterEntries(master, day).map(masterEntryView),
      }
    }
    const effective = mergeOverlay(master, overlay, day)
    return {
      source: 'overlay',
      date: day,
      overlayVersion: overlay.version,
      overlayStatus: overlay.status,
      entries: effective.entries.filter(entry => !entry.suppressed).map(effectiveEntryView),
    }
  }

  async function note(date: string, text: string): Promise<OverlayNoteResult> {
    const day = requireOverlayDate(date)
    const trimmed = text.trim()
    if (trimmed === '') throw new PlanValidationError('note', 'must be a non-empty string')
    const ensured = await ensureOverlay(day, [trimmed])
    const overlay = ensured.created
      ? ensured.overlay
      : await overlayStore.revise(day, ensured.overlay.version, { notes_append: [trimmed] })
    await ledger.append({
      date: day,
      source: 'plan',
      event: 'note',
      version: overlay.version,
      reason: trimmed,
    })
    return { overlayVersion: overlay.version, noteCount: overlay.notes.length }
  }

  async function done(input: OverlayDoneInput): Promise<OverlayDoneResult> {
    const day = requireOverlayDate(input.date)
    const status: PlanDoneStatus = input.status ?? 'done'
    const ensured = await ensureOverlay(day)
    const master = await readMaster('overlay write-back')
    const effective = mergeOverlay(master, ensured.overlay, day)
    const entry = effective.entries.find(candidate => candidate.id === input.id)
    if (entry === undefined) {
      throw new PlanOverlayItemUnavailableError(
        day,
        input.id,
        'not in the effective plan; plan_overlay_read lists the available ids',
      )
    }
    if (entry.suppressed) {
      throw new PlanOverlayItemUnavailableError(
        day,
        input.id,
        'removed by a remove op in the day overlay',
      )
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== ensured.overlay.version) {
      throw new PlanOverlayConflictError(day, input.expectedVersion, ensured.overlay.version)
    }
    const patch: PlanOverlayPatch = {
      status,
      ...(input.evidence === undefined || input.evidence.trim() === ''
        ? {}
        : { evidence: input.evidence }),
      ...(status === 'done' ? { done_at: new Date(clockMillis(now)).toISOString() } : {}),
    }
    const ops = upsertEntryPatch(ensured.overlay.ops, input.id, patch)
    const revised = await overlayStore.revise(day, ensured.overlay.version, { ops })
    await ledger.append({
      date: day,
      source: 'plan',
      event: 'done',
      entry_id: input.id,
      status,
      version: revised.version,
    })
    return { overlayVersion: revised.version, status }
  }

  return { readEffective, note, done }
}
