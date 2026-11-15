import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PlanClosedError,
  PlanConflictError,
  PlanItemNotFoundError,
  PlanOverlayPresentError,
  type PlanItem,
  type PlanItemStatus,
} from '../../packages/kinship-plan/src/schema.js'
import { PlanStore } from '../../packages/kinship-plan/src/store.js'

const DATE = '2026-11-15'
const NOW = 1_800_000_000_000
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kinship-plan-'))
  roots.push(root)
  return root
}

function store(root = tempRoot()): PlanStore {
  return new PlanStore({ root, timezone: 'Asia/Shanghai', now: () => NOW })
}

function writeRaw(planStore: PlanStore, value: unknown, date = DATE): void {
  const paths = planStore.paths(date)
  mkdirSync(dirname(paths.json), { recursive: true })
  writeFileSync(paths.json, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRaw(planStore: PlanStore, date = DATE): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(planStore.paths(date).json, 'utf8'))
  if (!isRecord(parsed)) throw new Error('not an object')
  return parsed
}

function item(id: string, status: PlanItemStatus = 'planned'): PlanItem {
  return { id, kind: 'note', intent: `intent-${id}`, status, extra: {} }
}

function rawItem(id: string, status = 'planned'): Record<string, unknown> {
  return { id, kind: 'note', intent: `intent-${id}`, status }
}

describe('PlanStore', () => {
  it('creates the truth JSON, markdown, ledger, and survives a restart', async () => {
    const root = tempRoot()
    const first = store(root)
    const plan = await first.commit({
      date: DATE,
      expectedVersion: 0,
      items: [item('a')],
      notes: ['first note'],
    })
    expect(plan).toMatchObject({ date: DATE, version: 1, status: 'committed', review_at: '07:30' })

    const paths = first.paths(DATE)
    expect(existsSync(paths.json)).toBe(true)
    expect(existsSync(paths.markdown)).toBe(true)
    expect(existsSync(paths.ledger)).toBe(true)
    expect(readFileSync(paths.markdown, 'utf8')).toContain('## 条目')
    expect(readFileSync(paths.ledger, 'utf8').trim().split('\n')).toHaveLength(1)

    const second = store(root)
    const read = await second.read(DATE)
    expect(read).toMatchObject({ found: true, version: 1, status: 'committed' })
    expect(read.plan?.items[0]?.id).toBe('a')
  })

  it('preserves unknown top-level and item fields across note writes', async () => {
    const planStore = store()
    writeRaw(planStore, {
      schema: 1,
      date: DATE,
      status: 'committed',
      version: 1,
      created_at: NOW,
      updated_at: NOW,
      review_at: '08:10',
      coverage: { profile: 'merged_6', checkpoints: ['cov-08'], debt: [] },
      custom_top: { keep: true },
      items: [
        {
          ...rawItem('a'),
          instruction: 'do not drop me',
          custom_item: 42,
        },
      ],
      notes: ['existing'],
    })

    await planStore.note({ date: DATE, expectedVersion: 1, note: 'appended' })
    const raw = readRaw(planStore)
    expect(raw['coverage']).toEqual({ profile: 'merged_6', checkpoints: ['cov-08'], debt: [] })
    expect(raw['custom_top']).toEqual({ keep: true })
    const items = raw['items']
    expect(Array.isArray(items)).toBe(true)
    if (Array.isArray(items)) {
      expect(items[0]).toMatchObject({ id: 'a', instruction: 'do not drop me', custom_item: 42 })
    }
    expect(raw['notes']).toEqual(['existing', 'appended'])
    expect(raw['version']).toBe(2)
  })

  it('rejects a stale version without changing the file', async () => {
    const planStore = store()
    await planStore.commit({ date: DATE, expectedVersion: 0, items: [item('a')] })
    await expect(planStore.commit({
      date: DATE,
      expectedVersion: 2,
      items: [item('b')],
    })).rejects.toBeInstanceOf(PlanConflictError)
    expect((await planStore.read(DATE)).version).toBe(1)
  })

  it('marks one item done and records evidence', async () => {
    const planStore = store()
    await planStore.commit({ date: DATE, expectedVersion: 0, items: [item('a'), item('b')] })
    const result = await planStore.done({
      date: DATE,
      expectedVersion: 1,
      id: 'a',
      evidence: 'proved',
      note: 'done note',
    })
    expect(result.plan.version).toBe(2)
    expect(result.item).toMatchObject({ id: 'a', status: 'done', evidence: 'proved', note: 'done note' })
    expect(result.item.done_at).toBeTypeOf('string')

    await expect(planStore.done({
      date: DATE,
      expectedVersion: 2,
      id: 'missing',
    })).rejects.toBeInstanceOf(PlanItemNotFoundError)
  })

  it('closes, carries unfinished items, and is idempotent at the current version', async () => {
    const planStore = store()
    await planStore.commit({
      date: DATE,
      expectedVersion: 0,
      items: [item('done', 'done'), item('open'), item('skipped', 'skipped')],
    })
    const closed = await planStore.close({
      date: DATE,
      expectedVersion: 1,
      summary: 'closed today',
    })
    expect(closed.plan.status).toBe('closed')
    expect(closed.plan.version).toBe(2)
    expect(closed.carried.map(row => row.id)).toEqual(['open', 'skipped'])
    expect(closed.carryOver).toMatchObject({ to: '2026-11-16' })
    expect(closed.alreadyClosed).toBe(false)

    const again = await planStore.close({ date: DATE, expectedVersion: 2, summary: 'retry' })
    expect(again.alreadyClosed).toBe(true)
    expect(again.plan.version).toBe(2)
    await expect(planStore.note({ date: DATE, expectedVersion: 2, note: 'late' })).rejects.toBeInstanceOf(PlanClosedError)
  })

  it('refuses to shadow an existing overlay unless configured', async () => {
    const planStore = store()
    const paths = planStore.paths(DATE)
    mkdirSync(dirname(paths.overlay), { recursive: true })
    writeFileSync(paths.overlay, '{}\n', 'utf8')

    const read = await planStore.read(DATE)
    expect(read).toMatchObject({ found: false, warning: 'overlay_present' })
    await expect(planStore.commit({
      date: DATE,
      expectedVersion: 0,
      items: [item('a')],
    })).rejects.toBeInstanceOf(PlanOverlayPresentError)

    const shadow = new PlanStore({
      root: planStore.rootPath(),
      timezone: 'Asia/Shanghai',
      allowOverlayShadow: true,
      now: () => NOW,
    })
    await expect(shadow.commit({
      date: DATE,
      expectedVersion: 0,
      items: [item('a')],
    })).resolves.toMatchObject({ version: 1 })
  })

  it('rejects relative roots and invalid dates', () => {
    expect(() => new PlanStore({ root: 'relative/path', timezone: 'Asia/Shanghai' })).toThrow()
    const planStore = store()
    expect(() => planStore.paths('2026-02-30')).toThrow()
  })
})
