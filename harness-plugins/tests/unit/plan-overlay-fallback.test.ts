/**
 * 覆盖层写回验收（master + overlay 模型）。
 *
 * 当日 `plan-{date}.json` 无法服务（缺失 / closed / 不含目标 id）时，
 * `plan_note` / `plan_done` 必须写当日覆盖层而不是另造一份 v1 真源；
 * `plan_overlay_read` 暴露母版条目与覆盖层版本，供模型继续写回。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateMasterPlanDocument } from 'kinship-plan-scheduler/plan/master-plan'
import {
  createOverlayPlanSupport,
  type OverlayPlanSupport,
} from '../../packages/kinship-plan/src/overlay.js'
import { PlanStore } from '../../packages/kinship-plan/src/store.js'
import {
  handlePlanAlias,
  handlePlanDone,
  handlePlanNote,
  handlePlanOverlayRead,
  type PlanOverlayReadView,
} from '../../packages/kinship-plan/src/tools.js'

const DATE = '2026-11-15'
const NOW = 1_800_000_000_000
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kinship-plan-overlay-'))
  roots.push(root)
  return root
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function readJson(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(parsed)) throw new Error(`not an object: ${path}`)
  return parsed
}

function masterDocument(): Record<string, unknown> {
  return {
    schema: 1,
    kind: 'master-plan',
    timezone: 'Asia/Shanghai',
    version: 3,
    created_at: NOW - 2_000,
    updated_at: NOW - 1_000,
    entries: [
      {
        id: 'fixed-breakfast',
        kind: 'fixed',
        title: '早餐',
        enabled: true,
        action: 'review.daily',
        schedule: { kind: 'daily', at: '07:00' },
        created_at: NOW - 2_000,
        updated_at: NOW - 1_000,
      },
      {
        id: 'anchor-plan-review',
        kind: 'anchor',
        title: '计划复盘',
        enabled: true,
        action: 'plan.review',
        schedule: { kind: 'daily', at: '07:30' },
        created_at: NOW - 2_000,
        updated_at: NOW - 1_000,
      },
    ],
  }
}

function writeMaster(root: string): void {
  writeJson(join(root, 'plan', 'master.json'), validateMasterPlanDocument(masterDocument()))
}

function v1Document(overrides: { readonly status?: string; readonly version?: number } = {}): Record<string, unknown> {
  return {
    schema: 1,
    date: DATE,
    status: 'committed',
    version: 2,
    created_at: NOW - 1_000,
    updated_at: NOW - 500,
    review_at: '07:30',
    items: [
      { id: 'v1-note-item', kind: 'note', intent: 'legacy item', status: 'planned' },
    ],
    notes: ['legacy'],
    ...overrides,
  }
}

function writeV1(root: string, overrides: { readonly status?: string; readonly version?: number } = {}): void {
  writeJson(join(root, 'daily', DATE, `plan-${DATE}.json`), v1Document(overrides))
}

function overlayPath(root: string): string {
  return join(root, 'daily', DATE, `plan-${DATE}.overlay.json`)
}

function ledgerRows(root: string): Record<string, unknown>[] {
  const path = join(root, 'daily', DATE, 'plan-ledger.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => {
      const parsed: unknown = JSON.parse(line)
      if (!isRecord(parsed)) throw new Error(`bad ledger row: ${line}`)
      return parsed
    })
}

function planStore(root: string): PlanStore {
  return new PlanStore({ root, timezone: 'Asia/Shanghai', now: () => NOW })
}

function overlaySupport(root: string): OverlayPlanSupport {
  return createOverlayPlanSupport(root, { now: () => NOW })
}

function entryOf(view: PlanOverlayReadView, id: string): Record<string, unknown> {
  const found = view.entries.find(candidate => isRecord(candidate) && candidate['id'] === id)
  if (!isRecord(found)) throw new Error(`entry ${id} missing from the effective view`)
  return found
}

const DONE_AT = new Date(NOW).toISOString()

describe('overlay write-back fallback', () => {
  it('creates the overlay on the first note, then merges done ops per id', async () => {
    const root = tempRoot()
    writeMaster(root)
    const store = planStore(root)
    const overlay = overlaySupport(root)

    // 无覆盖层时，有效视图就是母版的当日物化条目。
    const masterView = await handlePlanOverlayRead(store, overlay, { date: DATE })
    expect(masterView).toMatchObject({
      source: 'master',
      date: DATE,
      overlay_version: null,
      overlay_status: null,
    })
    expect(masterView.entries).toHaveLength(2)
    expect(entryOf(masterView, 'anchor-plan-review')).toMatchObject({
      kind: 'anchor',
      title: '计划复盘',
      action: 'plan.review',
      status: 'planned',
      at: '07:30',
    })

    // 没有 v1 真源：note 必须创建覆盖层 v1，并在创建时带上 note。
    const noted = await handlePlanNote(store, { date: DATE, note: 'first overlay note' }, overlay)
    expect(noted).toMatchObject({ ok: true, source: 'overlay', date: DATE, version: 1, status: 'draft' })
    expect(noted.json_path).toBe(overlayPath(root))

    const created = readJson(overlayPath(root))
    expect(created).toMatchObject({
      schema: 1,
      kind: 'plan-overlay',
      date: DATE,
      base_version: 3,
      version: 1,
      status: 'draft',
      ops: [],
      notes: ['first overlay note'],
      coverage: { profile: 'merged_7', checkpoints: ['anchor-plan-review'], debt: [] },
    })
    expect(ledgerRows(root)).toEqual([
      expect.objectContaining({
        date: DATE,
        source: 'plan',
        event: 'note',
        version: 1,
        reason: 'first overlay note',
      }),
    ])

    // done 走覆盖层：v1 缺失触发回退，写单个 update op。
    const done = await handlePlanDone(
      store,
      { date: DATE, expected_version: 1, id: 'anchor-plan-review', evidence: 'checked' },
      overlay,
    )
    expect(done).toMatchObject({
      ok: true,
      source: 'overlay',
      date: DATE,
      version: 2,
      item: { id: 'anchor-plan-review', status: 'done', evidence: 'checked' },
    })
    const afterDone = readJson(overlayPath(root))
    expect(afterDone['version']).toBe(2)
    expect(afterDone['ops']).toEqual([
      {
        op: 'update',
        id: 'anchor-plan-review',
        patch: { status: 'done', evidence: 'checked', done_at: DONE_AT },
      },
    ])

    const view = await handlePlanOverlayRead(store, overlay, { date: DATE })
    expect(view).toMatchObject({ source: 'overlay', overlay_version: 2, overlay_status: 'draft' })
    // 读视图只投影 id/kind/title/action/status/at；证据与 done_at 留在覆盖层 op 里。
    expect(entryOf(view, 'anchor-plan-review')).toMatchObject({
      id: 'anchor-plan-review',
      kind: 'anchor',
      status: 'done',
    })

    // 第二次 done 只提升版本，仍在同一 id 的一个 update op 上合并 patch。
    const again = await handlePlanDone(
      store,
      { date: DATE, expected_version: 2, id: 'anchor-plan-review', evidence: 'second' },
      overlay,
    )
    expect(again).toMatchObject({
      version: 3,
      item: { id: 'anchor-plan-review', status: 'done', evidence: 'second' },
    })
    const afterAgain = readJson(overlayPath(root))
    expect(afterAgain['version']).toBe(3)
    expect(afterAgain['ops']).toEqual([
      {
        op: 'update',
        id: 'anchor-plan-review',
        patch: { status: 'done', evidence: 'second', done_at: DONE_AT },
      },
    ])
    expect(ledgerRows(root)).toHaveLength(3)
    expect(ledgerRows(root)[1]).toMatchObject({
      event: 'done',
      entry_id: 'anchor-plan-review',
      status: 'done',
      version: 2,
    })
    expect(ledgerRows(root)[2]).toMatchObject({
      event: 'done',
      entry_id: 'anchor-plan-review',
      status: 'done',
      version: 3,
    })
  })

  it('keeps writing the open v1 plan while it can serve', async () => {
    const root = tempRoot()
    writeMaster(root)
    writeV1(root)
    const store = planStore(root)
    const overlay = overlaySupport(root)

    const noted = await handlePlanNote(
      store,
      { date: DATE, expected_version: 2, note: 'v1 note' },
      overlay,
    )
    expect(noted).toMatchObject({ ok: true, date: DATE, version: 3 })
    expect(noted.source).toBeUndefined()
    expect(noted.json_path).toBe(store.paths(DATE).json)

    const done = await handlePlanDone(
      store,
      { date: DATE, expected_version: 3, id: 'v1-note-item', evidence: 'v1 evidence' },
      overlay,
    )
    expect(done).toMatchObject({
      version: 4,
      item: { id: 'v1-note-item', status: 'done', evidence: 'v1 evidence' },
    })
    expect(done.source).toBeUndefined()
    expect(existsSync(overlayPath(root))).toBe(false)
    expect(readJson(store.paths(DATE).json)).toMatchObject({ version: 4, notes: ['legacy', 'v1 note'] })
  })

  it('falls back to the overlay when the v1 plan is closed', async () => {
    const root = tempRoot()
    writeMaster(root)
    writeV1(root, { status: 'closed', version: 5 })
    const store = planStore(root)
    const overlay = overlaySupport(root)

    const noted = await handlePlanNote(
      store,
      { date: DATE, expected_version: 5, note: 'closed plan note' },
      overlay,
    )
    expect(noted).toMatchObject({ ok: true, source: 'overlay', version: 1 })
    expect(readJson(overlayPath(root))).toMatchObject({
      version: 1,
      ops: [],
      notes: ['closed plan note'],
    })
    // v1 真源保持只读，一字未改。
    expect(readJson(store.paths(DATE).json)).toMatchObject({
      status: 'closed',
      version: 5,
      notes: ['legacy'],
    })
  })

  it('rejects an unknown id without adding an op', async () => {
    const root = tempRoot()
    writeMaster(root)
    const store = planStore(root)
    const overlay = overlaySupport(root)

    await expect(handlePlanDone(
      store,
      { date: DATE, expected_version: 0, id: 'missing-entry' },
      overlay,
    )).rejects.toThrow(/not in the effective plan/)

    // 只允许发生 ensureOverlay 的创建，不允许追加任何 op 或账本行。
    expect(readJson(overlayPath(root))).toMatchObject({ version: 1, ops: [] })
    expect(ledgerRows(root)).toEqual([])
  })

  it('requires expected_version on plan note while the open v1 plan exists', async () => {
    const root = tempRoot()
    writeMaster(root)
    writeV1(root)
    const store = planStore(root)
    const overlay = overlaySupport(root)

    // 有可服务的 v1 真源时不能悄悄改走覆盖层：缺版本要给出清晰校验错误。
    await expect(handlePlanNote(store, { date: DATE, note: 'no version' }, overlay))
      .rejects.toThrow(/expected_version/)
    expect(existsSync(overlayPath(root))).toBe(false)
  })

  it('applies the same fallback through the plan alias', async () => {
    const root = tempRoot()
    writeMaster(root)
    const store = planStore(root)
    const overlay = overlaySupport(root)

    const noted = await handlePlanAlias(
      store,
      { action: 'note', date: DATE, expected_version: 0, note: 'alias overlay note' },
      overlay,
    )
    expect(noted.action).toBe('note')
    expect(isRecord(noted.result)).toBe(true)
    if (isRecord(noted.result)) {
      expect(noted.result).toMatchObject({ ok: true, source: 'overlay', version: 1 })
    }

    const done = await handlePlanAlias(
      store,
      { action: 'done', date: DATE, expected_version: 1, id: 'fixed-breakfast' },
      overlay,
    )
    expect(done.action).toBe('done')
    const doc = readJson(overlayPath(root))
    expect(doc['version']).toBe(2)
    expect(doc['ops']).toEqual([
      { op: 'update', id: 'fixed-breakfast', patch: { status: 'done', done_at: DONE_AT } },
    ])
  })

  it('marks a master entry done without a version when the v1 plan is absent', async () => {
    const root = tempRoot()
    writeMaster(root)
    const store = planStore(root)
    const overlay = overlaySupport(root)

    const done = await handlePlanDone(
      store,
      { date: DATE, id: 'fixed-breakfast' },
      overlay,
    )
    expect(done).toMatchObject({ ok: true, source: 'overlay', version: 2 })
    const doc = readJson(overlayPath(root))
    expect(doc['base_version']).toBe(3)
    expect(doc['ops']).toEqual([
      { op: 'update', id: 'fixed-breakfast', patch: { status: 'done', done_at: DONE_AT } },
    ])
    expect(ledgerRows(root).some(row => row['event'] === 'done')).toBe(true)
  })

  it('asks for the version on plan done while the open v1 plan exists', async () => {
    const root = tempRoot()
    writeMaster(root)
    writeV1(root)
    const store = planStore(root)
    const overlay = overlaySupport(root)

    await expect(handlePlanDone(
      store,
      { date: DATE, id: 'fixed-breakfast' },
      overlay,
    )).rejects.toThrow(/is required for plan done while plan-2026-11-15\.json exists/)
    expect(existsSync(overlayPath(root))).toBe(false)
  })

  it('falls back to the overlay for plan done without a version when v1 is closed', async () => {
    const root = tempRoot()
    writeMaster(root)
    writeV1(root, { status: 'closed', version: 4 })
    const store = planStore(root)
    const overlay = overlaySupport(root)

    const done = await handlePlanDone(
      store,
      { date: DATE, id: 'fixed-breakfast' },
      overlay,
    )
    expect(done).toMatchObject({ ok: true, source: 'overlay', version: 2 })
    expect(readJson(overlayPath(root))['ops']).toEqual([
      { op: 'update', id: 'fixed-breakfast', patch: { status: 'done', done_at: DONE_AT } },
    ])
  })

  it('reports that the master plan is required when none exists', async () => {
    const root = tempRoot()
    const store = planStore(root)
    const overlay = overlaySupport(root)

    await expect(handlePlanNote(store, { date: DATE, note: 'no master' }, overlay))
      .rejects.toThrow(/master plan is required/)
    await expect(handlePlanDone(
      store,
      { date: DATE, expected_version: 0, id: 'anything' },
      overlay,
    )).rejects.toThrow(/master plan is required/)
    expect(existsSync(overlayPath(root))).toBe(false)
  })
})
