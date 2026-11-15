import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const CLIENT = resolve(import.meta.dirname, '../../packages/kinship-ui/client.js')
const SOURCE = readFileSync(CLIENT, 'utf8')

interface Element {
  readonly type: unknown
  readonly props: Record<string, unknown>
  readonly children: unknown[]
}

/** Minimal React stand-in: the bundle only needs createElement plus hook slots. */
const React = {
  Fragment: Symbol('Fragment'),
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({
    type,
    props: props ?? {},
    children,
  }),
  useCallback: <T>(value: T): T => value,
  useEffect: (): void => {},
  useMemo: <T>(factory: () => T): T => factory(),
  useRef: <T>(value: T): { current: T } => ({ current: value }),
  useState: <T>(value: T): [T, (next: T) => void] => [value, () => {}],
}

interface SlotRegistration {
  readonly options: Record<string, unknown>
  readonly component: (props: Record<string, unknown>) => unknown
}

interface ClientModule {
  readonly inject: readonly string[]
  apply(ctx: unknown): void
}

function loadBundle(react: Record<string, unknown> = React): ClientModule {
  let spec: { id?: string, factory?: (require: (id: string) => unknown) => ClientModule } | undefined
  const fakeWindow = {
    __ModuleLoader__: {
      load: (value: typeof spec): void => { spec = value },
    },
    // The panel schedules temporary notices through the browser's timers; the
    // render harness never needs them to fire.
    setTimeout: (): number => 0,
    clearTimeout: (): void => {},
  }
  // The bundle is a browser classic script; evaluating it in this realm keeps
  // the assertions about what it registers without a browser.
  new Function('window', SOURCE)(fakeWindow)
  expect(spec?.id).toBe('kinship-ui')
  const factory = spec?.factory
  if (factory === undefined) throw new Error('client bundle registered no factory')
  return factory((id: string) => {
    if (id === 'react') return react
    throw new Error(`unexpected module request: ${id}`)
  })
}

interface Harness {
  readonly module: ClientModule
  readonly locales: Array<{ ns: string, dictionaries: Record<string, Record<string, string>> }>
  readonly slots: SlotRegistration[]
  readonly effects: Array<() => void>
  readonly modules: Array<{ ns: string, dictionaries: Record<string, Record<string, string>> }>
}

function activate(react: Record<string, unknown> = React): Harness {
  const module = loadBundle(react)
  const locales: Harness['locales'] = []
  const slots: SlotRegistration[] = []
  const effects: Array<() => void> = []
  const ctx = {
    effect: (callback: () => () => void) => {
      effects.push(callback())
      return () => {}
    },
    locale: {
      register: (ns: string, dictionaries: Record<string, Record<string, string>>) => {
        locales.push({ ns, dictionaries })
        return () => {}
      },
      bind: (ns: string) => (key: string) => `${ns}:${key}`,
    },
    slots: {
      inject: (_name: string, callback: () => () => void) => callback(),
      register: (options: Record<string, unknown>, component: (props: Record<string, unknown>) => unknown) => {
        slots.push({ options, component })
        return () => {}
      },
    },
  }
  module.apply(ctx)
  return { module, locales, slots, effects, modules: locales }
}

