/**
 * Data paths pushed by the Kinship backend.
 *
 * The backend owns the deployment layout (its AI root, resolved data root, and
 * plan tree), so the harness must not guess it from environment variables. One
 * push is validated, then written to `$DSH_HOME/kinship/paths.json` with a
 * same-dir temp + fsync + rename, mirroring the durable binding store: a reader
 * never sees a half-written file and a dsh restart replays the last accepted
 * paths instead of asking the owner to fill them in again.
 *
 * A corrupt document is skipped with a warning and treated as absent; the
 * plugin keeps mounting, only the routes answer 404 until the backend pushes
 * again.
 *
 * @module kinship-bridge/paths
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { BridgeError } from './errors.js'

/** Persisted paths document schema version. */
export const PATHS_SCHEMA = 1

/** One validated path push, exactly as the Kinship backend sends it. */
export interface PushedPaths {
  /** Wire schema; only `1` is accepted. */
  readonly schema: typeof PATHS_SCHEMA
  /** Absolute AI runtime root (the backend's `data.ai_root`). */
  readonly ai_root: string
  /** Absolute resolved data root (the backend's `data.dir`). */
  readonly data_dir: string
  /** Absolute plan tree root. */
  readonly plan_root: string
  /** Absolute plan master document, when the backend has one. */
  readonly plan_master?: string
  /** Producer label; the Kinship backend reports `kinship-backend`. */
  readonly source: string
  /** Producer generation time in epoch milliseconds. */
  readonly generated_at: number
}

/**
 * The durable record: one accepted push plus the time this bridge stored it.
 *
 * `stored_at` is bridge-owned, so it is absent from the wire request and added
 * by {@link PathsStore.save}.
 */
export interface StoredPaths extends PushedPaths {
  /** Bridge store time in epoch milliseconds. */
  readonly stored_at: number
}

/** The logging surface the store reports through (`ctx.logger`). */
export interface PathsLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
}

/** Options for one paths store. */
export interface PathsStoreOptions {
  /** Absolute `paths.json` path. */
  readonly path: string
  readonly logger?: PathsLogger
  /** Clock override for tests; defaults to `Date.now`. */
  readonly now?: () => number
}

/**
 * A push the route must reject with 400 `bad_request`.
 *
 * This is a `BridgeError`, so the server's existing error path renders it with
 * the contract's stable `{"error":"bad_request"}` body and no extra wiring.
 */
export class PathsValidationError extends BridgeError {
  constructor(message: string) {
    super(400, 'bad_request', message)
    this.name = 'PathsValidationError'
  }
}

let tmpSequence = 0

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Read one required absolute path field. */
function absolutePathField(value: unknown, field: string): string {
  if (!isNonEmptyString(value)) {
    throw new PathsValidationError(`Field "${field}" must be a non-empty absolute path.`)
  }
  if (!isAbsolute(value)) {
    throw new PathsValidationError(`Field "${field}" must be an absolute path: ${value}`)
  }
  return value
}

/**
 * Validate one pushed paths document.
 *
 * Unknown fields are dropped, so what is stored and replayed is exactly the
 * contract's set of paths. A relative path is refused rather than resolved
 * against the process working directory: a silently wrong root would point the
 * harness at an unrelated tree.
 *
 * @param value - untrusted JSON value from the request body or the persisted file.
 * @returns the normalized push document.
 * @throws {PathsValidationError} 400 `bad_request` naming the offending field.
 */
export function parsePushedPaths(value: unknown): PushedPaths {
  if (!isRecord(value)) {
    throw new PathsValidationError('Paths document must be a JSON object.')
  }
  if (value['schema'] !== PATHS_SCHEMA) {
    throw new PathsValidationError(`Field "schema" must be ${String(PATHS_SCHEMA)}.`)
  }
  const aiRoot = absolutePathField(value['ai_root'], 'ai_root')
  const dataDir = absolutePathField(value['data_dir'], 'data_dir')
  const planRoot = absolutePathField(value['plan_root'], 'plan_root')
  const rawPlanMaster = value['plan_master']
  const planMaster = rawPlanMaster === undefined
    ? undefined
    : absolutePathField(rawPlanMaster, 'plan_master')
  const source = value['source']
  if (!isNonEmptyString(source)) {
    throw new PathsValidationError('Field "source" must be a non-empty string.')
  }
  const generatedAt = value['generated_at']
  if (typeof generatedAt !== 'number' || !Number.isInteger(generatedAt) || generatedAt < 0) {
    throw new PathsValidationError('Field "generated_at" must be a non-negative integer.')
  }
  return {
    schema: PATHS_SCHEMA,
    ai_root: aiRoot,
    data_dir: dataDir,
    plan_root: planRoot,
    ...(planMaster === undefined ? {} : { plan_master: planMaster }),
    source,
    generated_at: generatedAt,
  }
}

