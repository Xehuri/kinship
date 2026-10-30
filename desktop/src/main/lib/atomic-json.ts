import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

export class FileMissingError extends Error {
  readonly code = 'FILE_MISSING' as const
  readonly path: string

  constructor(path: string) {
    super(`文件不存在：${path}`)
    this.name = 'FileMissingError'
    this.path = path
  }
}

export class JsonParseError extends Error {
  readonly code = 'JSON_PARSE' as const
  readonly path: string

  constructor(path: string, reason: string) {
    super(`JSON 解析失败：${reason}`)
    this.name = 'JsonParseError'
    this.path = path
  }
}

function hasErrnoCode(error: unknown): error is { readonly code: unknown } {
  return typeof error === 'object' && error !== null && 'code' in error
}

export function readJsonFile<T>(path: string): T {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (hasErrnoCode(error) && error.code === 'ENOENT') {
      throw new FileMissingError(path)
    }
    throw error
  }

  try {
    const parsed: unknown = JSON.parse(text)
    return parsed as T
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new JsonParseError(path, error.message)
    }
    throw error
  }
}

export interface WriteJsonOptions {
  readonly backup?: boolean
  readonly mode?: number
}

export function writeJsonAtomic(
  path: string,
  value: unknown,
  options: WriteJsonOptions = {},
): void {
  mkdirSync(dirname(path), { recursive: true })

  const mode = options.mode ?? 0o600
  const tempPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`

  try {
    writeFileSync(tempPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode })
    if (options.backup === true && existsSync(path)) {
      copyFileSync(path, `${path}.bak`)
    }
    renameSync(tempPath, path)
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }
}
