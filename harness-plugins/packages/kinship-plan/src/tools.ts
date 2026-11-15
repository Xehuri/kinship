/**
 * Model-facing plan tools over one `PlanStore`.
 *
 * The tools are thin adapters: parse the model arguments, call the store, and
 * return a compact view with file paths. CAS is explicit on every mutation:
 * `expected_version: 0` creates; any other value must match the current file.
 *
 * When the v1 `plan-{date}.json` truth file cannot serve (missing, closed, or
 * without the requested item), `plan_note`/`plan_done` write the day's
 * master+overlay instead, and `plan_overlay_read` exposes that view. The `plan`
 * alias shares the handlers and therefore the same fallback.
 *
 * @module kinship-plan/tools
 */

// allow: SIZE_OK — the complete plan tool surface lives here so descriptions, schemas, and handlers cannot drift apart.

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { toJsonValue } from './json.js'
import type {
  OverlayDoneInput,
  OverlayEffectiveView,
  OverlayEntryView,
  OverlayPlanSupport,
} from './overlay.js'
import {
  PlanClosedError,
  PlanItemNotFoundError,
  PlanNotFoundError,
  PlanValidationError,
  parseCommitInput,
  parseDoneStatus,
  requirePlanDate,
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
  /** v1 CAS version; omitted only when no open v1 plan exists (overlay write-back). */
  readonly expected_version?: number
  readonly note: string
}

