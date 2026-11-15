/**
 * Loom/opencode-compatible `task` tool over the dsh subagent runtime.
 *
 * Accepted shapes:
 * - `{ agent_type, prompt, ... }` (Loom): `agent_type` becomes a prompt prefix.
 *   `subagent_type` is accepted as an alias because the shipped Kinship task
 *   instructions spell it that way.
 * - `{ category, load_skills, run_in_background, description, prompt, ... }`
 *   (opencode): accepted; `load_skills` and `run_in_background` have no dsh
 *   equivalent and are reported in `ignored_fields` instead of being dropped
 *   silently. `category` is used as a label fallback.
 *
 * dsh subagents are always asynchronous: the tool returns an activation name
 * immediately and the completion notice arrives later.
 *
 * @module kinship-task-compat/task
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Model-facing task arguments accepted by both compatibility shapes. */
export interface TaskToolArgs {
  readonly agent_type?: string
  readonly subagent_type?: string
  readonly category?: string
  readonly load_skills?: readonly string[]
  readonly run_in_background?: boolean
  readonly description?: string
  readonly prompt: string
  readonly name?: string
  readonly cwd?: string
}

/** One activation accepted by the delegation backend. */
export interface TaskActivation {
  readonly childId: unknown
  readonly name: string
  readonly messageId?: unknown
}

/** Delegation request passed to `ctx.subagents.startActivation`. */
export interface TaskDelegationRequest {
  readonly provider: string
  readonly label: string
  readonly prompt: ContentBlock[]
  readonly parent: Agent
  readonly signal: AbortSignal
  readonly delivery: 'parent'
  readonly name?: string
  readonly cwd?: string
  readonly maxDepth?: number
}

/** Narrow delegation seam; the plugin wires it to the dsh subagent runtime. */
export interface TaskDelegation {
  readonly provider: string
  start(request: TaskDelegationRequest): Promise<TaskActivation>
  resolveMaxDepth(): number | undefined
}

/** Canonical result returned to the model. */
export interface TaskResult {
  readonly kind: 'activation'
  readonly name: string
  readonly child_id: string
  readonly background: true
  readonly provider: string
  readonly agent_type?: string
  readonly ignored_fields: string[]
}

const KNOWN_FIELDS = new Set([
  'agent_type',
  'subagent_type',
  'category',
  'load_skills',
  'run_in_background',
  'description',
  'prompt',
  'name',
  'cwd',
])

/** Prefix the child prompt with the Loom agent type, when one was supplied. */
export function buildTaskPrompt(args: TaskToolArgs): string {
  const agentType = args.agent_type?.trim() || args.subagent_type?.trim()
  return agentType === undefined || agentType === ''
    ? args.prompt
    : `You are the "${agentType}" subagent.\n\n${args.prompt}`
}

/** Short dsh activation label derived from the compatibility fields. */
export function buildTaskLabel(args: TaskToolArgs): string {
  const explicit = args.description?.trim()
  if (explicit !== undefined && explicit !== '') return explicit.slice(0, 80)
  const type = args.agent_type?.trim() || args.subagent_type?.trim() || args.category?.trim()
  if (type !== undefined && type !== '') return `${type} task`
  const firstLine = args.prompt.split('\n').map(line => line.trim()).find(line => line !== '')
  return firstLine === undefined || firstLine === '' ? 'delegated task' : firstLine.slice(0, 60)
}

/** Fields accepted for compatibility but not applied by this dsh backend. */
export function ignoredTaskFields(args: TaskToolArgs): string[] {
  const ignored = new Set<string>()
  if (args.load_skills !== undefined) ignored.add('load_skills')
  if (args.run_in_background !== undefined) ignored.add('run_in_background')
  for (const key of Object.keys(args)) {
    if (!KNOWN_FIELDS.has(key)) ignored.add(key)
  }
  return [...ignored].sort()
}

/** Start one dsh activation from either input shape. */
export async function startTask(
  args: TaskToolArgs,
  delegation: TaskDelegation,
  parent: Agent | undefined,
  signal: AbortSignal,
): Promise<TaskResult> {
  if (parent === undefined) {
    throw new Error('task tool requires a calling agent (exec.agent was undefined)')
  }
  const maxDepth = delegation.resolveMaxDepth()
  const agentType = args.agent_type?.trim() || args.subagent_type?.trim()
  const started = await delegation.start({
    provider: delegation.provider,
    label: buildTaskLabel(args),
    prompt: [{ type: 'text', text: buildTaskPrompt(args) }],
    parent,
    signal,
    delivery: 'parent',
    ...(args.name === undefined ? {} : { name: args.name }),
    ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
    ...(maxDepth === undefined ? {} : { maxDepth }),
  })
  return {
    kind: 'activation',
    name: started.name,
    child_id: String(started.childId),
    background: true,
    provider: delegation.provider,
    ...(agentType === undefined || agentType === '' ? {} : { agent_type: agentType }),
    ignored_fields: ignoredTaskFields(args),
  }
}

/** Build the model-facing `task` tool for one delegation backend. */
export function createTaskToolDefinition(delegation: TaskDelegation): ToolDefinition {
  return defineTool({
    name: 'task',
    description: 'Delegate a self-contained task to a dsh subagent. Accepts Loom shape { agent_type | subagent_type, prompt, ... } and opencode shape { category, load_skills, run_in_background, description, prompt, ... }. The type becomes a prompt prefix; category is a label fallback; load_skills and run_in_background are accepted but not applied (dsh subagents always run asynchronously). The tool returns an activation name immediately; the completion notice arrives later.',
    parameters: {
      agent_type: { type: 'string', description: 'Loom agent type, prefixed to the child prompt.' },
      subagent_type: { type: 'string', description: 'Alias for agent_type used by the shipped Kinship task instructions.' },
      category: { type: 'string', description: 'opencode category; used as a label fallback only.' },
      load_skills: { type: 'array', items: { type: 'string' }, description: 'Accepted for compatibility; not applied by dsh subagents.' },
      run_in_background: { type: 'boolean', description: 'Accepted for compatibility; dsh subagents are always asynchronous.' },
      description: { type: 'string', description: 'Short display label for the activation.' },
      prompt: { type: 'string', required: true, description: 'Complete, self-contained task for the child agent.' },
      name: { type: 'string', description: 'Optional dsh child name.' },
      cwd: { type: 'string', description: 'Optional initial child working directory.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'activation' },
          name: { type: 'string', required: true },
          child_id: { type: 'string', required: true },
          background: { type: 'boolean', required: true, const: true },
          provider: { type: 'string', required: true },
          agent_type: { type: 'string' },
          ignored_fields: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `started subagent ${value.name}${value.ignored_fields.length === 0 ? '' : `; ignored: ${value.ignored_fields.join(', ')}`}`,
      }],
    },
    async execute(args, exec) {
      return startTask(args, delegation, exec.agent, exec.signal)
    },
  })
}
