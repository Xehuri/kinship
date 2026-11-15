/**
 * Model-facing plan tools over one `PlanStore`.
 *
 * The tools are thin adapters: parse the model arguments, call the store, and
 * return a compact view with file paths. CAS is explicit on every mutation:
 * `expected_version: 0` creates; any other value must match the current file.
 *
 * @module kinship-plan/tools
 */

// allow: SIZE_OK — the complete plan tool surface lives here so descriptions, schemas, and handlers cannot drift apart.

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { toJsonValue } from './json.js'
import {
  PlanValidationError,
  parseCommitInput,
  parseDoneStatus,
  serializeCarryOver,
  serializePlanDocument,
  serializePlanItem,
  type PlanCloseInput,
  type PlanCloseResult,
  type PlanCommitInput,
  type PlanDocument,
  type PlanDoneInput,
  type PlanDoneResult,
  type PlanNoteInput,
  type PlanPaths,
  type PlanReadResult,
} from './schema.js'

/** Store surface used by the tools; tests can substitute a small fake. */
export interface PlanToolStore {
  read(date?: string): Promise<PlanReadResult>
  paths(date: string): Promise<PlanPaths> | PlanPaths
  commit(input: PlanCommitInput): Promise<PlanDocument>
  note(input: PlanNoteInput): Promise<PlanDocument>
  done(input: PlanDoneInput): Promise<PlanDoneResult>
  close(input: PlanCloseInput): Promise<PlanCloseResult>
}

export interface PlanReadArgs {
  readonly date?: string
}

export interface PlanCommitArgs {
  readonly date?: string
  readonly expected_version: number
  readonly status?: 'draft' | 'committed'
  readonly review_at?: string
  readonly items: readonly unknown[]
  readonly notes?: readonly string[]
  readonly reason?: string
}

export interface PlanNoteArgs {
  readonly date?: string
  readonly expected_version: number
  readonly note: string
}

export interface PlanDoneArgs {
  readonly date?: string
  readonly expected_version: number
  readonly id: string
  readonly status?: 'done' | 'skipped' | 'blocked' | 'carried'
  readonly note?: string
  readonly evidence?: string
}

export interface PlanCloseArgs {
  readonly date?: string
  readonly expected_version: number
  readonly summary?: string
  readonly carry_to?: string
}

export interface PlanAliasArgs {
  readonly action: 'read' | 'commit' | 'revise' | 'diff' | 'note' | 'done' | 'close'
  readonly date?: string
  readonly expected_version?: number
  readonly status?: string
  readonly review_at?: string
  readonly items?: readonly unknown[]
  readonly notes?: readonly string[]
  readonly reason?: string
  readonly id?: string
  readonly note?: string
  readonly evidence?: string
  readonly summary?: string
  readonly carry_to?: string
}

export interface PlanReadView {
  readonly found: boolean
  readonly date: string
  readonly version: number
  readonly status: string
  readonly plan: JsonValue | null
  readonly paths: {
    readonly json: string
    readonly markdown: string
    readonly ledger: string
  }
  readonly warning?: 'overlay_present'
}

export interface PlanMutationView {
  readonly ok: true
  readonly date: string
  readonly version: number
  readonly status: string
  readonly plan: JsonValue
  readonly json_path: string
  readonly markdown_path: string
  readonly ledger_path: string
}

export interface PlanDoneView extends PlanMutationView {
  readonly item: JsonValue
}

export interface PlanCloseView extends PlanMutationView {
  readonly carried: JsonValue
  readonly carry_over: JsonValue | null
  readonly already_closed: boolean
}

export interface PlanAliasView {
  readonly action: string
  readonly result: JsonValue
}

async function mutationView(store: PlanToolStore, plan: PlanDocument): Promise<PlanMutationView> {
  const paths = await store.paths(plan.date)
  return {
    ok: true,
    date: plan.date,
    version: plan.version,
    status: plan.status,
    plan: toJsonValue(serializePlanDocument(plan)),
    json_path: paths.json,
    markdown_path: paths.markdown,
    ledger_path: paths.ledger,
  }
}

/** Read one day; a missing file is reported as `found:false`, not an error. */
export async function handlePlanRead(
  store: PlanToolStore,
  args: PlanReadArgs,
): Promise<PlanReadView> {
  const result = await store.read(args.date)
  return {
    found: result.found,
    date: result.date,
    version: result.version,
    status: result.status,
    plan: result.plan === null ? null : toJsonValue(serializePlanDocument(result.plan)),
    paths: {
      json: result.paths.json,
      markdown: result.paths.markdown,
      ledger: result.paths.ledger,
    },
    ...(result.warning === undefined ? {} : { warning: result.warning }),
  }
}

