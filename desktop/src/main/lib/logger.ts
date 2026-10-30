import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import {
  LOG_DIRECTORY_NAME,
  LOG_FILENAME,
  LOG_ROTATE_BYTES,
} from '../../shared/constants'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogFields = Readonly<Record<string, string | number | boolean>>

let cachedLogFile: string | undefined

function resolveLogFile(): string {
  if (cachedLogFile === undefined) {
    const directory = join(app.getPath('userData'), LOG_DIRECTORY_NAME)
    mkdirSync(directory, { recursive: true })
    cachedLogFile = join(directory, LOG_FILENAME)
  }
  return cachedLogFile
}

function rotateIfNeeded(file: string): void {
  if (!existsSync(file)) return
  if (statSync(file).size < LOG_ROTATE_BYTES) return
  const rotated = `${file}.1`
  rmSync(rotated, { force: true })
  renameSync(file, rotated)
}

function write(level: LogLevel, message: string, fields?: LogFields): void {
  const suffix = fields === undefined ? '' : ` ${JSON.stringify(fields)}`
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}${suffix}`

  try {
    const file = resolveLogFile()
    rotateIfNeeded(file)
    appendFileSync(file, `${line}\n`, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error'
    console.error(`${line} [desktop-logger] write failed: ${reason}`) // no-excuse-ok: catch
  }
}

export const logger = {
  debug(message: string, fields?: LogFields): void {
    write('debug', message, fields)
  },
  info(message: string, fields?: LogFields): void {
    write('info', message, fields)
  },
  warn(message: string, fields?: LogFields): void {
    write('warn', message, fields)
  },
  error(message: string, fields?: LogFields): void {
    write('error', message, fields)
  },
}

export function getLogFilePath(): string {
  return resolveLogFile()
}
