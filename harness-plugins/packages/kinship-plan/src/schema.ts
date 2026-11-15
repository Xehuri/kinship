/**
 * Simplified Kinship daily-plan schema.
 *
 * The truth file is `plan-{date}.json`. Known fields are validated; every
 * unknown top-level or item field is preserved in `extra` and merged back on
 * write. Coverage fields from the existing v1/v2 files are therefore retained
 * but never interpreted by this tool.
 *
 * @module kinship-plan/schema
 */

// allow: SIZE_OK — one schema, validation, and serialization contract; splitting it would duplicate the plan type surface across every consumer.

export const PLAN_SCHEMA = 1
export const PLAN_DEFAULT_REVIEW_AT = '07:30'

export const PLAN_STATUSES = ['draft', 'committed', 'closed'] as const
export type PlanStatus = (typeof PLAN_STATUSES)[number]

export const PLAN_ITEM_STATUSES = ['planned', 'done', 'skipped', 'carried', 'blocked'] as const
export type PlanItemStatus = (typeof PLAN_ITEM_STATUSES)[number]

export const PLAN_UNFINISHED_STATUSES = ['planned', 'skipped', 'blocked'] as const

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

const DOCUMENT_KEYS = [
  'schema',
  'date',
  'status',
  'version',
  'created_at',
  'updated_at',
  'review_at',
  'items',
  'notes',
  'carry_over',
] as const

const ITEM_KEYS = [
  'id',
  'kind',
  'intent',
  'status',
  'target_date',
  'window',
  'checkpoint_id',
  'done_when',
  'not_do',
  'source',
  'note',
  'done_at',
  'evidence',
] as const

const CARRY_OVER_KEYS = ['to', 'created_at', 'items'] as const

/** Base class for all plan-domain failures. */
export class PlanError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PlanError'
    this.code = code
  }
}

/** Input shape or semantics are invalid. */
export class PlanValidationError extends PlanError {
  readonly field: string

  constructor(field: string, message: string) {
    super('plan_validation', `[plan:validation] ${field}: ${message}`)
    this.name = 'PlanValidationError'
    this.field = field
  }
}

/** Optimistic concurrency conflict. */
export class PlanConflictError extends PlanError {
  readonly date: string
  readonly expected: number
  readonly actual: number

  constructor(date: string, expected: number, actual: number) {
    super(
      'plan_conflict',
      `[plan:conflict] date ${date} expected version ${String(expected)}, actual ${String(actual)}`,
    )
    this.name = 'PlanConflictError'
    this.date = date
    this.expected = expected
    this.actual = actual
  }
}

/** The requested daily plan file does not exist. */
export class PlanNotFoundError extends PlanError {
  readonly date: string

  constructor(date: string) {
    super('plan_not_found', `[plan:not-found] date ${date}`)
    this.name = 'PlanNotFoundError'
    this.date = date
  }
}

/** A closed plan is read-only. */
export class PlanClosedError extends PlanError {
  readonly date: string

  constructor(date: string) {
    super('plan_closed', `[plan:closed] date ${date} is closed`)
    this.name = 'PlanClosedError'
    this.date = date
  }
}

/** One item id is absent from the plan. */
export class PlanItemNotFoundError extends PlanError {
  readonly date: string
  readonly itemId: string

  constructor(date: string, itemId: string) {
    super('plan_item_not_found', `[plan:item-not-found] date ${date} item ${itemId}`)
    this.name = 'PlanItemNotFoundError'
    this.date = date
    this.itemId = itemId
  }
}

/** An overlay exists for the date and this tool refuses to shadow it. */
export class PlanOverlayPresentError extends PlanError {
  readonly date: string
  readonly overlayPath: string

  constructor(date: string, overlayPath: string) {
    super(
      'plan_overlay_present',
      `[plan:overlay-present] date ${date} has ${overlayPath}; set allowOverlayShadow=true to create a v1 truth file beside it`,
    )
    this.name = 'PlanOverlayPresentError'
    this.date = date
    this.overlayPath = overlayPath
  }
}

export interface PlanItem {
  readonly id: string
  readonly kind: string
  readonly intent: string
  readonly status: PlanItemStatus
  readonly target_date?: string
  readonly window?: string
  readonly checkpoint_id?: string
  readonly done_when?: string
  readonly not_do?: readonly string[]
  readonly source?: string
  readonly note?: string
  readonly done_at?: string
  readonly evidence?: string
  readonly extra: Readonly<Record<string, unknown>>
}

