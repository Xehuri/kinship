/**
 * Pushed paths drive the plan scheduler: the reader/validator, the precedence
 * of the root candidates, the master-driven scheduling profile, and the live
 * restart the `kinship/paths` event triggers.
 *
 * The restart cases mount the real plugin over a real Cordis context (the
 * `bridge-deliver.test.ts` seam) so the assertion covers the wiring, not a
 * stand-in: a push that moves `plan_root` must swap the engine, and a push that
 * repeats it must only refresh the provenance the panel renders.
 */

import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Config,
  apply,
  inject,
  name as pluginName,
} from '../../packages/kinship-plan-scheduler/src/index.js'
import type { KinshipPlanSchedulerService } from '../../packages/kinship-plan-scheduler/src/index.js'
import { resolveRoots } from '../../packages/kinship-plan-scheduler/src/config.js'
import type { Config as PlanSchedulerConfig } from '../../packages/kinship-plan-scheduler/src/config.js'
import { createDefaultMaster } from '../../packages/kinship-plan-scheduler/src/defaults.js'
import { validateMasterPlanDocument } from '../../packages/kinship-plan-scheduler/src/plan/master-plan.js'
import type { MasterPlanDocument } from '../../packages/kinship-plan-scheduler/src/plan/master-plan.js'
import { deriveAnchors, selectTimezone } from '../../packages/kinship-plan-scheduler/src/plan-profile.js'
import { pushedPathsPath, readPushedPaths } from '../../packages/kinship-plan-scheduler/src/pushed-paths.js'
import type { PushedPaths } from '../../packages/kinship-plan-scheduler/src/pushed-paths.js'

const ENV_KEYS = ['KINSHIP_PLAN_ROOT', 'KINSHIP_AI_ROOT', 'DSH_HOME'] as const
const savedEnv = new Map<string, string | undefined>()
const homes: string[] = []

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
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  homes.push(dir)
  return dir
}

function config(patch: Partial<PlanSchedulerConfig> = {}): PlanSchedulerConfig {
  return {
    planRoot: '',
    stateDir: '',
    mode: 'live',
    timezone: 'Asia/Shanghai',
    anchors: [],
    watchdogMs: 60_000,
    horizonHours: 48,
    catchupMaxAgeHours: 8,
    debtAfterHours: 24,
    ...patch,
  }
}

function pushedDocument(patch: Partial<PushedPaths> = {}): PushedPaths {
  return {
    schema: 1,
    ai_root: '/srv/kinship/ai',
    data_dir: '/srv/kinship/ai/data',
    plan_root: '/srv/kinship/ai/data',
    plan_master: '/srv/kinship/ai/data/plan/master.json',
    source: 'kinship-backend',
    generated_at: 1_794_759_000_000,
    stored_at: 1_794_759_000_100,
    ...patch,
  }
}

/** Write one paths document under a temp harness home; returns that home. */
function writePathsHome(document: unknown): string {
  const home = tempDir('pushed-paths-home-')
  const path = pushedPathsPath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(document), 'utf8')
  return home
}

const NOW = 1_800_000_000_000

/** Seeded master document with the two plan slots moved to the wanted clocks. */
function masterDocument(
  timezone: string,
  buildAt: string,
  reviewAt: string,
  now = NOW,
): MasterPlanDocument {
  const base = createDefaultMaster({ timezone, now })
  const entries = base.entries.map(entry => {
    if (entry.id === 'plan-build') return { ...entry, schedule: { kind: 'daily' as const, at: buildAt } }
    if (entry.id === 'plan-review') return { ...entry, schedule: { kind: 'daily' as const, at: reviewAt } }
    return entry
  })
  return validateMasterPlanDocument({ ...base, entries })
}

/** Create a plan root carrying one writable master document. */
function planRootWithMaster(document: MasterPlanDocument): string {
  const root = tempDir('plan-root-')
  mkdirSync(join(root, 'plan'), { recursive: true })
  writeFileSync(join(root, 'plan', 'master.json'), `${JSON.stringify(document)}\n`, 'utf8')
  return root
}

