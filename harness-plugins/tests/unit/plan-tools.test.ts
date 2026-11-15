import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PlanStore } from '../../packages/kinship-plan/src/store.js'
import {
  createPlanToolDefinitions,
  handlePlanAlias,
  handlePlanClose,
  handlePlanCommit,
  handlePlanDone,
  handlePlanNote,
  handlePlanRead,
} from '../../packages/kinship-plan/src/tools.js'

const DATE = '2026-11-15'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function store(): PlanStore {
  const root = mkdtempSync(join(tmpdir(), 'kinship-plan-tools-'))
  roots.push(root)
  return new PlanStore({ root, timezone: 'Asia/Shanghai', now: () => 1_800_000_000_000 })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function item(id: string): Record<string, unknown> {
  return {
    id,
    kind: 'care',
    intent: `intent-${id}`,
    status: 'planned',
    done_when: '12:00',
    extra_kept: { id },
  }
}

describe('plan tools', () => {
  it('registers the exact tool names', () => {
    expect(createPlanToolDefinitions(store()).map(tool => tool.name)).toEqual([
      'plan_read',
      'plan_overlay_read',
      'plan_commit',
      'plan_note',
      'plan_done',
      'plan_close',
      'plan',
    ])
  })

  it('reads a missing day as found:false', async () => {
    const planStore = store()
    const result = await handlePlanRead(planStore, { date: DATE })
    expect(result).toMatchObject({ found: false, date: DATE, version: 0, status: 'missing', plan: null })
    expect(result.paths.json).toContain(`plan-${DATE}.json`)
  })

  it('commits, reads back, notes, does, and closes through handlers', async () => {
    const planStore = store()
    const committed = await handlePlanCommit(planStore, {
      date: DATE,
      expected_version: 0,
      items: [item('a'), item('b')],
      notes: ['start'],
      reason: 'create',
    })
    expect(committed).toMatchObject({ ok: true, date: DATE, version: 1, status: 'committed' })
    expect(committed.json_path).toContain(`plan-${DATE}.json`)

    const read = await handlePlanRead(planStore, { date: DATE })
    expect(read.found).toBe(true)
    expect(isRecord(read.plan)).toBe(true)
    if (isRecord(read.plan)) {
      expect(read.plan['version']).toBe(1)
      const items = read.plan['items']
      expect(Array.isArray(items)).toBe(true)
      if (Array.isArray(items)) {
        expect(items[0]).toMatchObject({ id: 'a', extra_kept: { id: 'a' } })
      }
    }

    const noted = await handlePlanNote(planStore, { date: DATE, expected_version: 1, note: 'note' })
    expect(noted.version).toBe(2)

    const done = await handlePlanDone(planStore, { date: DATE, expected_version: 2, id: 'a', evidence: 'ok' })
    expect(done).toMatchObject({ version: 3, item: { id: 'a', status: 'done', evidence: 'ok' } })

    const closed = await handlePlanClose(planStore, {
      date: DATE,
      expected_version: 3,
      summary: 'done for today',
    })
    expect(closed).toMatchObject({ version: 4, status: 'closed', already_closed: false })
    expect(Array.isArray(closed.carried)).toBe(true)
    if (Array.isArray(closed.carried)) expect(closed.carried).toHaveLength(1)
  })

  it('maps the plan alias actions onto the same handlers', async () => {
    const planStore = store()
    const committed = await handlePlanAlias(planStore, {
      action: 'commit',
      date: DATE,
      expected_version: 0,
      items: [item('a')],
      notes: ['n'],
    })
    expect(committed.action).toBe('commit')
    expect(isRecord(committed.result)).toBe(true)

    const read = await handlePlanAlias(planStore, { action: 'read', date: DATE })
    expect(read.action).toBe('read')

    const revised = await handlePlanAlias(planStore, {
      action: 'revise',
      date: DATE,
      expected_version: 1,
      items: [item('b')],
    })
    expect(revised.action).toBe('revise')

    const noted = await handlePlanAlias(planStore, {
      action: 'note',
      date: DATE,
      expected_version: 2,
      note: 'alias note',
    })
    expect(noted.action).toBe('note')

    const done = await handlePlanAlias(planStore, {
      action: 'done',
      date: DATE,
      expected_version: 3,
      id: 'b',
    })
    expect(done.action).toBe('done')

    const closed = await handlePlanAlias(planStore, {
      action: 'close',
      date: DATE,
      expected_version: 4,
      summary: 'alias close',
    })
    expect(closed.action).toBe('close')
  })

  it('surfaces CAS conflicts through the handler', async () => {
    const planStore = store()
    await handlePlanCommit(planStore, { date: DATE, expected_version: 0, items: [item('a')] })
    await expect(handlePlanCommit(planStore, {
      date: DATE,
      expected_version: 2,
      items: [item('b')],
    })).rejects.toMatchObject({ code: 'plan_conflict' })
  })
})
