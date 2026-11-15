/**
 * `todowrite` compatibility alias.
 *
 * The dsh todo plugin registers `todo_write`; Loom/opencode prompts use
 * `todowrite`. The alias reuses the exact registered definition, so both names
 * append the same durable `todo/write` event.
 *
 * Preset children can mount concurrently, so `todo_write` may not exist yet
 * when this plugin applies. Registration therefore falls back to waiting on
 * `tools/change` and settles as soon as the target appears.
 *
 * @module kinship-task-compat/aliases
 */

import type { Context } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

export interface TodoWriteAliasRegistration {
  /** The mounted `todowrite` definition, or `undefined` while pending. */
  alias(): ToolDefinition | undefined
  /** True until `todo_write` becomes visible and the alias is registered. */
  pending(): boolean
  /** Stop waiting, unsubscribe `tools/change`, and unregister `todowrite`. */
  dispose(): void
}

function findTodoWrite(ctx: Context): ToolDefinition | undefined {
  const scope = scopeOf(ctx)
  return ctx.tools.get('todo_write', scope) ?? ctx.tools.get('todo_write')
}

function buildAlias(todo: ToolDefinition): ToolDefinition {
  return {
    ...todo,
    name: 'todowrite',
    description: `${todo.description}\n\nAlias of todo_write for Loom/opencode prompts.`,
  }
}

/**
 * Register `todowrite` over `todo_write`. When `todo_write` is not mounted yet,
 * wait for `tools/change` instead of failing the plugin apply.
 */
export function registerTodoWriteAlias(ctx: Context): TodoWriteAliasRegistration {
  let alias: ToolDefinition | undefined
  let unregister: (() => void) | undefined
  let off: (() => void) | undefined
  let registering = false

  const register = (todo: ToolDefinition): void => {
    const definition = buildAlias(todo)
    registering = true
    try {
      unregister = ctx.tools.register(definition)
    } catch (error) {
      throw new Error(
        `kinship-task-compat: could not register todowrite alias: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      registering = false
    }
    alias = definition
    const stop = off
    off = undefined
    stop?.()
  }

  const sync = (): void => {
    // `ctx.tools.register` emits `tools/change` synchronously, which re-enters
    // this listener before `alias` is assigned. Ignore that nested call.
    if (registering || alias !== undefined) return
    const todo = findTodoWrite(ctx)
    if (todo !== undefined) register(todo)
  }

  sync()
  if (alias === undefined) {
    off = ctx.on('tools/change', () => {
      sync()
    })
  }

  return {
    alias: () => alias,
    pending: () => alias === undefined,
    dispose: () => {
      const stop = off
      off = undefined
      stop?.()
      const unregisterAlias = unregister
      unregister = undefined
      alias = undefined
      unregisterAlias?.()
    },
  }
}
