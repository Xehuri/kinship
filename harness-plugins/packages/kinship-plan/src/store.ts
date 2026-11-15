/**
 * CAS daily-plan store.
 *
 * Path contract (root is always explicit):
 *   {root}/daily/{date}/plan-{date}.json      truth
 *   {root}/daily/{date}/计划-{date}.md        derived human view
 *   {root}/daily/{date}/plan-ledger.jsonl     append-only audit
 *
 * JSON is the only truth. Markdown is rendered after the JSON commit; a
 * markdown failure never rolls back the committed JSON and the next write
 * heals the view. Unknown fields read from an existing JSON file are
 * preserved on every write.
 *
 * @module kinship-plan/store
 */

// allow: SIZE_OK — one CAS state machine; path safety, atomic writes, and the four mutations share the same version invariant.

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { renderPlanMarkdown } from './markdown.js'
import {
  PLAN_DEFAULT_REVIEW_AT,
  PLAN_SCHEMA,
  PLAN_UNFINISHED_STATUSES,
  PlanClosedError,
  PlanConflictError,
  PlanItemNotFoundError,
  PlanNotFoundError,
  PlanOverlayPresentError,
  PlanValidationError,
  isValidTimeZone,
  nextDate,
  parsePlanDocument,
  requirePlanDate,
  serializePlanDocument,
  todayInTimeZone,
  type CarryOver,
  type PlanCloseInput,
  type PlanCloseResult,
  type PlanCommitInput,
  type PlanDocument,
  type PlanDoneInput,
  type PlanDoneResult,
  type PlanItem,
  type PlanNoteInput,
  type PlanPaths,
  type PlanReadResult,
  type PlanStatus,
} from './schema.js'

export interface PlanStoreOptions {
  /** Absolute plan root; never guessed here. */
  readonly root: string
  /** IANA time zone used when a tool omits `date`. */
  readonly timezone: string
  /** Allow a v1 truth file beside an existing v2 overlay for the same date. */
  readonly allowOverlayShadow?: boolean
  /** Test clock; defaults to `Date.now`. */
  readonly now?: () => number
}

interface AuditInput {
  readonly event: 'commit' | 'note' | 'done' | 'close'
  readonly version: number
  readonly expectedVersion?: number
  readonly entryId?: string
  readonly status?: string
  readonly reason?: string
}

let tmpSequence = 0

