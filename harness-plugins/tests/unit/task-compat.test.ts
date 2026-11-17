import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { registerTodoWriteAlias } from '../../packages/kinship-task-compat/src/aliases.js'
import {
  DEFAULT_MCP_ALIASES,
  registerMcpAliases,
} from '../../packages/kinship-task-compat/src/mcp.js'
import {
  buildTaskLabel,
  buildTaskPrompt,
  createTaskToolDefinition,
  ignoredTaskFields,
  startTask,
  type TaskDelegation,
  type TaskDelegationRequest,
  type TaskToolArgs,
} from '../../packages/kinship-task-compat/src/task.js'
import { TestAgent } from '../helpers/fake-agent.js'

class FakeTools {
  readonly definitions = new Map<string, ToolDefinition>()
  readonly registered: ToolDefinition[] = []
  onRegister?: (definition: ToolDefinition) => void

  get(name: string, _scope?: unknown): ToolDefinition | undefined {
    return this.definitions.get(name)
  }

  register(definition: ToolDefinition): () => void {
    this.registered.push(definition)
    this.onRegister?.(definition)
    return () => {
      const index = this.registered.indexOf(definition)
      if (index >= 0) this.registered.splice(index, 1)
    }
  }
}

function definition(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {} },
      render: () => [{ type: 'text', text: name }],
    },
    async execute() {
      return {}
    },
  }
}

function fakeContext(): { ctx: Context; tools: FakeTools } {
  const ctx = new Context()
  const tools = new FakeTools()
  ctx.provide('tools', tools)
  return { ctx, tools }
}

describe('task shape compatibility', () => {
  it('prefixes agent_type and derives a label', () => {
    const args: TaskToolArgs = {
      agent_type: 'reviewer',
      prompt: 'read the report',
      category: 'review',
      load_skills: ['x'],
      run_in_background: false,
    }
    expect(buildTaskPrompt(args)).toBe('You are the "reviewer" subagent.\n\nread the report')
    expect(buildTaskLabel(args)).toBe('reviewer task')
    expect(ignoredTaskFields(args)).toEqual(['load_skills', 'run_in_background'])
  })

  it('accepts subagent_type as the shipped Kinship alias', () => {
    const args: TaskToolArgs = { subagent_type: 'reviewer', prompt: 'read it' }
    expect(buildTaskPrompt(args)).toBe('You are the "reviewer" subagent.\n\nread it')
    expect(buildTaskLabel(args)).toBe('reviewer task')
    expect(ignoredTaskFields(args)).toEqual([])
  })

  it('accepts the opencode shape and reports unknown fields', () => {
    const raw = {
      prompt: 'find the evidence',
      category: 'research',
      description: 'evidence search',
      load_skills: [],
      run_in_background: true,
      session_id: 'legacy',
    }
    const args: TaskToolArgs = raw
    expect(buildTaskPrompt(args)).toBe('find the evidence')
    expect(buildTaskLabel(args)).toBe('evidence search')
    expect(ignoredTaskFields(args)).toEqual(['load_skills', 'run_in_background', 'session_id'])
  })

  it('starts a dsh activation with the mapped prompt and label', async () => {
    const calls: TaskDelegationRequest[] = []
    const delegation: TaskDelegation = {
      provider: 'spawn',
      async start(request) {
        calls.push(request)
        return { childId: 'child-1', name: 'agent-1' }
      },
      resolveMaxDepth: () => 2,
    }
    const parent = new TestAgent('parent', 'kinship')
    const result = await startTask(
      {
        agent_type: 'reviewer',
        prompt: 'do it',
        category: 'review',
        load_skills: ['x'],
        run_in_background: false,
      },
      delegation,
      parent,
      new AbortController().signal,
    )

    expect(result).toEqual({
      kind: 'activation',
      name: 'agent-1',
      child_id: 'child-1',
      background: true,
      provider: 'spawn',
      agent_type: 'reviewer',
      ignored_fields: ['load_skills', 'run_in_background'],
    })
    expect(calls[0]).toMatchObject({
      provider: 'spawn',
      label: 'reviewer task',
      prompt: [{ type: 'text', text: 'You are the "reviewer" subagent.\n\ndo it' }],
      delivery: 'parent',
      maxDepth: 2,
    })
    expect(calls[0]?.parent).toBe(parent)
  })

  it('rejects a missing calling agent', async () => {
    const delegation: TaskDelegation = {
      provider: 'spawn',
      start: async () => ({ childId: 'x', name: 'x' }),
      resolveMaxDepth: () => undefined,
    }
    await expect(startTask({ prompt: 'x' }, delegation, undefined, new AbortController().signal))
      .rejects.toThrow('task tool requires a calling agent')
  })

  it('registers the task tool with both input shapes', () => {
    const definition = createTaskToolDefinition({
      provider: 'spawn',
      start: async () => ({ childId: 'x', name: 'x' }),
      resolveMaxDepth: () => undefined,
    })
    expect(definition.name).toBe('task')
    const properties = definition.parameters['properties']
    expect(typeof properties).toBe('object')
  })
})

