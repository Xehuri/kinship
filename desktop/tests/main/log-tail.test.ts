// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_LOG_TAIL_LINES,
  MAX_LOG_TAIL_LINES,
  normalizeTailLines,
  readLogTail,
} from '../../src/main/lib/log-tail'

describe('readLogTail', () => {
  let directory = ''

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'axeuh-log-tail-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('returns an error instead of throwing when the file is missing', () => {
    const view = readLogTail(join(directory, 'missing.log'))

    expect(view.lines).toEqual([])
    expect(view.error).toBeDefined()
  })

  it('returns only the requested number of trailing lines', () => {
    const file = join(directory, 'desktop.log')
    writeFileSync(file, Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\n'))

    expect(readLogTail(file, 3).lines).toEqual(['line 7', 'line 8', 'line 9'])
  })

  it('defaults to 300 lines and caps explicit requests at 2000', () => {
    const file = join(directory, 'desktop.log')
    writeFileSync(
      file,
      Array.from({ length: 2500 }, (_, index) => `line ${index}`).join('\n') + '\n',
    )

    expect(readLogTail(file).lines).toHaveLength(DEFAULT_LOG_TAIL_LINES)
    expect(readLogTail(file, 5000).lines).toHaveLength(MAX_LOG_TAIL_LINES)
    expect(readLogTail(file, 5000).lines.at(-1)).toBe('line 2499')
  })

  it('reports read errors without throwing', () => {
    const path = join(directory, 'not-a-file')
    mkdirSync(path)

    const view = readLogTail(path)

    expect(view.lines).toEqual([])
    expect(view.error).toBeDefined()
  })
})

describe('normalizeTailLines', () => {
  it('clamps and falls back safely', () => {
    expect(normalizeTailLines(undefined)).toBe(DEFAULT_LOG_TAIL_LINES)
    expect(normalizeTailLines(0)).toBe(1)
    expect(normalizeTailLines(-5)).toBe(1)
    expect(normalizeTailLines(9999)).toBe(MAX_LOG_TAIL_LINES)
    expect(normalizeTailLines('42')).toBe(42)
    expect(normalizeTailLines('nope')).toBe(DEFAULT_LOG_TAIL_LINES)
  })
})
