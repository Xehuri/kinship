// @vitest-environment node
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LogStreamService, type LogStreamTarget } from '../../src/main/lib/log-stream'
import type { LogSource, LogStreamEvent } from '../../src/shared/types'

class FakeTarget implements LogStreamTarget {
  readonly events: Array<{ channel: string; event: LogStreamEvent }> = []
  destroyed = false

  isDestroyed(): boolean {
    return this.destroyed
  }

  send(channel: string, event: LogStreamEvent): void {
    this.events.push({ channel, event })
  }

  once(): void {
    return
  }
}

describe('LogStreamService', () => {
  let directory = ''
  let desktopPath = ''
  let sensorPath = ''
  let service: LogStreamService
  let target: FakeTarget

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'axeuh-log-stream-'))
    desktopPath = join(directory, 'desktop.log')
    sensorPath = join(directory, 'pc-sensor.log')
    writeFileSync(desktopPath, 'one\ntwo\nthree\n', 'utf8')
    writeFileSync(sensorPath, 'sensor-one\n', 'utf8')
    service = new LogStreamService({
      channel: 'axeuh:logs:stream:event',
      paths: { desktop: desktopPath, sensor: sensorPath } satisfies Record<LogSource, string>,
      pollIntervalMs: 100_000,
      maxLinesPerEvent: 100,
    })
    target = new FakeTarget()
  })

  afterEach(() => {
    service.stop()
    rmSync(directory, { recursive: true, force: true })
  })

  it('emits an initial tail snapshot for both sources', () => {
    service.start(target, { lines: 2 })

    const snapshots = target.events.map((entry) => entry.event)
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0]).toMatchObject({
      source: 'desktop',
      type: 'snapshot',
      lines: ['two', 'three'],
    })
    expect(snapshots[1]).toMatchObject({ source: 'sensor', type: 'snapshot' })
    expect(target.events[0]?.channel).toBe('axeuh:logs:stream:event')
  })

  it('appends only new lines and carries partial writes', () => {
    service.start(target, { lines: 1 })
    target.events.length = 0

    appendFileSync(desktopPath, 'four\nfive', 'utf8')
    service.pollOnce()
    expect(target.events.at(-1)?.event).toMatchObject({
      source: 'desktop',
      type: 'append',
      lines: ['four'],
    })

    appendFileSync(desktopPath, '\nsix\n', 'utf8')
    service.pollOnce()
    expect(target.events.at(-1)?.event).toMatchObject({
      source: 'desktop',
      type: 'append',
      lines: ['five', 'six'],
    })
  })

  it('resets on truncation and rotation', () => {
    service.start(target, { lines: 2 })
    target.events.length = 0

    truncateSync(desktopPath, 0)
    service.pollOnce()
    expect(target.events.at(-1)?.event).toMatchObject({
      source: 'desktop',
      type: 'reset',
      lines: [],
    })

    writeFileSync(desktopPath, 'rotated-a\nrotated-b\n', 'utf8')
    service.pollOnce()
    expect(target.events.at(-1)?.event).toMatchObject({
      source: 'desktop',
      type: 'append',
      lines: ['rotated-a', 'rotated-b'],
    })

    appendFileSync(desktopPath, 'rotated-c\n', 'utf8')
    service.pollOnce()
    target.events.length = 0
    writeFileSync(desktopPath, 'new-a\n', 'utf8')
    service.pollOnce()
    expect(target.events.at(-1)?.event).toMatchObject({
      source: 'desktop',
      type: 'reset',
      lines: ['new-a'],
    })
  })

  it('handles missing files appearing and disappearing', () => {
    unlinkSync(sensorPath)
    service.start(target, { lines: 3 })
    expect(
      target.events.find((entry) => entry.event.source === 'sensor')?.event,
    ).toMatchObject({ type: 'snapshot', lines: [], error: '日志文件尚未生成' })

    writeFileSync(sensorPath, 'fresh-1\nfresh-2\n', 'utf8')
    service.pollOnce()
    expect(target.events.at(-1)?.event).toMatchObject({
      source: 'sensor',
      type: 'reset',
      lines: ['fresh-1', 'fresh-2'],
    })

    unlinkSync(sensorPath)
    service.pollOnce()
    expect(target.events.at(-1)?.event).toMatchObject({
      source: 'sensor',
      type: 'reset',
      lines: [],
      error: '日志文件已被删除',
    })
  })

  it('caps appended lines and flags dropped output', () => {
    const capped = new LogStreamService({
      channel: 'axeuh:logs:stream:event',
      paths: { desktop: desktopPath, sensor: sensorPath },
      pollIntervalMs: 100_000,
      maxLinesPerEvent: 2,
    })
    capped.start(target, { lines: 1 })
    target.events.length = 0

    appendFileSync(desktopPath, 'four\nfive\nsix\n', 'utf8')
    capped.pollOnce()

    expect(target.events.at(-1)?.event).toMatchObject({
      type: 'append',
      lines: ['five', 'six'],
      reset: true,
    })
    capped.stop()
  })

  it('caps bytes per poll and drops the partial leading line after a gap', () => {
    const capped = new LogStreamService({
      channel: 'axeuh:logs:stream:event',
      paths: { desktop: desktopPath, sensor: sensorPath },
      pollIntervalMs: 100_000,
      maxBytesPerTick: 5,
      maxLinesPerEvent: 100,
    })
    capped.start(target, { lines: 1 })
    target.events.length = 0

    appendFileSync(desktopPath, 'aa\nbb\ncc\n', 'utf8')
    capped.pollOnce()

    expect(target.events.at(-1)?.event).toMatchObject({
      type: 'append',
      lines: ['cc'],
      reset: true,
    })
    capped.stop()
  })

  it('stops delivering events after stop and on target destruction', () => {
    service.start(target, { lines: 1 })
    service.stop()
    target.events.length = 0

    appendFileSync(desktopPath, 'ignored\n', 'utf8')
    service.pollOnce()
    expect(target.events).toEqual([])

    service.start(target, { lines: 1 })
    target.destroyed = true
    target.events.length = 0
    appendFileSync(desktopPath, 'also-ignored\n', 'utf8')
    service.pollOnce()
    expect(target.events).toEqual([])
  })
})