export interface PlanDoneArgs {
  readonly date?: string
  /** v1 CAS version; omitted only when plan-{date}.json is missing or closed (overlay write-back). */
  readonly expected_version?: number
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

export interface PlanOverlayReadView {
  readonly source: 'overlay' | 'master'
  readonly date: string
  readonly overlay_version: number | null
  readonly overlay_status: string | null
  readonly entries: JsonValue[]
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
  /** Present only when the mutation went to the day overlay instead of v1 JSON. */
  readonly source?: 'overlay'
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

/** Mutation view for a write that landed in the day overlay instead of v1 JSON. */
async function overlayMutationView(
  store: PlanToolStore,
  date: string,
  overlayVersion: number,
  overlayStatus: string | null,
  entries: readonly OverlayEntryView[],
): Promise<PlanMutationView> {
  const paths = await store.paths(date)
  const status = overlayStatus ?? 'draft'
  return {
    ok: true,
    date,
    version: overlayVersion,
    status,
    plan: toJsonValue({
      source: 'overlay',
      date,
      version: overlayVersion,
      status,
      entries,
    }),
    json_path: paths.overlay,
    markdown_path: paths.markdown,
    ledger_path: paths.ledger,
    source: 'overlay',
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

/** Read the effective day (master + overlay diff) without touching the v1 truth file. */
export async function handlePlanOverlayRead(
  store: PlanToolStore,
  overlay: OverlayPlanSupport | undefined,
  args: PlanReadArgs,
): Promise<PlanOverlayReadView> {
  if (overlay === undefined) {
    throw new PlanValidationError('overlay', 'is not configured for this tool host')
  }
  const date = args.date === undefined ? (await store.read()).date : requirePlanDate(args.date)
  return overlayReadView(await overlay.readEffective(date))
}

function overlayReadView(effective: OverlayEffectiveView): PlanOverlayReadView {
  return {
    source: effective.source,
    date: effective.date,
    overlay_version: effective.overlayVersion,
    overlay_status: effective.overlayStatus,
    entries: effective.entries.map(entry => toJsonValue(entry)),
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
  overlay?: OverlayPlanSupport,
): Promise<PlanMutationView> {
  if (args.expected_version === undefined) {
    return noteWithoutVersion(store, args, overlay)
  }
  try {
    return await mutationView(store, await store.note({
      ...(args.date === undefined ? {} : { date: args.date }),
      expectedVersion: args.expected_version,
      note: args.note,
    }))
  } catch (error) {
    if (overlay === undefined || !isNoteFallbackError(error)) throw error
    return noteOverlayView(store, overlay, error.date, args.note)
  }
}

/**
 * A note without a v1 version can only go to the overlay: an open v1 truth file
 * still needs its CAS version, so the model must read it first.
 */
async function noteWithoutVersion(
  store: PlanToolStore,
  args: PlanNoteArgs,
  overlay: OverlayPlanSupport | undefined,
): Promise<PlanMutationView> {
  if (overlay === undefined) {
    throw new PlanValidationError(
      'expected_version',
      'is required for plan note; call plan_read for the current version',
    )
  }
  const current = await store.read(args.date)
  if (current.found && current.status !== 'closed') {
    throw new PlanValidationError(
      'expected_version',
      `is required for plan note while plan-${current.date}.json exists; call plan_read for the current version`,
    )
  }
  return noteOverlayView(store, overlay, current.date, args.note)
}

function isNoteFallbackError(error: unknown): error is PlanNotFoundError | PlanClosedError {
  return error instanceof PlanNotFoundError || error instanceof PlanClosedError
}

async function noteOverlayView(
  store: PlanToolStore,
  overlay: OverlayPlanSupport,
  date: string,
  note: string,
): Promise<PlanMutationView> {
  const result = await overlay.note(date, note)
  const effective = await overlay.readEffective(date)
  return overlayMutationView(
    store,
    date,
    result.overlayVersion,
    effective.overlayStatus,
    effective.entries,
  )
}

/** Mark one item done/skipped/blocked/carried. */
export async function handlePlanDone(
  store: PlanToolStore,
  args: PlanDoneArgs,
  overlay?: OverlayPlanSupport,
): Promise<PlanDoneView> {
  const status = parseDoneStatus(args.status)
  if (args.expected_version === undefined) {
    return doneWithoutVersion(store, args, status, overlay)
  }
  try {
    const result = await store.done({
      ...(args.date === undefined ? {} : { date: args.date }),
      expectedVersion: args.expected_version,
      id: args.id,
      status,
      ...(args.note === undefined ? {} : { note: args.note }),
      ...(args.evidence === undefined ? {} : { evidence: args.evidence }),
    })
    return {
      ...await mutationView(store, result.plan),
      item: toJsonValue(serializePlanItem(result.item)),
    }
  } catch (error) {
    if (overlay === undefined || !isDoneFallbackError(error)) throw error
    return doneOverlayView(store, overlay, {
      date: error.date,
      id: args.id,
      status,
      ...(args.evidence === undefined ? {} : { evidence: args.evidence }),
      // `expected_version: 0` means "no v1 plan expected"; it says nothing about
      // the overlay, which CAS-es on the version it just read. Any real v1
      // version is still forwarded so a stale caller stays a conflict.
      ...((args.expected_version ?? 0) >= 1 ? { expectedVersion: args.expected_version } : {}),
    })
  }
}

function isDoneFallbackError(
  error: unknown,
): error is PlanItemNotFoundError | PlanNotFoundError | PlanClosedError {
  return error instanceof PlanItemNotFoundError
    || error instanceof PlanNotFoundError
    || error instanceof PlanClosedError
}

/**
 * A done without a v1 version can only go to the overlay: an open v1 truth file
 * still needs its CAS version, so the model must read it first. A missing or
 * closed v1 file (the normal case for a master-entry wake) goes straight to the
 * day overlay, which CAS-es on the version it reads.
 */
async function doneWithoutVersion(
  store: PlanToolStore,
  args: PlanDoneArgs,
  status: 'done' | 'skipped' | 'blocked' | 'carried',
  overlay: OverlayPlanSupport | undefined,
): Promise<PlanDoneView> {
  if (overlay === undefined) {
    throw new PlanValidationError(
      'expected_version',
      'is required for plan done; call plan_read for the current version',
    )
  }
  const current = await store.read(args.date)
  if (current.found && current.status !== 'closed') {
    throw new PlanValidationError(
      'expected_version',
      `is required for plan done while plan-${current.date}.json exists; call plan_read for the current version`,
    )
  }
  return doneOverlayView(store, overlay, {
    date: current.date,
    id: args.id,
    status,
    ...(args.evidence === undefined ? {} : { evidence: args.evidence }),
  })
}

async function doneOverlayView(
  store: PlanToolStore,
  overlay: OverlayPlanSupport,
  input: OverlayDoneInput,
): Promise<PlanDoneView> {
  const result = await overlay.done(input)
  const effective = await overlay.readEffective(input.date)
  const entry = effective.entries.find(candidate => candidate.id === input.id)
  const evidence = input.evidence === undefined || input.evidence.trim() === ''
    ? undefined
    : input.evidence
  return {
    ...await overlayMutationView(
      store,
      input.date,
      result.overlayVersion,
      effective.overlayStatus,
      effective.entries,
    ),
    item: toJsonValue({
      ...(entry ?? { id: input.id }),
      status: result.status,
      ...(evidence === undefined ? {} : { evidence }),
    }),
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
  overlay?: OverlayPlanSupport,
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
        }, overlay)),
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
        }, overlay)),
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
    source: { type: 'string' as const },
  },
} as const

