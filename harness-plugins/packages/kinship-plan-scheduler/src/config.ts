/**
 * Plugin configuration and root resolution for the host-level plan scheduler.
 *
 * The operator configures no paths on the dsh side: `kinship-bridge` persists
 * the Kinship backend's canonical paths as `$DSH_HOME/kinship/paths.json` after
 * every accepted push, and that document's `plan_root` is the scheduler's first
 * choice. The plugin row, `KINSHIP_PLAN_ROOT` and `KINSHIP_AI_ROOT` remain as
 * fallbacks so a deployment without a bridge still works.
 *
 * A candidate is refused when it is relative, because resolving it against the
 * process working directory silently points the scheduler at an unrelated plan
 * tree. A refused candidate falls through to the next one; the reason is only
 * reported when nothing resolves, so one stale override cannot mask a root the
 * backend pushed.
 *
 * @module kinship-plan-scheduler/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { PushedPaths } from './pushed-paths.js'

/** Parsed plugin configuration. */
export interface Config {
  /** Absolute plan root override; empty defers to the pushed document and env. */
  planRoot: string
  /** Absolute scheduler-state root (wake queue, shadow files); empty uses DSH_HOME. */
  stateDir: string
  mode: 'live' | 'shadow' | 'off'
  /** IANA timezone used before a master document supplies its own. */
  timezone: string
  /** Daily reconcile anchors, strictly `HH:MM`; empty derives them from the master. */
  anchors: string[]
  /** Watchdog interval in milliseconds; 0 disables it. */
  watchdogMs: number
  horizonHours: number
  catchupMaxAgeHours: number
  debtAfterHours: number
}

/** Config schema shown by `dsh --dump-config-schema`. */
export const Config: z<Config> = z.object({
  planRoot: z.string().default('').description('Absolute plan root override; empty defers to the paths the Kinship backend pushed, then KINSHIP_PLAN_ROOT, then KINSHIP_AI_ROOT/data.'),
  stateDir: z.string().default('').description('Absolute scheduler-state root; empty uses $DSH_HOME/kinship/state.'),
  mode: z
    .union([z.const('live' as const), z.const('shadow' as const), z.const('off' as const)])
    .default('live')
    .description('live reconciles and delivers; shadow only writes shadow files; off skips the engine.'),
  timezone: z.string().default('Asia/Shanghai').description('IANA timezone used before the master document supplies one.'),
  anchors: z.array(z.string()).default([]).description('Daily reconcile anchors, strictly HH:MM; empty derives them from the master plan.'),
  watchdogMs: z.number().step(1).min(0).default(60_000).description('Watchdog interval in milliseconds; 0 disables it.'),
  horizonHours: z.number().step(1).min(1).default(48).description('How far ahead slots are materialized.'),
  catchupMaxAgeHours: z.number().step(1).min(0).default(8).description('Late slots younger than this are still delivered.'),
  debtAfterHours: z.number().step(1).min(1).default(24).description('Slots older than this are skipped as debt.'),
})

/** Stable Cordis plugin name. */
export const name = 'kinship-plan-scheduler'

/** The live agent registry is the only required host service. */
export const inject = ['agents']

/** Which candidate supplied the plan root; the panel renders it. */
export type PlanRootSource = 'pushed' | 'config' | 'env' | 'default'

/** Resolved roots plus the reason the plan root is unusable, if any. */
export interface PlanRoots {
  /** Absolute plan root, or null when the scheduler must stay disabled. */
  readonly planRoot: string | null
  /** Absolute scheduler-state root. */
  readonly stateDir: string
  /** Human sentence for the panel when `planRoot` is null. */
  readonly problem: string | null
  /** Which candidate resolved, or null while none did. */
  readonly source: PlanRootSource | null
  /** The accepted pushed document, when one was supplied. */
  readonly pushed: PushedPaths | null
  /** Why the supplied pushed document was unusable, if it was. */
  readonly pushedProblem: string | null
}

function nonEmpty(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** `$DSH_HOME`, or `~/.dsh` when it is unset or blank. */
function harnessHome(): string {
  const home = nonEmpty(process.env['DSH_HOME'])
  return home === '' ? join(homedir(), '.dsh') : home
}

/** One root candidate in precedence order. */
interface RootCandidate {
  readonly source: PlanRootSource
  readonly value: string
}

/**
 * Resolve the plan root and the scheduler-state root.
 *
 * Precedence for the plan root: the pushed document's `plan_root` >
 * `config.planRoot` > `KINSHIP_PLAN_ROOT` > `KINSHIP_AI_ROOT/data`. A relative
 * candidate is refused and the next candidate is tried, so a stale override
 * cannot hide a root the backend pushed; the refusal is only reported when
 * nothing resolves.
 *
 * The function is synchronous and pure: `index.ts` supplies the result of
 * `readPushedPaths()` so this layer never touches the disk.
 *
 * @param config - validated plugin configuration.
 * @param pushed - accepted pushed-path document, or null when none is usable.
 * @returns absolute roots with their provenance, or a null plan root and the
 * panel-facing problem.
 */
export function resolveRoots(config: Config, pushed: PushedPaths | null = null): PlanRoots {
  const configuredStateDir = nonEmpty(config.stateDir)
  const stateDir = resolve(
    configuredStateDir === '' ? join(harnessHome(), 'kinship', 'state') : configuredStateDir,
  )
  const pushedPaths = pushed ?? null
  const aiRoot = nonEmpty(process.env['KINSHIP_AI_ROOT'])
  const candidates: readonly RootCandidate[] = [
    { source: 'pushed', value: pushedPaths === null ? '' : nonEmpty(pushedPaths.plan_root) },
    { source: 'config', value: nonEmpty(config.planRoot) },
    { source: 'env', value: nonEmpty(process.env['KINSHIP_PLAN_ROOT']) },
    { source: 'default', value: aiRoot === '' ? '' : join(aiRoot, 'data') },
  ]

  const rejected: RootCandidate[] = []
  for (const candidate of candidates) {
    if (candidate.value === '') continue
    if (!isAbsolute(candidate.value)) {
      rejected.push(candidate)
      continue
    }
    return {
      planRoot: resolve(candidate.value),
      stateDir,
      problem: null,
      source: candidate.source,
      pushed: pushedPaths,
      pushedProblem: null,
    }
  }

  const first = rejected[0]
  const problem =
    first === undefined
      ? 'planRoot 未配置：等待 kinship 后端推送 paths.json，或设置插件 planRoot、KINSHIP_PLAN_ROOT、KINSHIP_AI_ROOT。'
      : `planRoot 必须是绝对路径（收到 ${first.value}）。`
  const refusedPush = rejected.find(candidate => candidate.source === 'pushed')
  return {
    planRoot: null,
    stateDir,
    problem,
    source: null,
    pushed: pushedPaths,
    pushedProblem:
      refusedPush === undefined ? null : `plan_root 必须是绝对路径（收到 ${refusedPush.value}）。`,
  }
}