/** Full replacement commit with explicit version CAS. */
export async function handlePlanCommit(
  store: PlanToolStore,
  args: PlanCommitArgs,
): Promise<PlanMutationView> {
  const input = parseCommitInput({
    ...(args.date === undefined ? {} : { date: args.date }),
    expectedVersion: args.expected_version,
    ...(args.status === undefined ? {} : { status: args.status }),
    ...(args.review_at === undefined ? {} : { reviewAt: args.review_at }),
    items: args.items,
    ...(args.notes === undefined ? {} : { notes: args.notes }),
    ...(args.reason === undefined ? {} : { reason: args.reason }),
  })
  return mutationView(store, await store.commit(input))
}

/** Append one note, preserving items and unknown fields. */
export async function handlePlanNote(
  store: PlanToolStore,
  args: PlanNoteArgs,
): Promise<PlanMutationView> {
  return mutationView(store, await store.note({
    ...(args.date === undefined ? {} : { date: args.date }),
    expectedVersion: args.expected_version,
    note: args.note,
  }))
}

/** Mark one item done/skipped/blocked/carried. */
export async function handlePlanDone(
  store: PlanToolStore,
  args: PlanDoneArgs,
): Promise<PlanDoneView> {
  const result = await store.done({
    ...(args.date === undefined ? {} : { date: args.date }),
    expectedVersion: args.expected_version,
    id: args.id,
    ...(args.status === undefined ? {} : { status: parseDoneStatus(args.status) }),
    ...(args.note === undefined ? {} : { note: args.note }),
    ...(args.evidence === undefined ? {} : { evidence: args.evidence }),
  })
  return {
    ...await mutationView(store, result.plan),
    item: toJsonValue(serializePlanItem(result.item)),
  }
}

/** Close the day, carry unfinished items, and record the summary. */
export async function handlePlanClose(
  store: PlanToolStore,
  args: PlanCloseArgs,
): Promise<PlanCloseView> {
  const result = await store.close({
    ...(args.date === undefined ? {} : { date: args.date }),
    expectedVersion: args.expected_version,
    ...(args.summary === undefined ? {} : { summary: args.summary }),
    ...(args.carry_to === undefined ? {} : { carryTo: args.carry_to }),
  })
  return {
    ...await mutationView(store, result.plan),
    carried: toJsonValue(result.carried.map(serializePlanItem)),
    carry_over: result.carryOver === null ? null : toJsonValue(serializeCarryOver(result.carryOver)),
    already_closed: result.alreadyClosed,
  }
}

/** Dispatch the Loom-style `plan <action>` compatibility surface. */
export async function handlePlanAlias(
  store: PlanToolStore,
  args: PlanAliasArgs,
): Promise<PlanAliasView> {
  switch (args.action) {
    case 'read':
      return {
        action: args.action,
        result: toJsonValue(await handlePlanRead(store, {
          ...(args.date === undefined ? {} : { date: args.date }),
        })),
      }
    case 'commit':
    case 'revise':
    case 'diff':
      if (args.expected_version === undefined) {
        throw new PlanValidationError('expected_version', 'is required for plan commit/revise/diff')
      }
      if (args.items === undefined) {
        throw new PlanValidationError('items', 'is required for plan commit/revise/diff')
      }
      return {
        action: args.action,
        result: toJsonValue(await handlePlanCommit(store, {
          ...(args.date === undefined ? {} : { date: args.date }),
          expected_version: args.expected_version,
          ...(args.status === 'draft' || args.status === 'committed' ? { status: args.status } : {}),
          ...(args.review_at === undefined ? {} : { review_at: args.review_at }),
          items: args.items,
          ...(args.notes === undefined ? {} : { notes: args.notes }),
          ...(args.reason === undefined ? {} : { reason: args.reason }),
        })),
      }
    case 'note':
      if (args.expected_version === undefined) {
        throw new PlanValidationError('expected_version', 'is required for plan note')
      }
      if (args.note === undefined) {
        throw new PlanValidationError('note', 'is required for plan note')
      }
      return {
        action: args.action,
        result: toJsonValue(await handlePlanNote(store, {
          ...(args.date === undefined ? {} : { date: args.date }),
          expected_version: args.expected_version,
          note: args.note,
        })),
      }
    case 'done':
      if (args.expected_version === undefined) {
        throw new PlanValidationError('expected_version', 'is required for plan done')
      }
      if (args.id === undefined) {
        throw new PlanValidationError('id', 'is required for plan done')
      }
      return {
        action: args.action,
        result: toJsonValue(await handlePlanDone(store, {
          ...(args.date === undefined ? {} : { date: args.date }),
          expected_version: args.expected_version,
          id: args.id,
          ...(args.status === 'done' || args.status === 'skipped' || args.status === 'blocked' || args.status === 'carried'
            ? { status: args.status }
            : {}),
          ...(args.note === undefined ? {} : { note: args.note }),
          ...(args.evidence === undefined ? {} : { evidence: args.evidence }),
        })),
      }
    case 'close':
      if (args.expected_version === undefined) {
        throw new PlanValidationError('expected_version', 'is required for plan close')
      }
      return {
        action: args.action,
        result: toJsonValue(await handlePlanClose(store, {
          ...(args.date === undefined ? {} : { date: args.date }),
          expected_version: args.expected_version,
          ...(args.summary === undefined ? {} : { summary: args.summary }),
          ...(args.carry_to === undefined ? {} : { carry_to: args.carry_to }),
        })),
      }
    default:
      throw new PlanValidationError('action', 'unsupported plan action')
  }
}