describe('kinship-ui browser bundle', () => {
  it('registers under the package name the boot graph expects', () => {
    const module = loadBundle()
    expect(module.inject).toEqual(['slots', 'locale'])
  })

  it('registers one zh/en dictionary pair with identical keys', () => {
    const { locales } = activate()
    expect(locales).toHaveLength(1)
    const registration = locales[0]!
    expect(registration.ns).toBe('kinship.ui')
    expect(Object.keys(registration.dictionaries).sort()).toEqual(['en', 'zh'])
    const zh = registration.dictionaries['zh']!
    const en = registration.dictionaries['en']!
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    for (const [key, value] of Object.entries(zh)) {
      expect(value, `zh ${key}`).toBeTypeOf('string')
      expect(value.length, `zh ${key}`).toBeGreaterThan(0)
    }
    for (const [key, value] of Object.entries(en)) {
      expect(value, `en ${key}`).toBeTypeOf('string')
      expect(value.length, `en ${key}`).toBeGreaterThan(0)
    }
  })

  it('translates every key the panel asks for', () => {
    const { locales } = activate()
    const dictionaries = locales[0]!.dictionaries
    const asked = new Set<string>()
    for (const match of SOURCE.matchAll(/\bt\(\s*'([^']+)'\s*\)/g)) asked.add(match[1]!)
    expect(asked.size).toBeGreaterThan(20)
    for (const key of asked) {
      expect(dictionaries['zh'], `zh ${key}`).toHaveProperty([key])
      expect(dictionaries['en'], `en ${key}`).toHaveProperty([key])
    }
  })

  it('fills the sidebar row and the main panel under one id', () => {
    const { slots } = activate()
    expect(slots).toHaveLength(2)

    const page = slots.find(entry => entry.options['name'] === 'main')
    expect(page, 'main panel').toBeDefined()
    expect(page!.options['key']).toBe('kinship')
    expect(page!.options['locale']).toBe('kinship.ui')
    expect(page!.component).toBeTypeOf('function')

    const row = slots.find(entry => entry.options['name'] === 'sidebar.panellist')
    expect(row, 'sidebar row').toBeDefined()
    expect(row!.options['id']).toBe('kinship')
    expect(row!.options['order']).toBeTypeOf('number')
    expect(row!.options['locale']).toBe('kinship.ui')
    const label = row!.options['label']
    expect(label).toBeTypeOf('function')
    expect((label as () => string)()).toBe('kinship.ui:panel')
  })

  it('draws the sidebar glyph at the size the sidebar asks for', () => {
    const { slots } = activate()
    const row = slots.find(entry => entry.options['name'] === 'sidebar.panellist')!
    const element = row.component({ size: 18, active: true }) as Element
    expect(element.type).toBe('svg')
    expect(element.props['width']).toBe(18)
    expect(element.props['height']).toBe(18)
    expect(element.props['aria-hidden']).toBe('true')
  })
})

/* ───────────────────── plan-schedule card rendering ───────────────────── */

type Component = (props: Record<string, unknown>) => unknown

interface FetchCall {
  readonly url: string
  readonly method: string
  readonly body: unknown
}

interface StubAnswer {
  readonly status: number
  readonly body: unknown
}

interface HookSlot {
  value?: unknown
  deps?: readonly unknown[] | undefined
}

interface Instance {
  readonly slots: HookSlot[]
  readonly queue: Array<() => void>
}

interface Runtime {
  readonly React: Record<string, unknown>
  render(component: Component, props: Record<string, unknown>): Promise<Element>
  settle(): Promise<Element>
}

function isElement(node: unknown): node is Element {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return false
  const record = node as Record<string, unknown>
  return 'type' in record && 'props' in record && Array.isArray(record['children'])
}

function walkText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node) + ' '
  if (Array.isArray(node)) return node.map(walkText).join('')
  if (!isElement(node)) return ''
  return node.children.map(walkText).join('')
}

