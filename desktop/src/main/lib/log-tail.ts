import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'

export const DEFAULT_LOG_TAIL_LINES = 300
export const MAX_LOG_TAIL_LINES = 2000

const INITIAL_READ_BYTES = 256 * 1024
const MAX_READ_BYTES = 4 * 1024 * 1024

export interface LogTailView {
  path: string
  lines: string[]
  error?: string
}

export function normalizeTailLines(value: unknown): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(numeric)) return DEFAULT_LOG_TAIL_LINES
  return Math.max(1, Math.min(Math.floor(numeric), MAX_LOG_TAIL_LINES))
}

export function readLogTail(path: string, requestedLines?: unknown): LogTailView {
  const limit = normalizeTailLines(requestedLines)
  if (!existsSync(path)) {
    return { path, lines: [], error: '日志文件尚未生成' }
  }

  let descriptor: number | undefined
  try {
    descriptor = openSync(path, 'r')
    const size = fstatSync(descriptor).size
    if (size === 0) return { path, lines: [] }

    let windowBytes = Math.min(INITIAL_READ_BYTES, size)
    for (;;) {
      const start = Math.max(0, size - windowBytes)
      const length = size - start
      const buffer = Buffer.alloc(length)
      readSync(descriptor, buffer, 0, length, start)

      const raw = buffer.toString('utf8').split(/\r?\n/)
      if (start > 0) raw.shift()
      if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()

      if (raw.length >= limit || start === 0 || windowBytes >= MAX_READ_BYTES) {
        return { path, lines: raw.slice(-limit) }
      }
      windowBytes = Math.min(windowBytes * 2, MAX_READ_BYTES, size)
    }
  } catch (error) {
    return {
      path,
      lines: [],
      error: `读取日志失败：${error instanceof Error ? error.message : '未知错误'}`,
    }
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {
        descriptor = undefined
      }
    }
  }
}