const PATHS_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    json: { type: 'string' as const, required: true },
    markdown: { type: 'string' as const, required: true },
    ledger: { type: 'string' as const, required: true },
  },
} as const

const READ_OUTPUT = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    found: { type: 'boolean' as const, required: true },
    date: { type: 'string' as const, required: true },
    version: { type: 'integer' as const, required: true },
    status: { type: 'string' as const, required: true },
    plan: { type: 'json' as const, required: true },
    paths: { ...PATHS_SCHEMA, required: true },
    warning: { type: 'string' as const },
  },
} as const

const MUTATION_OUTPUT = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' as const, required: true },
    date: { type: 'string' as const, required: true },
    version: { type: 'integer' as const, required: true },
    status: { type: 'string' as const, required: true },
    plan: { type: 'json' as const, required: true },
    json_path: { type: 'string' as const, required: true },
    markdown_path: { type: 'string' as const, required: true },
    ledger_path: { type: 'string' as const, required: true },
  },
} as const

const DONE_OUTPUT = {
  ...MUTATION_OUTPUT,
  properties: {
    ...MUTATION_OUTPUT.properties,
    item: { type: 'json' as const, required: true },
  },
} as const

const CLOSE_OUTPUT = {
  ...MUTATION_OUTPUT,
  properties: {
    ...MUTATION_OUTPUT.properties,
    carried: { type: 'json' as const, required: true },
    carry_over: { type: 'json' as const, required: true },
    already_closed: { type: 'boolean' as const, required: true },
  },
} as const

const ALIAS_OUTPUT = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    action: { type: 'string' as const, required: true },
    result: { type: 'json' as const, required: true },
  },
} as const

function readRender(_args: unknown, value: {
  found: boolean
  date: string
  version: number
  status: string
  paths: { json: string; markdown: string; ledger: string }
  warning?: string
}): { type: 'text'; text: string }[] {
  const head = value.found
    ? `Plan ${value.date} v${String(value.version)} ${value.status}.`
    : `No plan file for ${value.date}.`
  const warning = value.warning === 'overlay_present' ? ' An overlay file also exists; this tool read the v1 truth file only.' : ''
  return [{ type: 'text', text: `${head}${warning} JSON: ${value.paths.json}` }]
}

function mutationRender(_args: unknown, value: { date: string; version: number; status: string }): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: `Plan ${value.date} v${String(value.version)} ${value.status}.` }]
}

function closeRender(_args: unknown, value: { date: string; version: number; status: string; carried: unknown; already_closed: boolean }): { type: 'text'; text: string }[] {
  const count = Array.isArray(value.carried) ? value.carried.length : 0
  const suffix = value.already_closed ? ' Already closed.' : ''
  return [{ type: 'text', text: `Plan ${value.date} v${String(value.version)} ${value.status}; carried ${String(count)} item(s).${suffix}` }]
}

function aliasRender(_args: unknown, value: { action: string }): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: `Plan alias action ${value.action} completed.` }]
}

