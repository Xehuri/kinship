/**
 * MCP tool aliases.
 *
 * dsh names every MCP tool `mcp__<serverName>__<rawName>` (normalized to
 * `[A-Za-z0-9_-]`). Kinship prompts currently use Loom's single-underscore
 * names. This module registers thin aliases when the target definition is
 * visible; otherwise it reports the exact expected dsh names once and leaves
 * the alias absent instead of silently accepting an unknown tool.
 *
 * @module kinship-task-compat/mcp
 */

import type { Context } from '@deepseek-ai/cordis'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

export interface McpAlias {
  readonly alias: string
  readonly target: string
  readonly fallbackTargets: string[]
}

/** Loom name -> dsh public MCP name mappings for the prompts currently shipped. */
export const DEFAULT_MCP_ALIASES: readonly McpAlias[] = [
  {
    alias: 'mcp_ai_mcp_tts_speak',
    target: 'mcp__ai_mcp__tts_speak',
    fallbackTargets: ['mcp__ai-mcp__tts_speak'],
  },
  {
    alias: 'mcp_ai_mcp_send_notification',
    target: 'mcp__ai_mcp__send_notification',
    fallbackTargets: ['mcp__ai-mcp__send_notification'],
  },
  {
    alias: 'mcp_search_web_search',
    target: 'mcp__search__web_search',
    fallbackTargets: ['mcp__search-mcp__web_search'],
  },
]

export interface McpAliasRegistration {
  /** Alias names currently absent because no target definition is visible. */
  missing(): readonly string[]
  /** Remove every alias and the `tools/change` listener. */
  dispose(): void
}

function findTarget(
  ctx: Context,
  mapping: McpAlias,
): { readonly name: string; readonly definition: ToolDefinition } | undefined {
  const scope = scopeOf(ctx)
  for (const name of [mapping.target, ...mapping.fallbackTargets]) {
    const definition = ctx.tools.get(name, scope) ?? ctx.tools.get(name)
    if (definition !== undefined) return { name, definition }
  }
  return undefined
}

/**
 * Register and maintain the aliases. `tools/change` re-syncs so an MCP server
 * that connects after the preset still gets its alias.
 */
export function registerMcpAliases(
  ctx: Context,
  aliases: readonly McpAlias[],
): McpAliasRegistration {
  const registrations = new Map<string, {
    readonly target: string
    readonly definition: ToolDefinition
    readonly dispose: () => void
  }>()
  const missing = new Set<string>()

  const sync = (): void => {
    for (const mapping of aliases) {
      const found = findTarget(ctx, mapping)
      const existing = registrations.get(mapping.alias)

      if (found === undefined) {
        if (existing !== undefined) {
          existing.dispose()
          registrations.delete(mapping.alias)
        }
        if (!missing.has(mapping.alias)) {
          missing.add(mapping.alias)
          ctx.logger.info(
            'kinship-task-compat: MCP alias %s is absent; expected dsh name one of: %s',
            mapping.alias,
            [mapping.target, ...mapping.fallbackTargets].join(', '),
          )
        }
        continue
      }

      missing.delete(mapping.alias)
      if (
        existing !== undefined
        && existing.target === found.name
        && existing.definition === found.definition
      ) {
        continue
      }
      if (existing !== undefined) {
        existing.dispose()
        registrations.delete(mapping.alias)
      }

      const aliasDefinition: ToolDefinition = {
        ...found.definition,
        name: mapping.alias,
        description: `${found.definition.description}\n\nAlias of dsh MCP tool ${found.name}.`,
      }
      try {
        const dispose = ctx.tools.register(aliasDefinition)
        registrations.set(mapping.alias, {
          target: found.name,
          definition: found.definition,
          dispose,
        })
      } catch (error) {
        ctx.logger.warn(
          'kinship-task-compat: could not register MCP alias %s: %s',
          mapping.alias,
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }

  const off = ctx.on('tools/change', () => {
    sync()
  })
  sync()

  return {
    missing: () => [...missing],
    dispose: () => {
      off()
      for (const registration of registrations.values()) registration.dispose()
      registrations.clear()
    },
  }
}
