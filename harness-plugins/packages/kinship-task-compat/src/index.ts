/**
 * Kinship compatibility tools for dsh presets.
 *
 * Registers `task` (both Loom and opencode input shapes), `todowrite` (alias of
 * `todo_write`), and optional MCP aliases. The `todowrite` alias is deferred
 * until `tools/change` reports `todo_write` when the todo plugin mounts after
 * this plugin. The preset must provide `ctx.subagents`.
 *
 * @module kinship-task-compat
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subagent'
import z from '@deepseek-ai/schemastery'
import { registerTodoWriteAlias } from './aliases.js'
import { DEFAULT_MCP_ALIASES, registerMcpAliases, type McpAlias } from './mcp.js'
import { createTaskToolDefinition, type TaskDelegation } from './task.js'

export interface Config {
  provider: string
  mcpAliases: McpAlias[]
}

const McpAliasSchema = z.object({
  alias: z.string(),
  target: z.string(),
  fallbackTargets: z.array(z.string()).default([]),
})

export const Config: z<Config> = z.object({
  provider: z.string().default('spawn').description('dsh subagent provider used by the task tool.'),
  mcpAliases: z.array(McpAliasSchema).default([...DEFAULT_MCP_ALIASES]).description('Loom -> dsh MCP alias table; set [] to disable.'),
})

export const name = 'kinship-task-compat'
export const inject = ['tools', 'subagents']

export function apply(ctx: Context, config: Config): void {
  const delegation: TaskDelegation = {
    provider: config.provider,
    start: request => ctx.subagents.startActivation(request),
    resolveMaxDepth: () => ctx.subagents.resolveMaxDepth(),
  }

  ctx.tools.register(createTaskToolDefinition(delegation))
  const todo = registerTodoWriteAlias(ctx)
  const mcp = registerMcpAliases(ctx, config.mcpAliases)
  ctx.effect(() => () => todo.dispose(), 'kinship-task-compat todowrite alias')
  ctx.effect(() => () => mcp.dispose(), 'kinship-task-compat MCP aliases')

  const absent = mcp.missing()
  ctx.logger.info(
    'kinship-task-compat: task registered; todowrite %s; MCP aliases absent=%s',
    todo.pending() ? 'may be pending until todo_write mounts' : 'registered',
    absent.length === 0 ? 'none' : absent.join(', '),
  )
}
