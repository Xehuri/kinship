import { isAbsolute, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Config, resolveRoots } from '../../packages/kinship-plan-scheduler/src/config.js'
import type { Config as PlanSchedulerConfig } from '../../packages/kinship-plan-scheduler/src/config.js'
import { createDefaultMaster } from '../../packages/kinship-plan-scheduler/src/defaults.js'
import { validateMasterPlanDocument } from '../../packages/kinship-plan-scheduler/src/plan/master-plan.js'
import type { MasterEntry, MasterPlanDocument } from '../../packages/kinship-plan-scheduler/src/plan/master-plan.js'

const ENV_KEYS = ['KINSHIP_PLAN_ROOT', 'KINSHIP_AI_ROOT', 'DSH_HOME'] as const
const savedEnv = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()
})

function config(patch: Partial<PlanSchedulerConfig> = {}): PlanSchedulerConfig {
  return {
    planRoot: '',
    stateDir: '',
    mode: 'live',
    timezone: 'Asia/Shanghai',
    anchors: ['05:00', '07:30'],
    watchdogMs: 60_000,
    horizonHours: 48,
    catchupMaxAgeHours: 8,
    debtAfterHours: 24,
    ...patch,
  }
}

function entryOf(document: MasterPlanDocument, id: string): MasterEntry {
  const entry = document.entries.find(candidate => candidate.id === id)
  if (entry === undefined) throw new Error(`missing seeded entry: ${id}`)
  return entry
}

const NOW = 1_800_000_000_000

describe('plan scheduler config', () => {
  it('prefers the plugin planRoot over KINSHIP_PLAN_ROOT', () => {
    process.env['KINSHIP_PLAN_ROOT'] = '/srv/env/plan'
    const roots = resolveRoots(config({ planRoot: '/srv/config/plan' }))
    expect(roots.planRoot).toBe(resolve('/srv/config/plan'))
    expect(roots.problem).toBeNull()
  })

  it('falls back to KINSHIP_PLAN_ROOT when the plugin planRoot is empty', () => {
    process.env['KINSHIP_PLAN_ROOT'] = '/srv/env/plan'
    const roots = resolveRoots(config())
    expect(roots.planRoot).toBe(resolve('/srv/env/plan'))
    expect(roots.problem).toBeNull()
  })

  it('falls back to KINSHIP_AI_ROOT/data when nothing else is set', () => {
    process.env['KINSHIP_AI_ROOT'] = '/srv/ai-root'
    const roots = resolveRoots(config())
    expect(roots.planRoot).toBe(join('/srv/ai-root', 'data'))
    expect(roots.problem).toBeNull()
  })

  it('refuses a relative configured planRoot', () => {
    const roots = resolveRoots(config({ planRoot: 'relative/plan' }))
    expect(roots.planRoot).toBeNull()
    expect(roots.problem).toContain('relative/plan')
  })

  it('refuses a relative KINSHIP_PLAN_ROOT', () => {
    process.env['KINSHIP_PLAN_ROOT'] = '../env-plan'
    const roots = resolveRoots(config())
    expect(roots.planRoot).toBeNull()
    expect(roots.problem).toContain('../env-plan')
  })

  it('reports a missing plan root instead of guessing one', () => {
    const roots = resolveRoots(config())
    expect(roots.planRoot).toBeNull()
    expect(roots.problem).not.toBeNull()
  })

  it('defaults stateDir to $DSH_HOME/kinship/state', () => {
    process.env['DSH_HOME'] = '/srv/dsh-home'
    expect(resolveRoots(config()).stateDir).toBe(join('/srv/dsh-home', 'kinship', 'state'))
  })

  it('absolutises a relative stateDir', () => {
    const roots = resolveRoots(config({ stateDir: 'state-cache' }))
    expect(isAbsolute(roots.stateDir)).toBe(true)
    expect(roots.stateDir).toBe(resolve('state-cache'))
  })

  it('ships the documented schema defaults', () => {
    const parse = Config as unknown as (data?: unknown) => PlanSchedulerConfig
    expect(parse({})).toMatchObject({
      planRoot: '',
      stateDir: '',
      mode: 'live',
      timezone: 'Asia/Shanghai',
      // Empty means "derive the anchors from the master plan".
      anchors: [],
      watchdogMs: 60_000,
      horizonHours: 48,
      catchupMaxAgeHours: 8,
      debtAfterHours: 24,
    })
  })
})

describe('default master schedule', () => {
  it('passes validation with the seeded ids and times', () => {
    const document = createDefaultMaster({ timezone: 'Asia/Shanghai', now: NOW })
    expect(validateMasterPlanDocument(document)).toEqual(document)
    expect(document).toMatchObject({
      schema: 1,
      kind: 'master-plan',
      timezone: 'Asia/Shanghai',
      version: 1,
      created_at: NOW,
      updated_at: NOW,
    })
    expect(document.entries.map(entry => entry.id)).toEqual([
      'daily-review',
      'compactor',
      'plan-build',
      'plan-review',
      'weather',
      'weekly-review',
      'cov-00',
      'cov-06',
      'cov-08',
      'cov-12',
      'cov-16',
      'cov-20',
      'cov-22',
    ])
    expect(entryOf(document, 'daily-review').schedule).toEqual({ kind: 'daily', at: '00:40' })
    expect(entryOf(document, 'compactor').schedule).toEqual({ kind: 'daily', at: '04:00' })
    expect(entryOf(document, 'plan-build').schedule).toEqual({ kind: 'daily', at: '05:00' })
    expect(entryOf(document, 'weather').schedule).toEqual({ kind: 'daily', at: '07:00' })
    expect(entryOf(document, 'plan-review').schedule).toEqual({ kind: 'daily', at: '07:30' })
    expect(entryOf(document, 'weekly-review').schedule).toEqual({ kind: 'weekly', days: ['mon'], at: '03:00' })
    expect(entryOf(document, 'cov-00')).toMatchObject({
      kind: 'anchor',
      action: 'coverage.run',
      target_date: 'today',
      window: '20:00~00:00',
    })
    expect(entryOf(document, 'cov-00').schedule).toEqual({ kind: 'daily', at: '00:00' })
    expect(entryOf(document, 'cov-06')).toMatchObject({ kind: 'anchor', window: '02:00~06:00' })
    expect(entryOf(document, 'cov-06').schedule).toEqual({ kind: 'daily', at: '06:00' })
  })

  it('gives every entry the fields a wake needs', () => {
    const document = createDefaultMaster({ timezone: 'Asia/Shanghai', now: NOW })
    for (const entry of document.entries) {
      expect(entry.title.length).toBeGreaterThan(0)
      expect(entry.enabled).toBe(true)
      expect(typeof entry.action).toBe('string')
      expect(entry.schedule).toBeTruthy()
      expect(entry.created_at).toBe(NOW)
      expect(entry.updated_at).toBe(NOW)
    }
  })

  it('gives authored slots an instruction and leaves coverage anchors to the renderer', () => {
    const document = createDefaultMaster({ timezone: 'Asia/Shanghai', now: NOW })
    for (const id of ['daily-review', 'compactor', 'plan-build', 'plan-review', 'weather', 'weekly-review']) {
      expect(entryOf(document, id).instruction?.trim()).toBeTruthy()
    }
    for (const id of ['cov-00', 'cov-06', 'cov-08', 'cov-12', 'cov-16', 'cov-20', 'cov-22']) {
      expect(entryOf(document, id).instruction).toBeUndefined()
    }
  })

  it('rejects an invalid timezone', () => {
    expect(() => createDefaultMaster({ timezone: 'Not/AZone', now: NOW })).toThrow()
  })
})