describe('todo and MCP aliases', () => {
  it('aliases todowrite to the exact todo_write definition', () => {
    const { ctx, tools } = fakeContext()
    const todo = definition('todo_write')
    tools.definitions.set('todo_write', todo)
    const registration = registerTodoWriteAlias(ctx)
    const alias = registration.alias()
    expect(registration.pending()).toBe(false)
    expect(alias?.name).toBe('todowrite')
    expect(alias?.execute).toBe(todo.execute)
    expect(alias?.parameters).toBe(todo.parameters)
    expect(alias?.description).toBe(
      `${todo.description}\n\nAlias of todo_write for Loom/opencode prompts.`,
    )
    expect(tools.registered.at(-1)?.name).toBe('todowrite')
    registration.dispose()
    expect(tools.registered).toHaveLength(0)
  })

  it('waits for todo_write instead of throwing when it mounts later', () => {
    const { ctx, tools } = fakeContext()
    const registration = registerTodoWriteAlias(ctx)
    expect(registration.pending()).toBe(true)
    expect(registration.alias()).toBeUndefined()
    expect(tools.registered).toHaveLength(0)

    const todo = definition('todo_write')
    tools.definitions.set('todo_write', todo)
    ctx.emit('tools/change')

    expect(registration.pending()).toBe(false)
    expect(registration.alias()?.execute).toBe(todo.execute)
    expect(tools.registered.map(item => item.name)).toEqual(['todowrite'])

    ctx.emit('tools/change')
    expect(tools.registered.map(item => item.name)).toEqual(['todowrite'])
    registration.dispose()
  })

  it('does not recurse when tools.register emits tools/change synchronously', () => {
    const { ctx, tools } = fakeContext()
    const registration = registerTodoWriteAlias(ctx)
    expect(registration.pending()).toBe(true)

    tools.definitions.set('todo_write', definition('todo_write'))
    tools.onRegister = () => {
      ctx.emit('tools/change')
    }

    expect(() => ctx.emit('tools/change')).not.toThrow()
    expect(registration.pending()).toBe(false)
    expect(tools.registered.filter(item => item.name === 'todowrite')).toHaveLength(1)

    expect(() => ctx.emit('tools/change')).not.toThrow()
    expect(tools.registered.filter(item => item.name === 'todowrite')).toHaveLength(1)
    registration.dispose()
    expect(tools.registered).toHaveLength(0)
  })

  it('disposes the alias and stops waiting for a missing target', () => {
    const { ctx, tools } = fakeContext()
    const pending = registerTodoWriteAlias(ctx)
    pending.dispose()

    tools.definitions.set('todo_write', definition('todo_write'))
    ctx.emit('tools/change')
    expect(tools.registered).toHaveLength(0)
    expect(pending.pending()).toBe(true)
  })

  it('registers MCP aliases when targets appear and removes them on dispose', () => {
    const { ctx, tools } = fakeContext()
    tools.definitions.set('mcp__ai_mcp__tts_speak', definition('mcp__ai_mcp__tts_speak'))
    const registration = registerMcpAliases(ctx, DEFAULT_MCP_ALIASES)
    expect(tools.registered.map(item => item.name)).toContain('mcp_ai_mcp_tts_speak')
    expect(registration.missing()).toContain('mcp_search_web_search')

    tools.definitions.set('mcp__search__web_search', definition('mcp__search__web_search'))
    ctx.emit('tools/change')
    expect(tools.registered.map(item => item.name)).toContain('mcp_search_web_search')
    expect(registration.missing()).not.toContain('mcp_search_web_search')

    registration.dispose()
    expect(tools.registered).toHaveLength(0)
  })

  it('prefers the native kinship-tools names over the MCP fallbacks', () => {
    const { ctx, tools } = fakeContext()
    tools.definitions.set('ai-mcp_send_notification', definition('ai-mcp_send_notification'))
    tools.definitions.set('ai-mcp_send_reminder', definition('ai-mcp_send_reminder'))
    tools.definitions.set('ai-mcp_list_reminders', definition('ai-mcp_list_reminders'))
    tools.definitions.set('tts_speak', definition('tts_speak'))
    // A leftover ai_mcp server must not win over the native tools.
    tools.definitions.set('mcp__ai_mcp__send_notification', definition('mcp__ai_mcp__send_notification'))

    const registration = registerMcpAliases(ctx, DEFAULT_MCP_ALIASES)

    const byName = new Map(tools.registered.map(item => [item.name, item]))
    for (const alias of [
      'mcp_ai_mcp_send_notification',
      'mcp_ai_mcp_send_reminder',
      'mcp_ai_mcp_list_reminders',
      'mcp_ai_mcp_tts_speak',
    ]) {
      expect(byName.has(alias), alias).toBe(true)
    }
    expect(byName.get('mcp_ai_mcp_send_notification')?.description)
      .toContain('Alias of dsh MCP tool ai-mcp_send_notification')
    expect(byName.get('mcp_ai_mcp_tts_speak')?.description)
      .toContain('Alias of dsh MCP tool tts_speak')
    expect(registration.missing()).not.toContain('mcp_ai_mcp_send_reminder')
    registration.dispose()
  })
})