const OVERLAY_READ_OUTPUT = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    source: { type: 'string' as const, required: true },
    date: { type: 'string' as const, required: true },
    overlay_version: {
      oneOf: [{ type: 'integer' as const }, { type: 'null' as const }],
      required: true,
    },
    overlay_status: {
      oneOf: [{ type: 'string' as const }, { type: 'null' as const }],
      required: true,
    },
    entries: { type: 'array' as const, required: true },
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

function overlayReadRender(_args: unknown, value: {
  source: string
  date: string
  overlay_version: number | null
  entries: readonly unknown[]
}): { type: 'text'; text: string }[] {
  const version = value.overlay_version === null ? 'no overlay' : `overlay v${String(value.overlay_version)}`
  return [{
    type: 'text',
    text: `Plan ${value.date} from ${value.source} (${version}); ${String(value.entries.length)} entries.`,
  }]
}

/**
 * Build every plan tool; registration order is read, overlay read, commit,
 * note, done, close, alias.
 */
export function createPlanToolDefinitions(
  store: PlanToolStore,
  overlay?: OverlayPlanSupport,
): ToolDefinition[] {
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
      name: 'plan_overlay_read',
      description: 'Read the effective daily plan: master entries plus the day overlay diff (source=master when no overlay exists yet). Lists the entry ids and the current overlay_version used by plan_note/plan_done write-back.',
      parameters: {
        date: { type: 'string', description: 'YYYY-MM-DD; omitted uses the configured time zone today.' },
      },
      output: {
        schema: OVERLAY_READ_OUTPUT,
        render: overlayReadRender,
      },
      async execute(args) {
        return handlePlanOverlayRead(store, overlay, args)
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
      description: 'Append one note to the daily plan without changing items. Requires the current v1 version while plan-{date}.json is open. When that file is missing or closed the note is written to the day overlay (master + diff) instead; omit expected_version in that case. A closed v1 plan is never written.',
      parameters: {
        date: { type: 'string', description: 'YYYY-MM-DD; omitted uses the configured time zone today.' },
        expected_version: { type: 'integer', description: 'Current v1 plan version (CAS). Omit only when plan-{date}.json is missing or closed and the note goes to the day overlay.' },
        note: { type: 'string', required: true, description: 'Note text to append.' },
      },
      output: {
        schema: MUTATION_OUTPUT,
        render: mutationRender,
      },
      async execute(args) {
        return handlePlanNote(store, args, overlay)
      },
    }),
    defineTool({
      name: 'plan_done',
      description: 'Set one plan item status, defaulting to done. An open v1 plan requires its current version; when plan-{date}.json is missing, closed, or lacks the id, the status goes to the day overlay instead (expected_version may be omitted then, including for master-entry wakes). Records done_at for done and appends optional evidence/note.',
      parameters: {
        date: { type: 'string', description: 'YYYY-MM-DD; omitted uses the configured time zone today.' },
        expected_version: { type: 'integer', description: 'Current v1 plan version (CAS). Omit only when plan-{date}.json is missing or closed and the status goes to the day overlay.' },
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
        return handlePlanDone(store, args, overlay)
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
        return handlePlanAlias(store, args, overlay)
      },
    }),
  ]
}