export interface CarryOver {
  readonly to: string
  readonly created_at: number
  readonly items: readonly PlanItem[]
  readonly extra: Readonly<Record<string, unknown>>
}

export interface PlanDocument {
  readonly schema: typeof PLAN_SCHEMA
  readonly date: string
  readonly status: PlanStatus
  readonly version: number
  readonly created_at: number
  readonly updated_at: number
  readonly review_at?: string
  readonly items: readonly PlanItem[]
  readonly notes: readonly string[]
  readonly carry_over?: CarryOver
  readonly extra: Readonly<Record<string, unknown>>
}

export interface PlanPaths {
  readonly dir: string
  readonly json: string
  readonly markdown: string
  readonly ledger: string
  readonly overlay: string
}

export interface PlanReadResult {
  readonly found: boolean
  readonly date: string
  readonly version: number
  readonly status: 'missing' | PlanStatus
  readonly plan: PlanDocument | null
  readonly paths: PlanPaths
  readonly warning?: 'overlay_present'
}

export interface PlanCommitInput {
  readonly date?: string
  readonly expectedVersion: number
  readonly status?: 'draft' | 'committed'
  readonly reviewAt?: string
  readonly items: readonly PlanItem[]
  readonly notes?: readonly string[]
  readonly reason?: string
}

export interface PlanNoteInput {
  readonly date?: string
  readonly expectedVersion: number
  readonly note: string
}

export type PlanDoneStatus = 'done' | 'skipped' | 'blocked' | 'carried'

export interface PlanDoneInput {
  readonly date?: string
  readonly expectedVersion: number
  readonly id: string
  readonly status?: PlanDoneStatus
  readonly note?: string
  readonly evidence?: string
}

export interface PlanCloseInput {
  readonly date?: string
  readonly expectedVersion: number
  readonly summary?: string
  readonly carryTo?: string
}

export interface PlanDoneResult {
  readonly plan: PlanDocument
  readonly item: PlanItem
}

export interface PlanCloseResult {
  readonly plan: PlanDocument
  readonly carried: readonly PlanItem[]
  readonly carryOver: CarryOver | null
  readonly alreadyClosed: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new PlanValidationError(field, `must be an object: ${describe(value)}`)
  return value
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PlanValidationError(field, `must be a non-empty string: ${describe(value)}`)
  }
  return value
}

function optionalNonEmptyString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : requireNonEmptyString(value, field)
}

function requireInteger(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new PlanValidationError(field, `must be an integer >= ${String(minimum)}: ${describe(value)}`)
  }
  return value
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new PlanValidationError(field, `must be one of ${allowed.join(' | ')}: ${describe(value)}`)
  }
  return value as T
}

function requireStringArray(
  value: unknown,
  field: string,
  options: { readonly allowEmpty: boolean; readonly unique: boolean },
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new PlanValidationError(field, `must be a string array: ${describe(value)}`)
  }
  if (!options.allowEmpty && value.length === 0) {
    throw new PlanValidationError(field, 'must contain at least one element')
  }
  const rows: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    const row = requireNonEmptyString(value[index], `${field}[${String(index)}]`)
    if (options.unique && seen.has(row)) {
      throw new PlanValidationError(field, `duplicate element: ${row}`)
    }
    seen.add(row)
    rows.push(row)
  }
  return rows
}

function buildExtra(
  record: Record<string, unknown>,
  known: readonly string[],
): Readonly<Record<string, unknown>> {
  const knownSet = new Set(known)
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (!knownSet.has(key)) extra[key] = value
  }
  return extra
}

/** Strict YYYY-MM-DD including calendar validity. */
export function requirePlanDate(value: unknown, field = 'date'): string {
  if (typeof value !== 'string') {
    throw new PlanValidationError(field, `must be a YYYY-MM-DD string: ${describe(value)}`)
  }
  const match = DATE_RE.exec(value)
  if (match === null) throw new PlanValidationError(field, `must be YYYY-MM-DD: ${value}`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const stamp = new Date(Date.UTC(year, month - 1, day))
  if (
    stamp.getUTCFullYear() !== year
    || stamp.getUTCMonth() !== month - 1
    || stamp.getUTCDate() !== day
  ) {
    throw new PlanValidationError(field, `not a valid calendar date: ${value}`)
  }
  return value
}

/** Strict HH:MM. */
export function requireReviewAt(value: unknown, field = 'review_at'): string {
  if (typeof value !== 'string' || !TIME_RE.test(value)) {
    throw new PlanValidationError(field, `must be HH:MM: ${describe(value)}`)
  }
  return value
}

/** Whether an IANA time zone name is accepted by the runtime. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

/** Today in one IANA time zone as YYYY-MM-DD. */
export function todayInTimeZone(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date())
}