/** Validate one persisted record, including the bridge-owned `stored_at`. */
function parseStoredPaths(value: unknown): StoredPaths {
  const pushed = parsePushedPaths(value)
  const storedAt = isRecord(value) ? value['stored_at'] : undefined
  if (typeof storedAt !== 'number' || !Number.isInteger(storedAt) || storedAt < 0) {
    throw new PathsValidationError('Field "stored_at" must be a non-negative integer.')
  }
  return { ...pushed, stored_at: storedAt }
}

/** Default paths document path for one Harness home. */
export function defaultPathsPath(home = process.env['DSH_HOME']): string {
  const base = isNonEmptyString(home) ? home : join(homedir(), '.dsh')
  return join(base, 'kinship', 'paths.json')
}

/**
 * Read and validate the persisted document.
 *
 * Every failure (unreadable, malformed JSON, or a document that fails
 * validation) degrades to "absent" with a warning: a bridge restart must keep
 * serving the other routes even when the last push was truncated.
 */
function readPersisted(path: string, logger: PathsLogger | undefined): StoredPaths | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    logger?.warn('kinship-bridge: ignoring unreadable %s: %s', path, messageOf(error))
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    logger?.warn('kinship-bridge: ignoring malformed %s: %s', path, messageOf(error))
    return null
  }
  try {
    return parseStoredPaths(parsed)
  } catch (error) {
    logger?.warn('kinship-bridge: ignoring %s: %s', path, messageOf(error))
    return null
  }
}

/** Atomic write of the complete stored record. */
function writePersisted(path: string, record: StoredPaths): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${String(process.pid)}.${String(++tmpSequence)}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    const fd = openSync(tmp, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError
    }
    throw error
  }
}

/**
 * Durable store for the last accepted paths document.
 *
 * One instance owns one `paths.json`. `load()` is explicit because the plugin
 * logs the replay; `save()` both persists and becomes the current document, so
 * `current()` always answers with what a restart would read back.
 */
export class PathsStore {
  private readonly filePath: string
  private readonly logger: PathsLogger | undefined
  private readonly now: () => number
  private state: StoredPaths | null = null

  constructor(options: PathsStoreOptions) {
    if (!isAbsolute(options.path)) {
      throw new Error(`kinship-bridge: paths path must be absolute: ${options.path}`)
    }
    this.filePath = options.path
    this.logger = options.logger
    this.now = options.now ?? Date.now
  }

  /** Absolute `paths.json` path this store owns. */
  path(): string {
    return this.filePath
  }

  /**
   * Read the persisted document into memory.
   *
   * @returns the loaded record, or null when nothing was ever pushed or the
   * stored document is corrupt (a warning is logged in that case).
   */
  load(): StoredPaths | null {
    this.state = readPersisted(this.filePath, this.logger)
    return this.state
  }

  /** Current document, or null before the first accepted push. */
  current(): StoredPaths | null {
    return this.state
  }

  /**
   * Persist one validated push atomically and make it current.
   *
   * @param input - validated push document from {@link parsePushedPaths}.
   * @param now - store time override; defaults to the store clock.
   * @returns the durable record, including `stored_at`.
   * @throws {BridgeError} 500 `paths_write_failed` when the file cannot be written.
   */
  save(input: PushedPaths, now?: number): StoredPaths {
    const record: StoredPaths = { ...input, stored_at: now ?? this.now() }
    try {
      writePersisted(this.filePath, record)
    } catch (error) {
      throw new BridgeError(
        500,
        'paths_write_failed',
        `Could not persist the kinship paths: ${messageOf(error)}`,
      )
    }
    this.state = record
    return record
  }
}