/** Build every plan tool; registration order is read, commit, note, done, close, alias. */
export function createPlanToolDefinitions(store: PlanToolStore): ToolDefinition[] {
  return [
    defineTool({
      name: 'plan_read',
      description: 'Read the daily plan truth JSON (plan-{date}.json). A missing file returns found:false. Always read before a mutation to learn the current version.',
      parameters: {
        date: { type: 'string', description: 'YYYY-MM-DD; omitted uses the configured time zone today.' },
      },
      output: {
        schema: READ_OUTPUT,
        render: readRender,
      },
      async execute(args) {
        return handlePlanRead(store, args)
      },
    }),
    defineTool({
      name: 'plan_commit',
      description: 'Create or fully replace the daily plan truth JSON. expected_version=0 creates; otherwise it must equal the current version. Items and notes replace the previous values; unknown fields already on disk are preserved. No coverage management.',
      parameters: {
        date: { type: 'string', description: 'YYYY-MM-DD; omitted uses the configured time zone today.' },
        expected_version: { type: 'integer', required: true, description: '0 creates; otherwise the current plan version (CAS).' },
        status: { type: 'string', enum: ['draft', 'committed'], description: 'Plan status; defaults to committed on create and keeps the current status on replace.' },
        review_at: { type: 'string', description: 'HH:MM review time; defaults to 07:30 on create.' },
        items: {
          type: 'array',
          required: true,
          description: 'Complete item list. Each item needs id, kind, intent, status; unknown item fields are preserved.',
          items: { type: 'object', additionalProperties: true },
        },
        notes: { type: 'array', items: { type: 'string' }, description: 'Complete note list; omitted keeps the current notes.' },
        reason: { type: 'string', description: 'Optional audit reason written to plan-ledger.jsonl.' },
      },
      output: {
        schema: MUTATION_OUTPUT,
        render: mutationRender,
      },
      async execute(args) {
        return handlePlanCommit(store, args)
      },
    }),
    defineTool({
      name: 'plan_note',
      description: 'Append one note to the daily plan without changing items. Requires the current version. A closed plan is rejected.',
      parameters: {
        date: { type: 'string', description: 'YYYY-MM-DD; omitted uses the configured time zone today.' },
        expected_version: { type: 'integer', required: true, description: 'Current plan version (CAS).' },
        note: { type: 'string', required: true, description: 'Note text to append.' },
      },
      output: {
        schema: MUTATION_OUTPUT,
        render: mutationRender,
      },
      async execute(args) {
        return handlePlanNote(store, args)
      },
    }),
    defineTool({
      name: 'plan_done',
      description: 'Set one plan item status, defaulting to done. Requires the current version. Records done_at for done and appends optional evidence/note.',
      parameters: {
        date: { type: 'string', description: 'YYYY-MM-DD; omitted uses the configured time zone today.' },
        expected_version: { type: 'integer', required: true, description: 'Current plan version (CAS).' },
        id: { type: 'string', required: true, description: 'Plan item id.' },
        status: { type: 'string', enum: ['done', 'skipped', 'blocked', 'carried'], description: 'New item status; defaults to done.' },
        note: { type: 'string', description: 'Optional note appended to the item note.' },
        evidence: { type: 'string', description: 'Optional evidence text recorded on the item.' },
      },
      output: {
        schema: DONE_OUTPUT,
        render: mutationRender,
      },
      async execute(args) {
        return handlePlanDone(store, args)
      },
    }),
    defineTool({
      name: 'plan_close',
      description: 'Close the daily plan. Unfinished items become carried, carry_over records the target day, and the summary is written to the ledger. Repeating close with the current version is idempotent.',
      parameters: {
        date: { type: 'string', description: 'YYYY-MM-DD; omitted uses the configured time zone today.' },
        expected_version: { type: 'integer', required: true, description: 'Current plan version (CAS).' },
        summary: { type: 'string', description: 'Close summary for the audit ledger.' },
        carry_to: { type: 'string', description: 'YYYY-MM-DD target for carry_over; defaults to the next day.' },
      },
      output: {
        schema: CLOSE_OUTPUT,
        render: closeRender,
      },
      async execute(args) {
        return handlePlanClose(store, args)
      },
    }),
    defineTool({
      name: 'plan',
      description: 'Loom-compatible plan command. action=read|commit|revise|diff|note|done|close. revise/diff are aliases for a full commit; pass expected_version and items. Other actions map to the matching plan_* tool.',
      parameters: {
        action: { type: 'string', required: true, enum: ['read', 'commit', 'revise', 'diff', 'note', 'done', 'close'], description: 'Plan action.' },
        date: { type: 'string', description: 'YYYY-MM-DD; omitted uses the configured time zone today.' },
        expected_version: { type: 'integer', description: 'Current version for every mutation; 0 creates on commit.' },
        status: { type: 'string', description: 'Plan status for commit (draft|committed) or item status for done (done|skipped|blocked|carried).' },
        review_at: { type: 'string', description: 'HH:MM review time for commit.' },
        items: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Complete item list for commit/revise/diff.' },
        notes: { type: 'array', items: { type: 'string' }, description: 'Complete note list for commit/revise/diff.' },
        reason: { type: 'string', description: 'Optional commit audit reason.' },
        id: { type: 'string', description: 'Item id for done.' },
        note: { type: 'string', description: 'Note text for note, or item note for done.' },
        evidence: { type: 'string', description: 'Evidence text for done.' },
        summary: { type: 'string', description: 'Close summary for close.' },
        carry_to: { type: 'string', description: 'YYYY-MM-DD carry_over target for close.' },
      },
      output: {
        schema: ALIAS_OUTPUT,
        render: aliasRender,
      },
      async execute(args) {
        return handlePlanAlias(store, args)
      },
    }),
  ]
}