describe('readPushedPaths', () => {
  it('resolves the document under $DSH_HOME/kinship/paths.json', () => {
    expect(pushedPathsPath('/srv/dsh-home')).toBe(join('/srv/dsh-home', 'kinship', 'paths.json'))
    process.env['DSH_HOME'] = '/srv/from-env'
    expect(pushedPathsPath()).toBe(join('/srv/from-env', 'kinship', 'paths.json'))
  })

  it('accepts a valid push and keeps its provenance fields', () => {
    const home = writePathsHome(pushedDocument())
    const read = readPushedPaths(home)
    expect(read.problem).toBeNull()
    expect(read.paths).toEqual(pushedDocument())
  })

  it('treats a missing document as "nothing pushed yet", not as a failure', () => {
    const home = tempDir('pushed-paths-empty-')
    expect(readPushedPaths(home)).toEqual({ paths: null, problem: null })
  })

  it('reports corrupt JSON instead of throwing', () => {
    const home = tempDir('pushed-paths-corrupt-')
    const path = pushedPathsPath(home)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{oops', 'utf8')
    let read: ReturnType<typeof readPushedPaths> | undefined
    expect(() => {
      read = readPushedPaths(home)
    }).not.toThrow()
    expect(read?.paths).toBeNull()
    expect(read?.problem).toContain('JSON')
  })

  it('refuses a relative plan_root', () => {
    const home = writePathsHome(pushedDocument({ plan_root: 'relative/plan' }))
    const read = readPushedPaths(home)
    expect(read.paths).toBeNull()
    expect(read.problem).toContain('plan_root')
    expect(read.problem).toContain('relative/plan')
  })

  it('refuses an unsupported schema version', () => {
    const home = writePathsHome({ ...pushedDocument(), schema: 2 })
    const read = readPushedPaths(home)
    expect(read.paths).toBeNull()
    expect(read.problem).toContain('schema')
  })

  it('refuses a document without an integer generated_at', () => {
    const home = writePathsHome({ ...pushedDocument(), generated_at: 'yesterday' })
    const read = readPushedPaths(home)
    expect(read.paths).toBeNull()
    expect(read.problem).toContain('generated_at')
  })
})

describe('resolveRoots provenance', () => {
  it('prefers the pushed plan_root over the plugin row and the environment', () => {
    process.env['KINSHIP_PLAN_ROOT'] = '/srv/env/plan'
    const roots = resolveRoots(config({ planRoot: '/srv/config/plan' }), pushedDocument())
    expect(roots.planRoot).toBe('/srv/kinship/ai/data')
    expect(roots.source).toBe('pushed')
    expect(roots.problem).toBeNull()
    expect(roots.pushed?.source).toBe('kinship-backend')
  })

  it('falls back to the plugin row when nothing was pushed', () => {
    const roots = resolveRoots(config({ planRoot: '/srv/config/plan' }), null)
    expect(roots.planRoot).toBe('/srv/config/plan')
    expect(roots.source).toBe('config')
    expect(roots.pushed).toBeNull()
  })

  it('falls back to KINSHIP_PLAN_ROOT, then to KINSHIP_AI_ROOT/data', () => {
    process.env['KINSHIP_PLAN_ROOT'] = '/srv/env/plan'
    process.env['KINSHIP_AI_ROOT'] = '/srv/ai-root'
    expect(resolveRoots(config())).toMatchObject({ planRoot: '/srv/env/plan', source: 'env' })
    delete process.env['KINSHIP_PLAN_ROOT']
    expect(resolveRoots(config())).toMatchObject({
      planRoot: join('/srv/ai-root', 'data'),
      source: 'default',
    })
  })

  it('skips a refused relative candidate instead of hiding the next one', () => {
    process.env['KINSHIP_PLAN_ROOT'] = '/srv/env/plan'
    const roots = resolveRoots(config({ planRoot: 'relative/config-plan' }))
    expect(roots.planRoot).toBe('/srv/env/plan')
    expect(roots.source).toBe('env')
    expect(roots.problem).toBeNull()
  })

  it('reports the highest refused candidate when nothing resolves', () => {
    const roots = resolveRoots(config({ planRoot: 'relative/config-plan' }))
    expect(roots.planRoot).toBeNull()
    expect(roots.source).toBeNull()
    expect(roots.problem).toContain('relative/config-plan')
  })

  it('reports a refused pushed plan_root when nothing else resolves', () => {
    const roots = resolveRoots(
      config({ planRoot: 'relative/config-plan' }),
      pushedDocument({ plan_root: 'relative/pushed' }),
    )
    expect(roots.planRoot).toBeNull()
    // The pushed candidate outranks the plugin row, so it is the reported one.
    expect(roots.problem).toContain('relative/pushed')
    expect(roots.pushedProblem).toContain('relative/pushed')
  })

  it('keeps resolving when the pushed plan_root is refused but config applies', () => {
    const roots = resolveRoots(
      config({ planRoot: '/srv/config/plan' }),
      pushedDocument({ plan_root: 'relative/pushed' }),
    )
    expect(roots.planRoot).toBe('/srv/config/plan')
    expect(roots.source).toBe('config')
    expect(roots.problem).toBeNull()
  })

  it('keeps stateDir independent of the plan-root candidate', () => {
    process.env['DSH_HOME'] = '/srv/dsh-home'
    const roots = resolveRoots(config(), pushedDocument())
    expect(roots.stateDir).toBe(join('/srv/dsh-home', 'kinship', 'state'))
  })
})

describe('master-driven scheduling profile', () => {
  it('derives the anchors from the daily plan slots, sorted and unique', () => {
    const master = masterDocument('Asia/Shanghai', '07:30', '05:00')
    expect(deriveAnchors(master, [])).toEqual({ anchors: ['05:00', '07:30'], source: 'master' })
  })

  it('keeps an explicit plugin-row anchor list', () => {
    const master = masterDocument('Asia/Shanghai', '07:30', '05:00')
    expect(deriveAnchors(master, ['06:15'])).toEqual({ anchors: ['06:15'], source: 'config' })
  })

  it('ignores non-daily plan slots and falls back to the historical pair', () => {
    const base = createDefaultMaster({ timezone: 'Asia/Shanghai', now: NOW })
    const entries = base.entries.map(entry =>
      entry.id === 'plan-build' || entry.id === 'plan-review'
        ? { ...entry, schedule: { kind: 'weekly' as const, days: ['mon'], at: '05:00' } }
        : entry,
    )
    const master = validateMasterPlanDocument({ ...base, entries })
    expect(deriveAnchors(master, [])).toEqual({ anchors: ['05:00', '07:30'], source: 'default' })
    expect(deriveAnchors(null, [])).toEqual({ anchors: ['05:00', '07:30'], source: 'default' })
  })

  it('takes the timezone from the master and the plugin row otherwise', () => {
    const master = masterDocument('America/New_York', '09:15', '21:45')
    expect(selectTimezone(master, 'Asia/Shanghai')).toBe('America/New_York')
    expect(selectTimezone(null, 'Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(selectTimezone(null, '')).toBe('Asia/Shanghai')
  })
})

/* ───────────────────── live restart through the real plugin ───────────────────── */

interface MountedScheduler {
  readonly service: KinshipPlanSchedulerService
  emitPaths(payload: unknown): void
  dispose(): Promise<void>
}

async function mountScheduler(patch: Partial<PlanSchedulerConfig> = {}): Promise<MountedScheduler> {
  const ctx = new Context()
  ctx.provide('agents', { list: () => [], get: () => undefined })
  const fiber = ctx.plugin({ name: pluginName, inject, apply, Config }, {
    ...config({ watchdogMs: 0 }),
    ...patch,
  })
  await fiber
  const service = ctx.get('kinshipPlanScheduler')
  if (service === undefined) throw new Error('kinshipPlanScheduler service missing')
  return {
    service,
    emitPaths: (payload: unknown) => {
      const emitter = ctx as unknown as { emit: (event: string, value: unknown) => void }
      emitter.emit.call(ctx, 'kinship/paths', payload)
    },
    dispose: async () => {
      await fiber.dispose()
    },
  }
}

/** Poll `probe` until it answers a value; the restart runs off the event turn. */
async function until(probe: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (probe()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }
}

describe('pushed paths drive the running engine', () => {
  it('boots on the pushed root and restarts when a push moves it', async () => {
    const home = tempDir('pushed-paths-live-')
    process.env['DSH_HOME'] = home

    const rootA = planRootWithMaster(masterDocument('Asia/Shanghai', '05:00', '07:30'))
    const rootB = planRootWithMaster(masterDocument('America/New_York', '09:15', '21:45'))
    const path = pushedPathsPath(home)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify(pushedDocument({ plan_root: rootA, stored_at: 1_794_759_000_100 })),
      'utf8',
    )

    const mounted = await mountScheduler()
    try {
      const roots = mounted.service.roots()
      expect(roots).toMatchObject({ planRoot: rootA, source: 'pushed', anchorsSource: 'master' })
      expect(roots.pushedAt).toBe(1_794_759_000_100)
      expect(roots.pushedSource).toBe('kinship-backend')
      expect(roots.anchors).toEqual(['05:00', '07:30'])
      expect(roots.timezone).toBe('Asia/Shanghai')

      const snapshot = await mounted.service.snapshot()
      expect(snapshot.scheduler).toMatchObject({
        planRoot: rootA,
        planRootSource: 'pushed',
        pathsPushedAt: 1_794_759_000_100,
        pathsSource: 'kinship-backend',
        pathsProblem: null,
        anchorsSource: 'master',
        timezone: 'Asia/Shanghai',
        masterPresent: true,
      })

      // The same root again: provenance refreshes, the engine is not swapped.
      const firstEngine = mounted.service.scheduler
      mounted.emitPaths(pushedDocument({ plan_root: rootA, stored_at: 1_794_759_000_500 }))
      await until(() => mounted.service.roots().pushedAt === 1_794_759_000_500, 'the sync time')
      expect(mounted.service.scheduler).toBe(firstEngine)
      expect(mounted.service.roots().planRoot).toBe(rootA)

      // A moved root restarts the engine on the new plan tree and profile.
      mounted.emitPaths(pushedDocument({ plan_root: rootB, stored_at: 1_794_759_001_000 }))
      await until(() => mounted.service.roots().timezone === 'America/New_York', 'the restarted engine')
      expect(mounted.service.scheduler).not.toBe(firstEngine)
      expect(mounted.service.roots()).toMatchObject({
        planRoot: rootB,
        source: 'pushed',
        anchors: ['09:15', '21:45'],
        anchorsSource: 'master',
        pushedAt: 1_794_759_001_000,
      })
      const restarted = await mounted.service.snapshot()
      expect(restarted.scheduler.timezone).toBe('America/New_York')
      expect(restarted.master?.entries.map(entry => entry.id)).toContain('plan-build')
    } finally {
      await mounted.dispose()
    }
  })

  it('keeps the running engine when a push is refused', async () => {
    const home = tempDir('pushed-paths-degraded-')
    process.env['DSH_HOME'] = home
    const rootA = planRootWithMaster(masterDocument('Asia/Shanghai', '05:00', '07:30'))
    const path = pushedPathsPath(home)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(pushedDocument({ plan_root: rootA })), 'utf8')

    const mounted = await mountScheduler()
    try {
      const engine = mounted.service.scheduler
      expect(mounted.service.roots().planRoot).toBe(rootA)
      // The bridge wrote nothing this time and the payload is refused: the last
      // known-good root and the running engine both survive.
      unlinkSync(path)
      mounted.emitPaths({ schema: 3 })
      const roots = mounted.service.roots()
      expect(roots.planRoot).toBe(rootA)
      expect(roots.pushedProblem).toContain('schema')
      expect(mounted.service.scheduler).toBe(engine)
      const snapshot = await mounted.service.snapshot()
      expect(snapshot.scheduler.planRoot).toBe(rootA)
      expect(snapshot.scheduler.pathsProblem).toContain('schema')
    } finally {
      await mounted.dispose()
    }
  })

  it('keeps the running engine when the bridge reports no document', async () => {
    const home = tempDir('pushed-paths-cleared-')
    process.env['DSH_HOME'] = home
    const rootA = planRootWithMaster(masterDocument('Asia/Shanghai', '05:00', '07:30'))
    const path = pushedPathsPath(home)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(pushedDocument({ plan_root: rootA })), 'utf8')

    const mounted = await mountScheduler()
    try {
      const engine = mounted.service.scheduler
      mounted.emitPaths(null)
      const roots = mounted.service.roots()
      // The cached push is dropped, but the root the engine runs on stays.
      expect(roots.pushedAt).toBeNull()
      expect(roots.planRoot).toBe(rootA)
      expect(mounted.service.scheduler).toBe(engine)
    } finally {
      await mounted.dispose()
    }
  })

  it('starts a disabled engine when the first push arrives', async () => {
    const home = tempDir('pushed-paths-late-')
    process.env['DSH_HOME'] = home
    const rootA = planRootWithMaster(masterDocument('Asia/Shanghai', '05:00', '07:30'))

    const mounted = await mountScheduler()
    try {
      // Nothing pushed and no configured root: the engine stays off.
      expect(mounted.service.scheduler).toBeNull()
      expect(mounted.service.roots().planRoot).toBeNull()

      const path = pushedPathsPath(home)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(pushedDocument({ plan_root: rootA })), 'utf8')
      mounted.emitPaths(pushedDocument({ plan_root: rootA }))

      await until(() => mounted.service.scheduler !== null, 'the engine started by the push')
      const roots = mounted.service.roots()
      expect(roots).toMatchObject({
        planRoot: rootA,
        source: 'pushed',
        anchors: ['05:00', '07:30'],
        anchorsSource: 'master',
      })
      expect(roots.pushedProblem).toBeNull()
    } finally {
      await mounted.dispose()
    }
  })

  it('derives anchors from the master when the plugin row configures none', async () => {
    const home = tempDir('pushed-paths-anchors-')
    process.env['DSH_HOME'] = home
    const root = planRootWithMaster(masterDocument('Asia/Shanghai', '06:00', '22:00'))
    const path = pushedPathsPath(home)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(pushedDocument({ plan_root: root })), 'utf8')

    const mounted = await mountScheduler({ anchors: [] })
    try {
      expect(mounted.service.roots().anchors).toEqual(['06:00', '22:00'])
      expect(mounted.service.roots().anchorsSource).toBe('master')
    } finally {
      await mounted.dispose()
    }

    const configured = await mountScheduler({ anchors: ['04:30'], stateDir: tempDir('plan-state-') })
    try {
      expect(configured.service.roots().anchors).toEqual(['04:30'])
      expect(configured.service.roots().anchorsSource).toBe('config')
    } finally {
      await configured.dispose()
    }
  })
})
