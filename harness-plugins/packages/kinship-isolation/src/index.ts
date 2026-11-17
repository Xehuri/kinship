/**
 * Kinship preset isolation: keep host-level plugin contributions out of the
 * Kinship Session without touching the host configuration.
 *
 * The preset scope is the right mount point for this. Two dsh registries allow a
 * preset to subtract host contributions for its own Agents:
 *
 * - `systemPrompt.section()` merges scoped sections by name, so registering an
 *   empty section with the host section's name ({@link Config.sections}) shadows
 *   that section for every Agent under this preset.
 * - `tools.restrict()` masks inherited host tools in the calling scope, so
 *   denying the names that match {@link Config.toolPrefixes} removes those tools
 *   (schema, description and execution) from the same Agents and their subagents.
 *
 * `tools.restrict()` rejects names that are not registered yet, and a preset can
 * be activated before the host plugin that owns those tools. The plugin therefore
 * syncs on `tools/change` and denies names as they appear instead of assuming a
 * boot order. Results are reported to the sibling `kinship-bridge` service when
 * it is mounted, so the Kinship panel can show what was isolated and whether it
 * took effect.
 *
 * @module kinship-isolation
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** Result of shadowing one host prompt section. */
export interface IsolationSectionReport {
  /** Section name the preset registered an empty shadow for. */
  readonly name: string
  /** Always true: the report only contains sections that were registered. */
  readonly shadowed: boolean
}

/** Result of restricting host tools by name prefix. */
export interface IsolationToolsReport {
  /** Tool-name prefix this preset hides. */
  readonly prefix: string
  /** Host tool names already denied through `tools.restrict()`. */
  readonly denied: readonly string[]
  /** True when no tool matched the prefix yet (for example the host plugin is absent). */
  readonly pending: boolean
}

/**
 * Token-free isolation snapshot shared with the Kinship panel.
 *
 * The JSON shape is duplicated by `kinship-bridge` on purpose: the two packages
 * stay independently installable, mirroring how `kinship-tools` treats the
 * bridge service.
 */
export interface IsolationReport {
  /** Wire schema version. */
  readonly schema: 1
  /** Random identity of this plugin instance, used to scope the clear call. */
  readonly instance: string
  /** The preset is mounted and enforcing its rules. */
  readonly active: boolean
  /** Preset id this plugin was mounted for (`kinship` by default). */
  readonly preset: string
  /** Last sync time in epoch milliseconds. */
  readonly updatedAt: number
  readonly sections: readonly IsolationSectionReport[]
  readonly tools: readonly IsolationToolsReport[]
  /** Recent `tools.restrict()` failures, oldest first. */
  readonly errors: readonly string[]
}

/** The bridge surface this plugin uses; absent in compositions without a bridge. */
interface IsolationBridge {
  reportIsolation?(report: IsolationReport): void
  clearIsolation?(instance: string): void
}

/** Parsed plugin configuration. */
export interface Config {
  /** Host prompt section names to shadow with an empty scoped section. */
  sections: string[]
  /** Host tool-name prefixes to restrict out of this preset. */
  toolPrefixes: string[]
  /** Preset id reported to the panel. */
  presetId: string
}

/** Config schema shown by `dsh --dump-config-schema`. */
export const Config: z<Config> = z.object({
  sections: z.array(z.string()).default(['memory:index']).description(
    'Host prompt section names this preset shadows with an empty scoped section.',
  ),
  toolPrefixes: z.array(z.string()).default(['memory_']).description(
    'Host tool-name prefixes this preset hides with tools.restrict().',
  ),
  presetId: z.string().default('kinship').description(
    'Preset id reported to the Kinship panel.',
  ),
})

/** Stable Cordis plugin name. */
export const name = 'kinship-isolation'

/** The two registries a preset may subtract host contributions from. */
export const inject = ['tools', 'systemPrompt']

/** Keep the panel report bounded; the oldest failure is dropped first. */
const MAX_ERRORS = 5