function findElement(node: unknown, predicate: (element: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (!isElement(node)) return undefined
  if (predicate(node)) return node
  for (const child of node.children) {
    const found = findElement(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}

function findButton(node: unknown, label: string): Element | undefined {
  return findElement(node, element => element.type === 'button' && walkText(element.children).trim() === label)
}

function sameDeps(left: readonly unknown[] | undefined, right: readonly unknown[] | undefined): boolean {
  if (left === undefined || right === undefined) return false
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
}

/**
 * Hook-aware stand-in for React's renderer: one slot array per component type,
 * effects after each pass, and re-rendering until the tree settles. Enough for
 * a component that only uses the five hooks this bundle consumes.
 */
function createRuntime(): Runtime {
  const instances = new Map<Component, Instance>()
  let current: Instance | null = null
  let cursor = 0
  let dirty = false
  let last: { component: Component, props: Record<string, unknown> } | null = null

  const instanceOf = (component: Component): Instance => {
    const existing = instances.get(component)
    if (existing !== undefined) return existing
    const created: Instance = { slots: [], queue: [] }
    instances.set(component, created)
    return created
  }

  const requireCurrent = (): Instance => {
    if (current === null) throw new Error('hook used outside of a component render')
    return current
  }

  const hooks = {
    useState(initial: unknown): [unknown, (next: unknown) => void] {
      const instance = requireCurrent()
      const index = cursor
      cursor += 1
      const existing = instance.slots[index]
      const slot: HookSlot = existing
        ?? { value: typeof initial === 'function' ? (initial as () => unknown)() : initial }
      instance.slots[index] = slot
      const setter = (next: unknown): void => {
        const resolved = typeof next === 'function'
          ? (next as (previous: unknown) => unknown)(slot.value)
          : next
        if (Object.is(resolved, slot.value)) return
        slot.value = resolved
        dirty = true
      }
      return [slot.value, setter]
    },
    useEffect(callback: () => void, deps?: readonly unknown[]): void {
      const instance = requireCurrent()
      const index = cursor
      cursor += 1
      const existing = instance.slots[index]
      const slot: HookSlot = existing ?? {}
      instance.slots[index] = slot
      if (sameDeps(slot.deps, deps)) return
      slot.deps = deps
      instance.queue.push(callback)
    },
    useCallback(callback: unknown, deps?: readonly unknown[]): unknown {
      const instance = requireCurrent()
      const index = cursor
      cursor += 1
      const existing = instance.slots[index]
      const slot: HookSlot = existing ?? {}
      instance.slots[index] = slot
      if (sameDeps(slot.deps, deps)) return slot.value
      slot.deps = deps
      slot.value = callback
      return callback
    },
    useMemo(factory: () => unknown, deps?: readonly unknown[]): unknown {
      const instance = requireCurrent()
      const index = cursor
      cursor += 1
      const existing = instance.slots[index]
      const slot: HookSlot = existing ?? {}
      instance.slots[index] = slot
      if (sameDeps(slot.deps, deps)) return slot.value
      slot.deps = deps
      slot.value = factory()
      return slot.value
    },
    useRef(initial: unknown): { current: unknown } {
      const instance = requireCurrent()
      const index = cursor
      cursor += 1
      const existing = instance.slots[index]
      if (existing !== undefined) return existing.value as { current: unknown }
      const ref = { current: initial }
      instance.slots[index] = { value: ref }
      return ref
    },
  }

  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Element => ({
      type,
      props: props ?? {},
      children,
    }),
    ...hooks,
  }

  const renderComponent = (component: Component, props: Record<string, unknown>): unknown => {
    const instance = instanceOf(component)
    const previousCurrent = current
    const previousCursor = cursor
    current = instance
    cursor = 0
    try {
      return component(props)
    } finally {
      current = previousCurrent
      cursor = previousCursor
    }
  }

  const expand = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(expand)
    if (!isElement(node)) return node
    if (typeof node.type === 'function') {
      // React hands a component its children through props; this bundle's
      // Card/Row/Field helpers destructure them the same way.
      const props: Record<string, unknown> = { ...node.props }
      if (node.children.length === 1) props['children'] = node.children[0]
      else if (node.children.length > 1) props['children'] = node.children
      return expand(renderComponent(node.type as Component, props))
    }
    return { type: node.type, props: node.props, children: node.children.map(expand) } satisfies Element
  }

  const flush = async (): Promise<void> => {
    const queued = [...instances.values()].flatMap(instance => instance.queue.splice(0))
    for (const callback of queued) callback()
    for (let step = 0; step < 12; step += 1) await Promise.resolve()
    await new Promise<void>(resolve => { setImmediate(resolve) })
    for (let step = 0; step < 12; step += 1) await Promise.resolve()
  }

  const render = async (component: Component, props: Record<string, unknown>): Promise<Element> => {
    last = { component, props }
    let tree: Element | null = null
    for (let pass = 0; pass < 40; pass += 1) {
      dirty = false
      tree = expand(renderComponent(component, props)) as Element
      await flush()
      if (!dirty) break
    }
    if (tree === null) throw new Error('render produced no tree')
    return tree
  }

  const settle = async (): Promise<Element> => {
    if (last === null) throw new Error('settle called before render')
    return await render(last.component, last.props)
  }

  return { React, render, settle }
}

/** Route the bundle's fetches through a stub and expose what it asked for. */
function stubEnvironment(handler: (call: FetchCall) => StubAnswer): { calls: FetchCall[], restore: () => void } {
  const calls: FetchCall[] = []
  const scope = globalThis as unknown as Record<string, unknown>
  const previousFetch = scope['fetch']
  const previousDocument = scope['document']
  scope['document'] = { baseURI: 'http://127.0.0.1:3080/' }
  scope['fetch'] = async (input: unknown, init?: { readonly method?: string, readonly body?: string }): Promise<unknown> => {
    const call: FetchCall = {
      url: String(input),
      method: typeof init?.method === 'string' ? init.method : 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
    }
    calls.push(call)
    const answer = handler(call)
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => answer.body,
    }
  }
  return {
    calls,
    restore: () => {
      scope['fetch'] = previousFetch
      scope['document'] = previousDocument
    },
  }
}

