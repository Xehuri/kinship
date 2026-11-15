/**
 * Plugin configuration and root resolution for the host-level plan scheduler.
 *
 * The scheduler never guesses a data root: `planRoot` must resolve to an
 * absolute path from the plugin row, `KINSHIP_PLAN_ROOT`, or the `data` folder
 * of `KINSHIP_AI_ROOT`. When none applies the plugin stays mounted (so the
 * Kinship panel can explain why) but the engine is not started.
 *
 * Ported engine modules and their stores all reject relative roots, so this
 * layer is the single place where a relative path turns into a `problem`
 * instead of a thrown error.
 *
 * @module kinship-plan-scheduler/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Parsed plugin configuration. */
export interface Config {
  /** Absolute plan root; empty falls back to the environment chain. */
  planRoot: string
  /** Absolute scheduler-state root (wake queue, shadow files); empty uses DSH_HOME. */
  stateDir: string
  mode: 'live' | 'shadow' | 'off'
  /** IANA timezone used before a master document supplies its own. */
  timezone: string
  /** Daily reconcile anchors, strictly `HH:MM`. */
  anchors: string[]
  /** Watchdog interval in milliseconds; 0 disables it. */
  watchdogMs: number
  horizonHours: number
  catchupMaxAgeHours: number
  debtAfterHours: number
}

/** Config schema shown by `dsh --dump-config-schema`. */
export const Config: z<Config> = z.object({
  planRoot: z.string().default('').description('Absolute plan root; empty falls back to KINSHIP_PLAN_ROOT, then KINSHIP_AI_ROOT/data.'),
  stateDir: z.string().default('').description('Absolute scheduler-state root; empty uses $DSH_HOME/kinship/state.'),
  mode: z
    .union([z.const('live' as const), z.const('shadow' as const), z.const('off' as const)])
    .default('live')
    .description('live reconciles and delivers; shadow only writes shadow files; off skips the engine.'),
  timezone: z.string().default('Asia/Shanghai').description('IANA timezone used before the master document supplies one.'),
  anchors: z.array(z.string()).default(['05:00', '07:30']).description('Daily reconcile anchors, strictly HH:MM.'),
  watchdogMs: z.number().step(1).min(0).default(60_000).description('Watchdog interval in milliseconds; 0 disables it.'),
  horizonHours: z.number().step(1).min(1).default(48).description('How far ahead slots are materialized.'),
  catchupMaxAgeHours: z.number().step(1).min(0).default(8).description('Late slots younger than this are still delivered.'),
  debtAfterHours: z.number().step(1).min(1).default(24).description('Slots older than this are skipped as debt.'),
})

/** Stable Cordis plugin name. */
export const name = 'kinship-plan-scheduler'

/** The live agent registry is the only required host service. */
export const inject = ['agents']

/** Resolved roots plus the reason the plan root is unusable, if any. */
export interface PlanRoots {
  /** Absolute plan root, or null when the scheduler must stay disabled. */
  readonly planRoot: string | null
  /** Absolute scheduler-state root. */
  readonly stateDir: string
  /** Human sentence for the panel when `planRoot` is null. */
  readonly problem: string | null
}

function nonEmpty(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** `$DSH_HOME`, or `~/.dsh` when it is unset or blank. */
function harnessHome(): string {
  const home = nonEmpty(process.env['DSH_HOME'])
  return home === '' ? join(homedir(), '.dsh') : home
}

/**
 * Resolve the plan root and the scheduler-state root.
 *
 * Precedence for the plan root: `config.planRoot` > `KINSHIP_PLAN_ROOT` >
 * `KINSHIP_AI_ROOT/data`. A relative candidate is refused with a problem
 * message rather than resolved against the process working directory, because
 * a wrong root silently points the scheduler at an unrelated plan tree.
 *
 * @param config - validated plugin configuration.
 * @returns absolute roots, or a null plan root with the panel-facing problem.
 */
export function resolveRoots(config: Config): PlanRoots {
  const configuredStateDir = nonEmpty(config.stateDir)
  const stateDir = resolve(
    configuredStateDir === '' ? join(harnessHome(), 'kinship', 'state') : configuredStateDir,
  )

  const configured = nonEmpty(config.planRoot)
  const fromEnv = configured === '' ? nonEmpty(process.env['KINSHIP_PLAN_ROOT']) : configured
  const aiRoot = nonEmpty(process.env['KINSHIP_AI_ROOT'])
  const candidate = fromEnv !== '' ? fromEnv : aiRoot === '' ? '' : join(aiRoot, 'data')

  if (candidate === '') {
    return {
      planRoot: null,
      stateDir,
      problem: 'planRoot 未配置：请设置插件 planRoot、KINSHIP_PLAN_ROOT 或 KINSHIP_AI_ROOT。',
    }
  }
  if (!isAbsolute(candidate)) {
    return {
      planRoot: null,
      stateDir,
      problem: `planRoot 必须是绝对路径（收到 ${candidate}）。`,
    }
  }
  return { planRoot: resolve(candidate), stateDir, problem: null }
}