/** Build one deniable report from the mutable sync state. */
function snapshot(
  instance: string,
  preset: string,
  sections: readonly IsolationSectionReport[],
  tools: readonly { prefix: string; denied: string[]; pending: boolean }[],
  errors: readonly string[],
): IsolationReport {
  return {
    schema: 1,
    instance,
    active: true,
    preset,
    updatedAt: Date.now(),
    sections: sections.map(section => ({ name: section.name, shadowed: section.shadowed })),
    tools: tools.map(tool => ({
      prefix: tool.prefix,
      denied: [...tool.denied],
      pending: tool.pending,
    })),
    errors: [...errors],
  }
}

/**
 * Shadow the configured sections and restrict matching host tools.
 *
 * `tools.restrict()` runs from the preset scope, so the restriction applies to
 * every Agent parented to this preset and to their subagents; sibling presets
 * and host Sessions keep their tools.
 *
 * @param ctx - preset scope context carrying `tools` and `systemPrompt`.
 * @param config - section names, tool prefixes, and the reported preset id.
 */
export function apply(ctx: Context, config: Config): void {
  const instance = randomUUID()

  /** Empty same-name sections shadow the host section after the registry merge. */
  const sectionReports: IsolationSectionReport[] = config.sections.map(sectionName => {
    ctx.systemPrompt.section({ name: sectionName, order: 4_000, text: '' })
    return { name: sectionName, shadowed: true }
  })

  const toolReports = config.toolPrefixes.map(prefix => ({
    prefix,
    denied: [] as string[],
    pending: true,
  }))
  const deniedNames = new Set<string>()
  const errors: string[] = []

  let bridge: IsolationBridge | null = null
  let publishedSignature = ''

  const publish = (force = false): void => {
    if (bridge === null) return
    const report = snapshot(instance, config.presetId, sectionReports, toolReports, errors)
    const signature = JSON.stringify({ ...report, updatedAt: 0 })
    if (!force && signature === publishedSignature) return
    publishedSignature = signature
    bridge.reportIsolation?.(report)
  }

  const recordError = (message: string): void => {
    if (errors.includes(message)) return
    errors.push(message)
    if (errors.length > MAX_ERRORS) errors.splice(0, errors.length - MAX_ERRORS)
  }

  /**
   * Deny every matching host tool that is not denied yet.
   *
   * The global view is intentional: `restrict()` only accepts inherited global
   * names, so a preset-local tool with the same prefix must not enter the list.
   */
  let syncing = false

  const sync = (): void => {
    // `tools.restrict()` emits `tools/change` while it runs; a re-entrant sync
    // would deny the same names again and duplicate the report.
    if (syncing) return
    syncing = true
    let changed = false
    try {
      const globalTools = ctx.tools.definitions()
      for (const report of toolReports) {
        const names = globalTools
          .map(definition => definition.name)
          .filter(toolName => toolName.startsWith(report.prefix) && !deniedNames.has(toolName))
        if (names.length === 0) continue
        // Mark before restricting: the registry emits `tools/change` from inside
        // the call, and the re-entrant sync must already see these names as done.
        for (const toolName of names) deniedNames.add(toolName)
        try {
          ctx.tools.restrict({ deny: names })
          for (const toolName of names) report.denied.push(toolName)
          report.pending = false
          changed = true
        } catch (error) {
          for (const toolName of names) deniedNames.delete(toolName)
          recordError(error instanceof Error ? error.message : String(error))
          changed = true
        }
      }
    } finally {
      syncing = false
    }
    if (changed) publish()
  }

  sync()

  // The host plugin that owns the tools may activate after this preset, so keep
  // denying names as they appear instead of relying on profile row order.
  ctx.on('tools/change', sync)

  ctx.inject(['kinshipBridge'], scoped => {
    const candidate = scoped.get('kinshipBridge') as IsolationBridge | undefined
    if (candidate === undefined) return
    bridge = candidate
    // Publish the current (possibly all-pending) state as soon as the panel can
    // read it; later syncs replace it in place.
    publish(true)
    scoped.effect(() => () => {
      bridge?.clearIsolation?.(instance)
      bridge = null
    }, 'kinship-isolation: bridge report')
  })
}
