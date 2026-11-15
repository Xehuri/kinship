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

function loadBundle(): ClientModule {
  let spec: { id?: string, factory?: (require: (id: string) => unknown) => ClientModule } | undefined
  const fakeWindow = {
    __ModuleLoader__: {
      load: (value: typeof spec): void => { spec = value },
    },
  }
  // The bundle is a browser classic script; evaluating it in this realm keeps
  // the assertions about what it registers without a browser.
  new Function('window', SOURCE)(fakeWindow)
  expect(spec?.id).toBe('kinship-ui')
  const factory = spec?.factory
  if (factory === undefined) throw new Error('client bundle registered no factory')
  return factory((id: string) => {
    if (id === 'react') return React
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

function activate(): Harness {
  const module = loadBundle()
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