function stateAnswer(): StubAnswer {
  return {
    status: 200,
    body: {
      ok: true,
      bridge: { url: 'http://127.0.0.1:18766', host: '127.0.0.1', port: 18_766, version: '0.1.0', dsh: '0.2.2-rc.3' },
      binding: { status: 'unbound', sessionId: null, boundAt: null, policy: 'first' },
      session: null,
      token: { source: 'env', env: 'KINSHIP_BRIDGE_TOKEN', path: null, length: 14 },
      config: {
        host: '127.0.0.1',
        port: 18_766,
        tokenEnv: 'KINSHIP_BRIDGE_TOKEN',
        tokenFile: '',
        policy: 'first',
        sessionId: '',
        rebindOnMissing: false,
        bodyLimitBytes: 65_536,
      },
      editable: true,
      sessions: [],
    },
  }
}

function scheduleResponse(options: {
  readonly version: number
  readonly entries: readonly Record<string, unknown>[]
  readonly pending?: readonly Record<string, unknown>[]
  readonly delivered?: readonly Record<string, unknown>[]
  readonly master?: boolean
}): StubAnswer {
  const pending = options.pending ?? []
  const delivered = options.delivered ?? []
  return {
    status: 200,
    body: {
      ok: true,
      scheduler: {
        mode: 'live',
        planRoot: '/srv/kinship/ai/data',
        stateDir: '/home/kinship/.dsh/kinship/state',
        timezone: 'Asia/Shanghai',
        anchors: ['05:00', '07:30'],
        degraded: false,
        lastError: null,
        problem: null,
        masterPresent: options.master !== false,
      },
      master: options.master === false
        ? null
        : { version: options.version, timezone: 'Asia/Shanghai', updatedAt: 1_700_000_000_000, entries: options.entries },
      queue: { sessionId: 'session-a', pending, delivered },
      next: null,
    },
  }
}

function dailyEntry(): Record<string, unknown> {
  return {
    id: 'plan-build',
    kind: 'fixed',
    title: '日计划',
    action: 'plan.build',
    enabled: true,
    status: 'active',
    schedule: { kind: 'daily', at: '05:00' },
    next_at: 1_700_000_100_000,
    next_local: '2026-11-16 05:00',
  }
}