/** Calendar day after `date` as YYYY-MM-DD. */
export function nextDate(date: string): string {
  const value = requirePlanDate(date)
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
}

/** Parse one plan item, preserving unrecognized keys in `extra`. */
export function parsePlanItem(value: unknown, field = 'item'): PlanItem {
  const record = requireRecord(value, field)
  const id = requireNonEmptyString(record['id'], `${field}.id`)
  if (!ITEM_ID_RE.test(id)) {
    throw new PlanValidationError(`${field}.id`, `must match ${ITEM_ID_RE.source}: ${id}`)
  }
  const kind = requireNonEmptyString(record['kind'], `${field}.kind`)
  const intent = requireNonEmptyString(record['intent'], `${field}.intent`)
  const status = requireEnum(record['status'], PLAN_ITEM_STATUSES, `${field}.status`)

  const targetDate = record['target_date'] === undefined
    ? undefined
    : requirePlanDate(record['target_date'], `${field}.target_date`)
  const window = optionalNonEmptyString(record['window'], `${field}.window`)
  const checkpointId = optionalNonEmptyString(record['checkpoint_id'], `${field}.checkpoint_id`)
  if (checkpointId !== undefined && !ITEM_ID_RE.test(checkpointId)) {
    throw new PlanValidationError(`${field}.checkpoint_id`, `must match ${ITEM_ID_RE.source}: ${checkpointId}`)
  }
  const doneWhen = optionalNonEmptyString(record['done_when'], `${field}.done_when`)
  const notDo = record['not_do'] === undefined
    ? undefined
    : requireStringArray(record['not_do'], `${field}.not_do`, { allowEmpty: true, unique: true })
  const source = optionalNonEmptyString(record['source'], `${field}.source`)
  const note = optionalNonEmptyString(record['note'], `${field}.note`)
  const doneAt = optionalNonEmptyString(record['done_at'], `${field}.done_at`)
  const evidence = optionalNonEmptyString(record['evidence'], `${field}.evidence`)

  return {
    id,
    kind,
    intent,
    status,
    ...(targetDate === undefined ? {} : { target_date: targetDate }),
    ...(window === undefined ? {} : { window }),
    ...(checkpointId === undefined ? {} : { checkpoint_id: checkpointId }),
    ...(doneWhen === undefined ? {} : { done_when: doneWhen }),
    ...(notDo === undefined ? {} : { not_do: notDo }),
    ...(source === undefined ? {} : { source }),
    ...(note === undefined ? {} : { note }),
    ...(doneAt === undefined ? {} : { done_at: doneAt }),
    ...(evidence === undefined ? {} : { evidence }),
    extra: buildExtra(record, ITEM_KEYS),
  }
}

function parseItemArray(value: unknown, field: string): readonly PlanItem[] {
  if (!Array.isArray(value)) {
    throw new PlanValidationError(field, `must be an array: ${describe(value)}`)
  }
  const items = value.map((entry, index) => parsePlanItem(entry, `${field}[${String(index)}]`))
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) throw new PlanValidationError(`${field}.id`, `duplicate id: ${item.id}`)
    seen.add(item.id)
  }
  return items
}

function parseCarryOver(value: unknown): CarryOver {
  const record = requireRecord(value, 'carry_over')
  return {
    to: requirePlanDate(record['to'], 'carry_over.to'),
    created_at: requireInteger(record['created_at'], 'carry_over.created_at', 0),
    items: parseItemArray(record['items'], 'carry_over.items'),
    extra: buildExtra(record, CARRY_OVER_KEYS),
  }
}

