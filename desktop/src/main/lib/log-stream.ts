import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  statSync,
  unwatchFile,
  watchFile,
  type StatWatcher,
} from 'node:fs'
import type { LogSource, LogStreamEvent } from '../../shared/types'
import { normalizeTailLines, readLogTail } from './log-tail'

export interface LogStreamTarget {
  isDestroyed(): boolean
  send(channel: string, event: LogStreamEvent): void
  once(event: 'destroyed', listener: () => void): void
}

export interface LogStreamOptions {
  readonly channel: string
  readonly paths: Readonly<Record<LogSource, string>>
  readonly pollIntervalMs?: number
  readonly maxBytesPerTick?: number
  readonly maxLinesPerEvent?: number
}

export interface LogStreamStartOptions {
  readonly lines?: number
  readonly sources?: readonly LogSource[]
}

interface SourceState {
  offset: number
  carry: string
  missing: boolean
  lastError: string | undefined
}

const DEFAULT_POLL_INTERVAL_MS = 500
const DEFAULT_MAX_BYTES_PER_TICK = 256 * 1024
const DEFAULT_MAX_LINES_PER_EVENT = 500

function clampLines(value: number): number {
  return Math.max(1, Math.min(Math.floor(value), 2000))
}

export class LogStreamService {
  private target: LogStreamTarget | null = null
  private activeSources: LogSource[] = []
  private initialLines = 300
  private readonly states = new Map<LogSource, SourceState>()
  private readonly watchers = new Map<
    LogSource,
    { readonly watcher: StatWatcher; readonly listener: () => void }
  >()
  private readonly maxBytesPerTick: number
  private readonly maxLinesPerEvent: number

  constructor(private readonly options: LogStreamOptions) {
    this.maxBytesPerTick = options.maxBytesPerTick ?? DEFAULT_MAX_BYTES_PER_TICK
    this.maxLinesPerEvent = options.maxLinesPerEvent ?? DEFAULT_MAX_LINES_PER_EVENT
  }

  start(target: LogStreamTarget, options: LogStreamStartOptions = {}): void {
    this.stop()
    this.target = target
    this.initialLines = normalizeTailLines(options.lines)
    this.activeSources = (options.sources ?? (['desktop', 'sensor'] as const)).filter(
      (source) => this.options.paths[source].length > 0,
    )

    target.once('destroyed', () => {
      this.stop()
    })

    for (const source of this.activeSources) {
      const path = this.options.paths[source]
      const tail = readLogTail(path, this.initialLines)
      const state: SourceState = {
        offset: existsSync(path) ? statSync(path).size : 0,
        carry: '',
        missing: !existsSync(path),
        lastError: tail.error,
      }
      this.states.set(source, state)
      this.send({
        source,
        type: 'snapshot',
        path,
        lines: tail.lines,
        ...(tail.error !== undefined ? { error: tail.error } : {}),
      })

      const listener = (): void => {
        this.pollSource(source)
      }
      const watcher = watchFile(
        path,
        { interval: this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, persistent: false },
        listener,
      )
      watcher.unref()
      this.watchers.set(source, { watcher, listener })
    }
  }

  stop(): void {
    for (const [source, entry] of this.watchers) {
      unwatchFile(this.options.paths[source], entry.listener)
      this.watchers.delete(source)
    }
    this.states.clear()
    this.activeSources = []
    this.target = null
  }

  pollOnce(): void {
    for (const source of this.activeSources) this.pollSource(source)
  }

  private send(event: LogStreamEvent): void {
    const target = this.target
    if (target === null || target.isDestroyed()) return
    try {
      target.send(this.options.channel, event)
    } catch {
      this.stop()
    }
  }

  private readSlice(path: string, start: number): { text: string; size: number } {
    let descriptor: number | undefined
    try {
      descriptor = openSync(path, 'r')
      const size = fstatSync(descriptor).size
      const length = Math.max(0, size - start)
      if (length === 0) return { text: '', size }
      const buffer = Buffer.alloc(length)
      readSync(descriptor, buffer, 0, length, start)
      return { text: buffer.toString('utf8'), size }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
  }

  private pollSource(source: LogSource): void {
    const state = this.states.get(source)
    const path = this.options.paths[source]
    if (state === undefined) return

    if (!existsSync(path)) {
      if (!state.missing) {
        state.missing = true
        state.offset = 0
        state.carry = ''
        state.lastError = '日志文件已被删除'
        this.send({
          source,
          type: 'reset',
          path,
          lines: [],
          error: state.lastError,
        })
      }
      return
    }

    if (state.missing) {
      state.missing = false
      state.offset = 0
      state.carry = ''
      const tail = readLogTail(path, this.initialLines)
      state.offset = statSync(path).size
      state.lastError = tail.error
      this.send({
        source,
        type: 'reset',
        path,
        lines: tail.lines,
        ...(tail.error !== undefined ? { error: tail.error } : {}),
      })
      return
    }

    try {
      const size = statSync(path).size
      if (size < state.offset) {
        state.offset = 0
        state.carry = ''
        const tail = readLogTail(path, this.initialLines)
        state.offset = size
        state.lastError = undefined
        this.send({ source, type: 'reset', path, lines: tail.lines })
        return
      }
      if (size === state.offset) return

      const previousOffset = state.offset
      const start = Math.max(previousOffset, size - this.maxBytesPerTick)
      const slice = this.readSlice(path, start)
      state.offset = slice.size
      state.lastError = undefined

      const skippedBytes = start > previousOffset
      const combined = (skippedBytes ? '' : state.carry) + slice.text
      const parts = combined.split(/\r?\n/)
      state.carry = parts.pop() ?? ''
      let lines = parts
      if (skippedBytes && lines.length > 0) lines.shift()
      if (lines.length === 0) return
      let dropped = skippedBytes
      if (lines.length > this.maxLinesPerEvent) {
        lines = lines.slice(-this.maxLinesPerEvent)
        dropped = true
      }
      this.send({
        source,
        type: 'append',
        path,
        lines,
        ...(dropped ? { reset: true } : {}),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      if (message === state.lastError) return
      state.lastError = message
      this.send({
        source,
        type: 'snapshot',
        path,
        lines: [],
        error: `读取日志失败：${message}`,
      })
    }
  }
}

export function normalizeLogSources(value: unknown): LogSource[] | null {
  if (value === undefined) return ['desktop', 'sensor']
  if (!Array.isArray(value)) return null
  const sources: LogSource[] = []
  for (const item of value) {
    if (item !== 'desktop' && item !== 'sensor') return null
    if (!sources.includes(item)) sources.push(item)
  }
  return sources.length === 0 ? null : sources
}

export function normalizeLogStreamLines(value: unknown): number {
  return clampLines(normalizeTailLines(value))
}