function weeklyEntry(): Record<string, unknown> {
  return {
    id: 'weekly-review',
    kind: 'fixed',
    title: '周报总结',
    action: 'review.weekly',
    enabled: true,
    status: 'active',
    schedule: { kind: 'weekly', days: ['mon'], at: '03:00' },
    next_at: 1_700_000_200_000,
    next_local: '2026-11-17 03:00',
  }
}

function monthlyEntry(): Record<string, unknown> {
  return {
    id: 'monthly-audit',
    kind: 'anchor',
    title: '月度审计',
    action: 'audit.night',
    enabled: true,
    status: 'active',
    schedule: { kind: 'monthly', days: [1, 15], at: '18:30' },
    next_at: 1_700_000_300_000,
    next_local: '2026-12-01 18:30',
  }
}

function onceEntry(): Record<string, unknown> {
  return {
    id: 'once-check',
    kind: 'anchor',
    title: '一次性检查',
    action: null,
    enabled: false,
    status: 'active',
    schedule: { kind: 'once', date: '2026-11-20', at: '09:30' },
    next_at: null,
    next_local: null,
  }
}

function mainPanel(harness: Harness): { component: Component, t: (key: string) => string } {
  const page = harness.slots.find(entry => entry.options['name'] === 'main')
  if (page === undefined) throw new Error('main panel is not registered')
  const dictionary = harness.locales[0]?.dictionaries['zh']
  if (dictionary === undefined) throw new Error('zh dictionary is not registered')
  return {
    component: page.component,
    t: (key: string) => dictionary[key] ?? key,
  }
}

