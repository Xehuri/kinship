/**
 * Pure projections of the two scheduling knobs the master plan now owns.
 *
 * The operator configures no anchors or timezone on the dsh side once a master
 * plan exists: the master document is the schedule's source of truth, so its
 * `timezone` and its daily `plan.build`/`plan.review` slots decide when the
 * scheduler reconciles. The plugin row stays as an override for deployments
 * without a master (a fresh install) and for tests.
 *
 * Both helpers are pure and total: they never throw and they never return an
 * empty anchor list, because `PlanScheduler` refuses an empty one.
 *
 * @module kinship-plan-scheduler/plan-profile
 */

import type { MasterEntry, MasterPlanDocument } from './plan/master-plan.js'

/** Where the effective anchors came from; the panel shows it. */
export type AnchorsSource = 'config' | 'master' | 'default'

/** Anchors used when neither the plugin row nor the master supplies any. */
export const DEFAULT_PLAN_ANCHORS: readonly string[] = ['05:00', '07:30']

/** Master actions whose daily slots are the reconcile anchors. */
const ANCHOR_ACTIONS: ReadonlySet<string> = new Set(['plan.build', 'plan.review'])

/** One derivation result: the clocks plus their provenance. */
export interface DerivedAnchors {
  readonly anchors: readonly string[]
  readonly source: AnchorsSource
}

function clockOf(entry: MasterEntry): string | null {
  const schedule = entry.schedule
  if (schedule.kind !== 'daily') return null
  return schedule.at
}

/**
 * Derive the reconcile anchors.
 *
 * Precedence: an explicit plugin-row list wins (so a deployment keeps its
 * hand-written slots), then the master's daily plan slots, then the historical
 * default pair. Duplicate clocks collapse; the result is sorted so the panel and
 * the scheduler see one stable order.
 *
 * @param master - parsed master document, or null while none is readable.
 * @param configAnchors - `config.anchors`; an empty list means "derive".
 * @returns the anchors to schedule with, plus their provenance.
 */
export function deriveAnchors(
  master: MasterPlanDocument | null,
  configAnchors: readonly string[],
): DerivedAnchors {
  const configured = configAnchors.filter(clock => typeof clock === 'string' && clock.trim() !== '')
  if (configured.length > 0) return { anchors: [...configured], source: 'config' }

  const clocks = new Set<string>()
  for (const entry of master?.entries ?? []) {
    const action = entry.action
    if (action === undefined || !ANCHOR_ACTIONS.has(action)) continue
    const clock = clockOf(entry)
    if (clock !== null) clocks.add(clock)
  }
  if (clocks.size > 0) return { anchors: [...clocks].sort(), source: 'master' }
  return { anchors: [...DEFAULT_PLAN_ANCHORS], source: 'default' }
}

/**
 * Effective scheduler timezone.
 *
 * The master wins because every slot in it is expressed in that zone; the plugin
 * row only covers the window before a master exists.
 *
 * @param master - parsed master document, or null while none is readable.
 * @param configTimezone - `config.timezone`.
 * @returns the IANA zone the scheduler should run in.
 */
export function selectTimezone(master: MasterPlanDocument | null, configTimezone: string): string {
  const fromMaster = typeof master?.timezone === 'string' ? master.timezone.trim() : ''
  if (fromMaster !== '') return fromMaster
  const fromConfig = typeof configTimezone === 'string' ? configTimezone.trim() : ''
  return fromConfig === '' ? 'Asia/Shanghai' : fromConfig
}
