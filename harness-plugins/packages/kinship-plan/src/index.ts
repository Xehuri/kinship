/**
 * Simplified Kinship daily-plan plugin.
 *
 * Root resolution is explicit and never silently guessed:
 * 1. `config.root`
 * 2. `KINSHIP_PLAN_ROOT`
 * 3. `KINSHIP_AI_ROOT/data` (the existing Kinship plan data root)
 *
 * With none of these, plugin activation fails with a validation error.
 *
 * @module kinship-plan
 */

import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { PlanValidationError } from './schema.js'
import { PlanStore } from './store.js'
import { createPlanToolDefinitions } from './tools.js'

export interface Config {
  root: string
  timezone: string
  allowOverlayShadow: boolean
}

export const Config: z<Config> = z.object({
  root: z.string().default('').description('Absolute plan root; empty falls back to KINSHIP_PLAN_ROOT, then KINSHIP_AI_ROOT/data.'),
  timezone: z.string().default('Asia/Shanghai').description('IANA time zone used when a tool omits date.'),
  allowOverlayShadow: z.boolean().default(false).description('Allow writing plan-{date}.json beside an existing plan-{date}.overlay.json.'),
})

export const name = 'kinship-plan'
export const inject = ['tools']

/** Resolve the plan root from config and environment, refusing every guess. */
export function resolvePlanRoot(config: Config): string {
  const aiRoot = (process.env['KINSHIP_AI_ROOT'] ?? '').trim()
  const candidates = [
    config.root.trim(),
    (process.env['KINSHIP_PLAN_ROOT'] ?? '').trim(),
    ...(aiRoot === '' ? [] : [join(aiRoot, 'data')]),
  ]
  const root = candidates.find(candidate => candidate !== '')
  if (root === undefined) {
    throw new PlanValidationError(
      'root',
      'is required: set config.root, KINSHIP_PLAN_ROOT, or KINSHIP_AI_ROOT',
    )
  }
  if (!isAbsolute(root)) {
    throw new PlanValidationError('root', `must be an absolute path: ${root}`)
  }
  return root
}

/** Build the store used by the tools. */
export function createPlanStore(config: Config): PlanStore {
  return new PlanStore({
    root: resolvePlanRoot(config),
    timezone: config.timezone,
    allowOverlayShadow: config.allowOverlayShadow,
  })
}

/** Mount `plan_read`, `plan_commit`, `plan_note`, `plan_done`, `plan_close`, and `plan`. */
export function apply(ctx: Context, config: Config): void {
  const store = createPlanStore(config)
  for (const tool of createPlanToolDefinitions(store)) {
    ctx.tools.register(tool)
  }
  ctx.logger.info('kinship-plan: root %s (timezone=%s)', store.rootPath(), store.timeZone())
}