describe('kinship-ui plan schedule card', () => {
  it('keeps the bridge cards and explains a missing plan route inline', async () => {
    const runtime = createRuntime()
    const page = mainPanel(activate(runtime.React))
    const environment = stubEnvironment(call => {
      if (call.url.endsWith('/api/kinship/ui/plan')) {
        return { status: 404, body: { ok: false, error: { code: 'not_found', message: 'route not found' } } }
      }
      return stateAnswer()
    })
    try {
      const text = walkText(await runtime.render(page.component, { t: page.t }))
      expect(text).toContain('计划排班')
      expect(text).toContain('计划调度器未安装或未启用')
      expect(text).toContain('桥接状态')
    } finally {
      environment.restore()
    }
  })

  it('offers the default schedule while the master is uninitialized', async () => {
    const runtime = createRuntime()
    const page = mainPanel(activate(runtime.React))
    const environment = stubEnvironment(call => call.url.endsWith('/api/kinship/ui/plan')
      ? scheduleResponse({ version: 0, entries: [], master: false })
      : stateAnswer())
    try {
      const text = walkText(await runtime.render(page.component, { t: page.t }))
      expect(text).toContain('未初始化')
      expect(text).toContain('创建默认排班')
      expect(text).toContain('实时')
      expect(text).toContain('05:00')
      expect(text).toContain('下次唤醒')
    } finally {
      environment.restore()
    }
  })

  it('renders schedule rows and the wake queue of a populated master', async () => {
    const runtime = createRuntime()
    const page = mainPanel(activate(runtime.React))
    const environment = stubEnvironment(call => call.url.endsWith('/api/kinship/ui/plan')
      ? scheduleResponse({
        version: 7,
        entries: [dailyEntry(), weeklyEntry(), monthlyEntry(), onceEntry()],
        pending: [
          { id: 'wake-1', at: 1_700_000_400_000, action: 'coverage.run', attempts: 0, title: '覆盖检查点 cov-08' },
          { id: 'wake-2', at: 1_700_000_500_000, action: null, attempts: 1, title: 'wake-2' },
        ],
        delivered: [{ id: 'wake-0', delivered_at: 1_700_000_000_000, outcome: 'delivered' }],
      })
      : stateAnswer())
    try {
      const text = walkText(await runtime.render(page.component, { t: page.t }))
      expect(text).toContain('日计划')
      expect(text).toContain('05:00')
      expect(text).toContain('星期')
      expect(text).toContain('03:00')
      expect(text).toContain('每月 1、15 日 18:30')
      expect(text).toContain('2026-11-20 09:30')
      expect(text).toContain('待投递 2')
      expect(text).toContain('coverage.run · 覆盖检查点 cov-08')
      expect(text).toContain('最近投递 1')
      expect(text).toContain('delivered')
      expect(text).toContain('立即对账')
      expect(text).toContain('版本 7')
    } finally {
      environment.restore()
    }
  })

  it('posts set_enabled with the version it last read and renders the answer', async () => {
    const runtime = createRuntime()
    const page = mainPanel(activate(runtime.React))
    const loaded = scheduleResponse({ version: 7, entries: [dailyEntry(), weeklyEntry(), monthlyEntry()] })
    const saved = scheduleResponse({
      version: 8,
      entries: [{ ...dailyEntry(), enabled: false }, weeklyEntry(), monthlyEntry()],
    })
    const environment = stubEnvironment(call => {
      if (call.url.endsWith('/api/kinship/ui/plan/ops')) return saved
      if (call.url.endsWith('/api/kinship/ui/plan')) return loaded
      return stateAnswer()
    })
    try {
      const tree = await runtime.render(page.component, { t: page.t })
      const toggle = findElement(tree, node => node.type === 'input'
        && node.props['type'] === 'checkbox'
        && String(node.props['aria-label'] ?? '').startsWith('启用 '))
      if (toggle === undefined) throw new Error('the enable toggle is missing')
      const onChange = toggle.props['onChange']
      if (typeof onChange !== 'function') throw new Error('the enable toggle has no change handler')
      const trigger = onChange as (event: unknown) => void
      trigger({ target: { checked: false } })
      const settled = await runtime.settle()
      const opsCall = environment.calls.find(call => call.url.endsWith('/api/kinship/ui/plan/ops'))
      expect(opsCall).toBeDefined()
      expect(opsCall?.method).toBe('POST')
      expect(opsCall?.body).toEqual({
        expectedVersion: 7,
        ops: [{ op: 'set_enabled', id: 'plan-build', enabled: false }],
      })
      expect(walkText(settled)).toContain('已更新排班')
    } finally {
      environment.restore()
    }
  })

  it('applies the nested snapshot the reconcile route answers with', async () => {
    const runtime = createRuntime()
    const page = mainPanel(activate(runtime.React))
    const loaded = scheduleResponse({ version: 7, entries: [dailyEntry()] })
    const reconciled = scheduleResponse({ version: 9, entries: [{ ...dailyEntry(), title: '复核后的日计划' }] })
    const environment = stubEnvironment(call => {
      if (call.url.endsWith('/api/kinship/ui/plan/reconcile')) {
        return {
          status: 200,
          body: { ok: true, queued: { added: 1, updated: 2, cancelled: 0 }, snapshot: reconciled.body },
        }
      }
      if (call.url.endsWith('/api/kinship/ui/plan')) return loaded
      return stateAnswer()
    })
    try {
      const tree = await runtime.render(page.component, { t: page.t })
      const button = findButton(tree, '立即对账')
      if (button === undefined) throw new Error('the reconcile button is missing')
      const onClick = button.props['onClick']
      if (typeof onClick !== 'function') throw new Error('the reconcile button has no handler')
      const trigger = onClick as () => void
      trigger()
      const settled = await runtime.settle()
      const call = environment.calls.find(entry => entry.url.endsWith('/api/kinship/ui/plan/reconcile'))
      expect(call?.method).toBe('POST')
      expect(call?.body).toEqual({ reason: 'manual' })
      const text = walkText(settled)
      expect(text).toContain('版本 9')
      expect(text).toContain('复核后的日计划')
      expect(text).toContain('对账完成')
      expect(text).toContain('新增 1 · 更新 2 · 取消 0')
    } finally {
      environment.restore()
    }
  })
})
