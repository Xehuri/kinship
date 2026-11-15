/**
 * Reader for the path document the Kinship backend pushes through the bridge.
 *
 * The operator configures no plan paths on the dsh side: the backend owns the
 * canonical `ai_root`/`data_dir`/`plan_root` and the sibling `kinship-bridge`
 * plugin persists them as `$DSH_HOME/kinship/paths.json` after every accepted
 * push (and announces the same document on the `kinship/paths` event).
 *
 * This module is deliberately standalone: it never imports the bridge package,
 * so the scheduler stays installable without a bridge. A missing file means "the
 * backend has not pushed yet" and is not an error; an unreadable or invalid
 * document is reported as a short `problem` string and never throws, because the
 * panel renders it and a broken push must not take the engine down.
 *
 * @module kinship-plan-scheduler/pushed-paths
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** One path document written by `kinship-bridge`, as published in `paths.json`. */
export interface PushedPaths {
  /** Document version; only `1` is accepted. */
  readonly schema: 1
  /** Absolute AI root of the Kinship deployment (`data.ai_root`). */
  readonly ai_root: string
  /** Absolute `data.dir` of the Kinship deployment. */
  readonly data_dir: string
  /** Absolute plan root; the scheduler's own `planRoot` default. */
  readonly plan_root: string
  /** Absolute `{plan_root}/plan/master.json`, informational. */
  readonly plan_master?: string
  /** Who wrote the document, for example `kinship-backend`. */
  readonly source: string
  /** Backend-side epoch milliseconds of the push. */
  readonly generated_at: number
  /** Bridge-side epoch milliseconds when the document was persisted. */
  readonly stored_at?: number
}

/** One read attempt: the validated document, or why it is unusable. */
export interface PushedPathsRead {
  /** Validated document, or null when nothing usable was pushed. */
  readonly paths: PushedPaths | null
  /** Short, panel-facing reason the document was refused; null otherwise. */
  readonly problem: string | null
}

/** File name the bridge writes under `$DSH_HOME/kinship`. */
const PATHS_FILE = 'paths.json'

function nonEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
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

/**
 * `$DSH_HOME` (or `~/.dsh` when unset) with the explicit argument winning.
 *
 * @param dshHome - optional override; a blank value falls back to the environment.
 * @returns the harness home directory as configured.
 */
function harnessHome(dshHome?: string): string {
  const explicit = nonEmpty(dshHome)
  if (explicit !== '') return explicit
  const fromEnv = nonEmpty(process.env['DSH_HOME'])
  return fromEnv === '' ? join(homedir(), '.dsh') : fromEnv
}

/**
 * Absolute path of the pushed-path document.
 *
 * @param dshHome - optional harness home override (tests, embedders).
 * @returns `<DSH_HOME>/kinship/paths.json`.
 */
export function pushedPathsPath(dshHome?: string): string {
  return join(harnessHome(dshHome), 'kinship', PATHS_FILE)
}

/** Absolute, non-empty path check; a relative path would point at the wrong tree. */
function requireAbsolutePath(value: unknown, field: string): PushedPathsRead | string {
  const path = nonEmpty(value)
  if (path === '') return { paths: null, problem: `${field} 不能为空。` }
  if (!isAbsolute(path)) {
    return { paths: null, problem: `${field} 必须是绝对路径（收到 ${path}）。` }
  }
  return path
}

/**
 * Validate one candidate document (from `paths.json` or the bridge event).
 *
 * @param value - parsed JSON or event payload.
 * @returns the narrow document, or a short problem when any required field is wrong.
 */
export function validatePushedPaths(value: unknown): PushedPathsRead {
  if (!isRecord(value)) {
    return { paths: null, problem: `paths 文档必须是对象（收到 ${describe(value)}）。` }
  }
  if (value['schema'] !== 1) {
    return { paths: null, problem: `paths 文档 schema 必须是 1（收到 ${describe(value['schema'])}）。` }
  }
  const aiRoot = requireAbsolutePath(value['ai_root'], 'ai_root')
  if (typeof aiRoot !== 'string') return aiRoot
  const dataDir = requireAbsolutePath(value['data_dir'], 'data_dir')
  if (typeof dataDir !== 'string') return dataDir
  const planRoot = requireAbsolutePath(value['plan_root'], 'plan_root')
  if (typeof planRoot !== 'string') return planRoot
  const generatedAt = value['generated_at']
  if (typeof generatedAt !== 'number' || !Number.isInteger(generatedAt) || generatedAt < 0) {
    return { paths: null, problem: `generated_at 必须是非负整数毫秒（收到 ${describe(generatedAt)}）。` }
  }
  const source = nonEmpty(value['source'])
  if (source === '') {
    return { paths: null, problem: `source 必须是非空字符串（收到 ${describe(value['source'])}）。` }
  }
  const planMaster = nonEmpty(value['plan_master'])
  const storedAt = value['stored_at']
  const storedIsValid =
    typeof storedAt === 'number' && Number.isInteger(storedAt) && storedAt >= 0
  return {
    paths: {
      schema: 1,
      ai_root: aiRoot,
      data_dir: dataDir,
      plan_root: planRoot,
      ...(planMaster === '' ? {} : { plan_master: planMaster }),
      source,
      generated_at: generatedAt,
      ...(storedIsValid ? { stored_at: storedAt } : {}),
    },
    problem: null,
  }
}

/**
 * Read and validate the pushed-path document.
 *
 * A missing file is "the backend has not pushed yet" and answers `problem: null`
 * so a fresh install renders as waiting rather than as broken. Every other
 * failure (unreadable, invalid JSON, refused field) answers a short problem.
 *
 * @param dshHome - optional harness home override; defaults to `$DSH_HOME`.
 * @returns the validated document, or null with an optional reason.
 */
export function readPushedPaths(dshHome?: string): PushedPathsRead {
  const path = pushedPathsPath(dshHome)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT') {
      return { paths: null, problem: null }
    }
    return {
      paths: null,
      problem: `无法读取 paths.json: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      paths: null,
      problem: `paths.json 不是有效 JSON: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return validatePushedPaths(parsed)
}