/** Parse and validate a complete plan document from disk. */
export function parsePlanDocument(value: unknown, expectedDate?: string): PlanDocument {
  const record = requireRecord(value, 'plan')
  if (record['schema'] !== PLAN_SCHEMA) {
    throw new PlanValidationError('schema', `only schema ${String(PLAN_SCHEMA)} is supported: ${describe(record['schema'])}`)
  }
  const date = requirePlanDate(record['date'])
  if (expectedDate !== undefined && date !== expectedDate) {
    throw new PlanValidationError('date', `file date ${date} does not match requested date ${expectedDate}`)
  }
  const status = requireEnum(record['status'], PLAN_STATUSES, 'status')
  const version = requireInteger(record['version'], 'version', 1)
  const createdAt = requireInteger(record['created_at'], 'created_at', 0)
  const updatedAt = requireInteger(record['updated_at'], 'updated_at', 0)
  if (updatedAt < createdAt) {
    throw new PlanValidationError('updated_at', 'must not be earlier than created_at')
  }
  const reviewAt = record['review_at'] === undefined
    ? undefined
    : requireReviewAt(record['review_at'])
  const items = parseItemArray(record['items'], 'items')
  const notes = record['notes'] === undefined
    ? []
    : requireStringArray(record['notes'], 'notes', { allowEmpty: true, unique: false })
  const carryOver = record['carry_over'] === undefined
    ? undefined
    : parseCarryOver(record['carry_over'])

  return {
    schema: PLAN_SCHEMA,
    date,
    status,
    version,
    created_at: createdAt,
    updated_at: updatedAt,
    ...(reviewAt === undefined ? {} : { review_at: reviewAt }),
    items,
    notes,
    ...(carryOver === undefined ? {} : { carry_over: carryOver }),
    extra: buildExtra(record, DOCUMENT_KEYS),
  }
}

/** Serialize one item, merging preserved unknown keys first. */
export function serializePlanItem(item: PlanItem): Record<string, unknown> {
  return {
    ...item.extra,
    id: item.id,
    kind: item.kind,
    intent: item.intent,
    status: item.status,
    ...(item.target_date === undefined ? {} : { target_date: item.target_date }),
    ...(item.window === undefined ? {} : { window: item.window }),
    ...(item.checkpoint_id === undefined ? {} : { checkpoint_id: item.checkpoint_id }),
    ...(item.done_when === undefined ? {} : { done_when: item.done_when }),
    ...(item.not_do === undefined ? {} : { not_do: [...item.not_do] }),
    ...(item.source === undefined ? {} : { source: item.source }),
    ...(item.note === undefined ? {} : { note: item.note }),
    ...(item.done_at === undefined ? {} : { done_at: item.done_at }),
    ...(item.evidence === undefined ? {} : { evidence: item.evidence }),
  }
}

export function serializeCarryOver(carryOver: CarryOver): Record<string, unknown> {
  return {
    ...carryOver.extra,
    to: carryOver.to,
    created_at: carryOver.created_at,
    items: carryOver.items.map(serializePlanItem),
  }
}

/** Serialize a plan document, merging preserved unknown keys first. */
export function serializePlanDocument(plan: PlanDocument): Record<string, unknown> {
  return {
    ...plan.extra,
    schema: PLAN_SCHEMA,
    date: plan.date,
    status: plan.status,
    version: plan.version,
    created_at: plan.created_at,
    updated_at: plan.updated_at,
    ...(plan.review_at === undefined ? {} : { review_at: plan.review_at }),
    items: plan.items.map(serializePlanItem),
    notes: [...plan.notes],
    ...(plan.carry_over === undefined ? {} : { carry_over: serializeCarryOver(plan.carry_over) }),
  }
}

/** Parse the commit input shared by `plan_commit` and the `plan` alias. */
export function parseCommitInput(value: {
  readonly date?: string
  readonly expectedVersion: unknown
  readonly status?: unknown
  readonly reviewAt?: unknown
  readonly items: unknown
  readonly notes?: unknown
  readonly reason?: unknown
}): PlanCommitInput {
  const expectedVersion = requireInteger(value.expectedVersion, 'expected_version', 0)
  const status = value.status === undefined
    ? undefined
    : requireEnum(value.status, ['draft', 'committed'] as const, 'status')
  const reviewAt = value.reviewAt === undefined ? undefined : requireReviewAt(value.reviewAt)
  if (!Array.isArray(value.items)) {
    throw new PlanValidationError('items', `must be an array: ${describe(value.items)}`)
  }
  const items = value.items.map((item, index) => parsePlanItem(item, `items[${String(index)}]`))
  const notes = value.notes === undefined
    ? undefined
    : requireStringArray(value.notes, 'notes', { allowEmpty: true, unique: false })
  const reason = optionalNonEmptyString(value.reason, 'reason')
  return {
    ...(value.date === undefined ? {} : { date: requirePlanDate(value.date) }),
    expectedVersion,
    ...(status === undefined ? {} : { status }),
    ...(reviewAt === undefined ? {} : { reviewAt }),
    items,
    ...(notes === undefined ? {} : { notes }),
    ...(reason === undefined ? {} : { reason }),
  }
}

/** Parse a done status, defaulting to `done`. */
export function parseDoneStatus(value: unknown): PlanDoneStatus {
  if (value === undefined) return 'done'
  return requireEnum(value, ['done', 'skipped', 'blocked', 'carried'] as const, 'status')
}