function existsAt(target: string): boolean {
  try {
    statSync(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function escapesRoot(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

function assertWithinRoot(rootReal: string, target: string): void {
  let probe = resolve(target)
  while (!existsAt(probe)) {
    const parent = dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  const real = realpathSync(probe)
  if (escapesRoot(relative(rootReal, real))) {
    throw new PlanValidationError('path', `refusing a path outside planRoot: ${target}`)
  }
}

function syncDirectory(dir: string): void {
  let fd: number | null = null
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    // Directory fsync is best-effort on filesystems that reject it; rename already committed the entry.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // The descriptor is already unusable; the rename remains committed.
      }
    }
  }
}

function writeFileAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${String(process.pid)}.${String(++tmpSequence)}.tmp`
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 })
    const fd = openSync(tmp, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
    syncDirectory(dirname(file))
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError
    }
    throw error
  }
}

function appendLine(file: string, line: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const fd = openSync(file, 'a', 0o600)
  try {
    const buffer = Buffer.from(line, 'utf8')
    let offset = 0
    while (offset < buffer.length) {
      offset += writeSync(fd, buffer, offset, buffer.length - offset)
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Daily plan store with per-date serialization and version CAS. */
export class PlanStore {
  private readonly root: string
  private readonly timezone: string
  private readonly allowOverlayShadow: boolean
  private readonly now: () => number
  private realRoot: string | null = null
  private readonly tails = new Map<string, Promise<unknown>>()

  constructor(options: PlanStoreOptions) {
    if (typeof options.root !== 'string' || options.root.trim() === '') {
      throw new PlanValidationError('root', 'must be a non-empty absolute path')
    }
    if (!isAbsolute(options.root)) {
      throw new PlanValidationError('root', `must be absolute: ${options.root}`)
    }
    if (!isValidTimeZone(options.timezone)) {
      throw new PlanValidationError('timezone', `unknown IANA time zone: ${options.timezone}`)
    }
    this.root = resolve(options.root)
    this.timezone = options.timezone
    this.allowOverlayShadow = options.allowOverlayShadow ?? false
    this.now = options.now ?? Date.now
  }

  rootPath(): string {
    return this.root
  }

  timeZone(): string {
    return this.timezone
  }

  paths(date: string): PlanPaths {
    const day = requirePlanDate(date)
    const real = this.resolveRealRoot()
    const dir = join(this.root, 'daily', day)
    const json = join(dir, `plan-${day}.json`)
    const markdown = join(dir, `计划-${day}.md`)
    const ledger = join(dir, 'plan-ledger.jsonl')
    const overlay = join(dir, `plan-${day}.overlay.json`)
    if (real !== null) {
      for (const target of [dir, json, markdown, ledger, overlay]) {
        assertWithinRoot(real, target)
      }
    }
    return { dir, json, markdown, ledger, overlay }
  }

  async read(date?: string): Promise<PlanReadResult> {
    const day = this.resolveDate(date)
    const paths = this.paths(day)
    const plan = this.readFile(day)
    const warning = existsAt(paths.overlay) ? 'overlay_present' as const : undefined
    return {
      found: plan !== null,
      date: day,
      version: plan?.version ?? 0,
      status: plan?.status ?? 'missing',
      plan,
      paths,
      ...(warning === undefined ? {} : { warning }),
    }
  }

  async commit(input: PlanCommitInput): Promise<PlanDocument> {
    const day = this.resolveDate(input.date)
    return this.enqueue(day, async () => {
      this.ensureRoot()
      const paths = this.paths(day)
      const current = this.readFile(day)
      const now = this.timestamp()

      if (current === null) {
        if (input.expectedVersion !== 0) {
          throw new PlanConflictError(day, input.expectedVersion, 0)
        }
        if (existsAt(paths.overlay) && !this.allowOverlayShadow) {
          throw new PlanOverlayPresentError(day, paths.overlay)
        }
        const plan = this.document({
          date: day,
          status: input.status ?? 'committed',
          version: 1,
          created_at: now,
          updated_at: now,
          review_at: input.reviewAt ?? PLAN_DEFAULT_REVIEW_AT,
          items: input.items,
          notes: input.notes ?? [],
          extra: {},
        })
        this.persist(paths, plan)
        this.appendAudit(paths, day, {
          event: 'commit',
          version: 1,
          expectedVersion: 0,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        })
        return plan
      }

      if (current.version !== input.expectedVersion) {
        throw new PlanConflictError(day, input.expectedVersion, current.version)
      }
      if (current.status === 'closed') throw new PlanClosedError(day)

      const reviewAt = input.reviewAt ?? current.review_at
      const plan = this.document({
        date: day,
        status: input.status ?? current.status,
        version: current.version + 1,
        created_at: current.created_at,
        updated_at: now,
        ...(reviewAt === undefined ? {} : { review_at: reviewAt }),
        items: input.items,
        notes: input.notes ?? current.notes,
        ...(current.carry_over === undefined ? {} : { carry_over: current.carry_over }),
        extra: current.extra,
      })
      this.persist(paths, plan)
      this.appendAudit(paths, day, {
        event: 'commit',
        version: plan.version,
        expectedVersion: current.version,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      })
      return plan
    })
  }

  async note(input: PlanNoteInput): Promise<PlanDocument> {
    const day = this.resolveDate(input.date)
    return this.enqueue(day, async () => {
      this.ensureRoot()
      const paths = this.paths(day)
      const current = this.requireExisting(day)
      if (current.version !== input.expectedVersion) {
        throw new PlanConflictError(day, input.expectedVersion, current.version)
      }
      if (current.status === 'closed') throw new PlanClosedError(day)
      const note = input.note.trim()
      if (note === '') throw new PlanValidationError('note', 'must be a non-empty string')
      const plan = this.document({
        date: day,
        status: current.status,
        version: current.version + 1,
        created_at: current.created_at,
        updated_at: this.timestamp(),
        ...(current.review_at === undefined ? {} : { review_at: current.review_at }),
        items: current.items,
        notes: [...current.notes, note],
        ...(current.carry_over === undefined ? {} : { carry_over: current.carry_over }),
        extra: current.extra,
      })
      this.persist(paths, plan)
      this.appendAudit(paths, day, {
        event: 'note',
        version: plan.version,
        expectedVersion: current.version,
        reason: note,
      })
      return plan
    })
  }

  async done(input: PlanDoneInput): Promise<PlanDoneResult> {
    const day = this.resolveDate(input.date)
    return this.enqueue(day, async () => {
      this.ensureRoot()
      const paths = this.paths(day)
      const current = this.requireExisting(day)
      if (current.version !== input.expectedVersion) {
        throw new PlanConflictError(day, input.expectedVersion, current.version)
      }
      if (current.status === 'closed') throw new PlanClosedError(day)
      const index = current.items.findIndex(item => item.id === input.id)
      if (index < 0) throw new PlanItemNotFoundError(day, input.id)
      const existing = current.items[index]
      if (existing === undefined) throw new PlanItemNotFoundError(day, input.id)
      const now = this.timestamp()
      const status = input.status ?? 'done'
      const note = input.note === undefined || input.note.trim() === ''
        ? existing.note
        : existing.note === undefined
          ? input.note
          : `${existing.note}\n${input.note}`
      const item: PlanItem = {
        ...existing,
        status,
        ...(status === 'done' ? { done_at: new Date(now).toISOString() } : {}),
        ...(note === undefined ? {} : { note }),
        ...(input.evidence === undefined || input.evidence.trim() === ''
          ? {}
          : { evidence: input.evidence }),
      }
      const items = current.items.map((row, at) => (at === index ? item : row))
      const plan = this.document({
        date: day,
        status: current.status,
        version: current.version + 1,
        created_at: current.created_at,
        updated_at: now,
        ...(current.review_at === undefined ? {} : { review_at: current.review_at }),
        items,
        notes: current.notes,
        ...(current.carry_over === undefined ? {} : { carry_over: current.carry_over }),
        extra: current.extra,
      })
      this.persist(paths, plan)
      this.appendAudit(paths, day, {
        event: 'done',
        version: plan.version,
        expectedVersion: current.version,
        entryId: item.id,
        status,
      })
      return { plan, item }
    })
  }

  async close(input: PlanCloseInput): Promise<PlanCloseResult> {
    const day = this.resolveDate(input.date)
    return this.enqueue(day, async () => {
      this.ensureRoot()
      const paths = this.paths(day)
      const current = this.requireExisting(day)
      if (current.version !== input.expectedVersion) {
        throw new PlanConflictError(day, input.expectedVersion, current.version)
      }
      if (current.status === 'closed') {
        const carried = current.carry_over?.items ?? []
        return {
          plan: current,
          carried,
          carryOver: current.carry_over ?? null,
          alreadyClosed: true,
        }
      }
      if (existsAt(paths.overlay) && !this.allowOverlayShadow) {
        throw new PlanOverlayPresentError(day, paths.overlay)
      }
      const now = this.timestamp()
      const carryTo = input.carryTo === undefined ? nextDate(day) : requirePlanDate(input.carryTo, 'carry_to')
      const carried: PlanItem[] = []
      const items = current.items.map(item => {
        if (!(PLAN_UNFINISHED_STATUSES as readonly string[]).includes(item.status)) return item
        const next: PlanItem = { ...item, status: 'carried' }
        carried.push(next)
        return next
      })
      const carryOver: CarryOver = {
        to: carryTo,
        created_at: now,
        items: carried,
        extra: {},
      }
      const summary = input.summary?.trim()
      const plan = this.document({
        date: day,
        status: 'closed',
        version: current.version + 1,
        created_at: current.created_at,
        updated_at: now,
        ...(current.review_at === undefined ? {} : { review_at: current.review_at }),
        items,
        notes: current.notes,
        carry_over: carryOver,
        extra: current.extra,
      })
      this.persist(paths, plan)
      this.appendAudit(paths, day, {
        event: 'close',
        version: plan.version,
        expectedVersion: current.version,
        ...(summary === undefined || summary === '' ? {} : { reason: summary }),
      })
      return { plan, carried, carryOver, alreadyClosed: false }
    })
  }

  private document(input: {
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
  }): PlanDocument {
    return {
      schema: PLAN_SCHEMA,
      date: input.date,
      status: input.status,
      version: input.version,
      created_at: input.created_at,
      updated_at: input.updated_at,
      ...(input.review_at === undefined ? {} : { review_at: input.review_at }),
      items: input.items,
      notes: input.notes,
      ...(input.carry_over === undefined ? {} : { carry_over: input.carry_over }),
      extra: input.extra,
    }
  }

  private resolveDate(date?: string): string {
    if (date === undefined || date.trim() === '') return todayInTimeZone(this.timezone)
    return requirePlanDate(date)
  }

  private readFile(day: string): PlanDocument | null {
    const paths = this.paths(day)
    if (!existsAt(paths.json)) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(paths.json, 'utf8'))
    } catch (error) {
      throw new PlanValidationError(
        'json',
        `cannot parse ${paths.json}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return parsePlanDocument(parsed, day)
  }

  private requireExisting(day: string): PlanDocument {
    const plan = this.readFile(day)
    if (plan === null) throw new PlanNotFoundError(day)
    return plan
  }

  private persist(paths: PlanPaths, plan: PlanDocument): void {
    writeFileAtomic(paths.json, `${JSON.stringify(serializePlanDocument(plan))}\n`)
    writeFileAtomic(paths.markdown, renderPlanMarkdown(plan))
  }

  private appendAudit(paths: PlanPaths, day: string, input: AuditInput): void {
    const row = {
      schema: PLAN_SCHEMA,
      at: this.timestamp(),
      date: day,
      source: 'plan' as const,
      event: input.event,
      ...(input.entryId === undefined ? {} : { entry_id: input.entryId }),
      ...(input.status === undefined ? {} : { status: input.status }),
      version: input.version,
      ...(input.expectedVersion === undefined ? {} : { expected_version: input.expectedVersion }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }
    appendLine(paths.ledger, `${JSON.stringify(row)}\n`)
  }

  private timestamp(): number {
    const now = this.now()
    if (!Number.isInteger(now) || now < 0) {
      throw new PlanValidationError('now', `clock must return a non-negative integer: ${String(now)}`)
    }
    return now
  }

  private ensureRoot(): void {
    mkdirSync(this.root, { recursive: true })
    if (!statSync(this.root).isDirectory()) {
      throw new PlanValidationError('root', `not a directory: ${this.root}`)
    }
    this.realRoot = realpathSync(this.root)
  }

  private resolveRealRoot(): string | null {
    if (this.realRoot !== null) return this.realRoot
    if (!existsAt(this.root)) return null
    if (!statSync(this.root).isDirectory()) {
      throw new PlanValidationError('root', `not a directory: ${this.root}`)
    }
    this.realRoot = realpathSync(this.root)
    return this.realRoot
  }

  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const run = previous.then(task, task)
    // The queue only needs settlement; the caller still receives run's original rejection.
    this.tails.set(key, run.catch(() => undefined))
    return run
  }
}
