/**
 * Registry-level acceptance for `kinship-isolation`.
 *
 * These cases run against the real dsh services (`SystemPrompt`, `ToolsService`,
 * the native executor and `dsh-scope`) instead of a fake context, because the
 * whole point of the plugin is how those registries merge scoped contributions:
 *
 * - a same-name scoped section shadows the host section for preset Agents only;
 * - a preset-scope `tools.restrict()` removes inherited host tools for those
 *   Agents and their subagents, while sibling presets keep them;
 * - a preset activated before the host plugin still isolates as tools appear;
 * - unloading the preset lifts both effects and clears the panel report.
 */

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolsService, defineTool } from '@deepseek-ai/dsh-tools'
import { apply as applyNative } from '@deepseek-ai/dsh-tool-executor-native'
import { createScope } from '@deepseek-ai/dsh-scope'
import { describe, expect, it } from 'vitest'
import { apply as applyIsolation } from '../../packages/kinship-isolation/src/index.js'
import type { IsolationReport } from '../../packages/kinship-isolation/src/index.js'

const MEMORY_SECTION = 'memory:index'
const MEMORY_TOOL_PREFIX = 'memory_'

interface Harness {
  readonly ctx: Context
  readonly reports: IsolationReport[]
  readonly cleared: string[]
  readonly presetScope: ReturnType<typeof createScope>
  readonly agentKey: object
  readonly assemblyText: () => Promise<string>
  readonly visibleTools: () => string[]
}

interface FakeBridge {
  reportIsolation(report: IsolationReport): void
  clearIsolation(instance: string): void
}

/** One real service composition with the panel bridge faked. */
async function compose(options: { withHost: boolean }): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolsService)
  await ctx.plugin({ name: 'native-tool-executor', inject: ['tools'], apply: applyNative })

  const reports: IsolationReport[] = []
  const cleared: string[] = []
  const bridge: FakeBridge = {
    reportIsolation: report => { reports.push(report) },
    clearIsolation: instance => { cleared.push(instance) },
  }
  ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide('kinshipBridge', bridge)

  const host = {
    name: 'host-mock-memory',
    inject: ['tools', 'systemPrompt'],
    apply(scoped: Context): void {
      scoped.systemPrompt.section({
        name: MEMORY_SECTION,
        order: 4_000,
        text: '<memory_context>HOST-MEMORY</memory_context>',
      })
      scoped.tools.register(defineTool({
        name: 'memory_write',
        description: 'Mock host memory writer.',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute(): Promise<string> {
          return 'ok'
        },
      }))
    },
  }

  if (options.withHost) await ctx.plugin(host)

  const presetKey = {}
  const presetScope = createScope(ctx, presetKey)
  const agentKey = {}
  createScope(presetScope.ctx, agentKey, { parent: presetKey })

  const isolation = {
    name: 'kinship-isolation-test',
    inject: ['tools', 'systemPrompt'],
    apply: (scoped: Context): void => {
      applyIsolation(scoped, {
        sections: [MEMORY_SECTION],
        toolPrefixes: [MEMORY_TOOL_PREFIX],
        presetId: 'kinship',
      })
    },
  }
  await presetScope.ctx.plugin(isolation)

  if (!options.withHost) await ctx.plugin(host)

  return {
    ctx,
    reports,
    cleared,
    presetScope,
    agentKey,
    assemblyText: async () => {
      const assembly = await ctx.systemPrompt.assemble({ scope: agentKey })
      return renderPrompt(assembly)
    },
    visibleTools: () => ctx.tools.schemas(agentKey).map(schema => schema.name).sort(),
  }
}

function lastReport(reports: readonly IsolationReport[]): IsolationReport {
  const report = reports.at(-1)
  if (report === undefined) throw new Error('the isolation plugin never reported')
  return report
}

describe('kinship-isolation over the real dsh registries', () => {
  it('shadows the host section and restricts matching host tools', async () => {
    const harness = await compose({ withHost: true })
    const text = await harness.assemblyText()
    expect(text).not.toContain('HOST-MEMORY')
    expect(harness.visibleTools()).not.toContain('memory_write')

    const report = lastReport(harness.reports)
    expect(report.schema).toBe(1)
    expect(report.active).toBe(true)
    expect(report.preset).toBe('kinship')
    expect(report.sections).toEqual([{ name: MEMORY_SECTION, shadowed: true }])
    expect(report.tools).toEqual([{ prefix: MEMORY_TOOL_PREFIX, denied: ['memory_write'], pending: false }])
    expect(report.errors).toEqual([])
    expect(report.instance.length).toBeGreaterThan(0)
  })

  it('isolates a preset activated before the host plugin registers its tools', async () => {
    const harness = await compose({ withHost: false })
    // The first report happens as soon as the panel bridge is available: the
    // prefix has no match yet, so it is pending rather than silently ignored.
    expect(harness.reports[0]?.tools).toEqual([{ prefix: MEMORY_TOOL_PREFIX, denied: [], pending: true }])

    const report = lastReport(harness.reports)
    expect(report.tools).toEqual([{ prefix: MEMORY_TOOL_PREFIX, denied: ['memory_write'], pending: false }])
    expect(await harness.assemblyText()).not.toContain('HOST-MEMORY')
    expect(harness.visibleTools()).not.toContain('memory_write')
  })

  it('leaves sibling presets untouched', async () => {
    const harness = await compose({ withHost: true })
    const otherPresetKey = {}
    const otherPreset = createScope(harness.ctx, otherPresetKey)
    const otherAgentKey = {}
    createScope(otherPreset.ctx, otherAgentKey, { parent: otherPresetKey })

    const assembly = await harness.ctx.systemPrompt.assemble({ scope: otherAgentKey })
    expect(renderPrompt(assembly)).toContain('HOST-MEMORY')
    expect(harness.ctx.tools.schemas(otherAgentKey).map(schema => schema.name)).toContain('memory_write')
  })

  it('lifts both effects and clears the report when the preset unloads', async () => {
    const harness = await compose({ withHost: true })
    const instance = lastReport(harness.reports).instance
    await harness.presetScope.dispose()

    expect(harness.cleared).toEqual([instance])
    expect(await harness.assemblyText()).toContain('HOST-MEMORY')
    expect(harness.visibleTools()).toContain('memory_write')
  })
})
