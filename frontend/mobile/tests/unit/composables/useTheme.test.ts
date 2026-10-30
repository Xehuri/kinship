/// <reference types="vitest/globals" />

/**
 * useTheme: 主题 + 强调色 + 密度 + 动效 的模块级单例。
 *
 * 覆盖:
 *   1. 旧主题键迁移 (glacier -> light + indigo, light/dark -> 同名偏好);
 *   2. 新键优先于旧键, 非法值回退默认;
 *   3. 偏好持久化与 <html data-*> 同步;
 *   4. system 跟随系统偏好, light/dark 不受系统变化影响;
 *   5. 监听器只注册一次, disposeTheme 正确清理。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  useTheme,
  disposeTheme,
  THEME_STORAGE_KEY,
  ACCENT_STORAGE_KEY,
  DENSITY_STORAGE_KEY,
  MOTION_STORAGE_KEY,
} from '@/composables/useTheme'

type ChangeListener = (e: { matches: boolean; media: string }) => void

const MEDIA_QUERY = '(prefers-color-scheme: light)'

let listeners: ChangeListener[]
let addEventListenerSpy: ReturnType<typeof vi.fn>
let removeEventListenerSpy: ReturnType<typeof vi.fn>
let matchMediaSpy: ReturnType<typeof vi.fn>
let systemPrefersLight: boolean

function emitSystemChange(matches: boolean): void {
  for (const cb of listeners) {
    cb({ matches, media: MEDIA_QUERY })
  }
}

function rootTheme(): string | null {
  return document.documentElement.getAttribute('data-theme')
}

function rootAttribute(name: string): string | null {
  return document.documentElement.getAttribute(name)
}

function clearRootAttributes(): void {
  for (const name of ['data-theme', 'data-accent', 'data-density', 'data-motion']) {
    document.documentElement.removeAttribute(name)
  }
}

beforeEach(() => {
  disposeTheme()
  localStorage.clear()
  clearRootAttributes()

  listeners = []
  addEventListenerSpy = vi.fn((_type: string, cb: ChangeListener) => {
    listeners.push(cb)
  })
  removeEventListenerSpy = vi.fn((_type: string, cb: ChangeListener) => {
    listeners = listeners.filter((listener) => listener !== cb)
  })
  systemPrefersLight = false

  matchMediaSpy = vi.fn(() => ({
    matches: systemPrefersLight,
    media: MEDIA_QUERY,
    onchange: null,
    addEventListener: addEventListenerSpy,
    removeEventListener: removeEventListenerSpy,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: matchMediaSpy,
  })
})

afterEach(() => {
  disposeTheme()
})

describe('useTheme 偏好模型', () => {
  it('默认 system, 并按系统偏好解析 data-theme', () => {
    systemPrefersLight = true
    const { theme, resolvedTheme } = useTheme()

    expect(theme.value).toBe('system')
    expect(resolvedTheme.value).toBe('light')
    expect(rootTheme()).toBe('light')
    expect(rootAttribute('data-accent')).toBe('ochre')
    expect(rootAttribute('data-density')).toBe('comfortable')
    expect(rootAttribute('data-motion')).toBe('full')
  })

  it('多次调用共享同一组 ref', () => {
    const a = useTheme()
    const b = useTheme()

    expect(a.theme).toBe(b.theme)
    expect(a.accent).toBe(b.accent)
    expect(a.density).toBe(b.density)
    expect(a.motion).toBe(b.motion)
  })

  it('availableThemes 为 light/dark/system', () => {
    const { availableThemes } = useTheme()
    expect(availableThemes).toEqual(['light', 'dark', 'system'])
  })
})

describe('legacy 迁移', () => {
  it('theme=glacier 迁移为 light + indigo 并删除旧键', () => {
    localStorage.setItem('theme', 'glacier')

    const { theme, accent, resolvedTheme } = useTheme()

    expect(theme.value).toBe('light')
    expect(accent.value).toBe('indigo')
    expect(resolvedTheme.value).toBe('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBe('indigo')
    expect(localStorage.getItem('theme')).toBeNull()
    expect(rootTheme()).toBe('light')
    expect(rootAttribute('data-accent')).toBe('indigo')
  })

  it('旧 theme=dark / light 迁移为同名偏好', () => {
    localStorage.setItem('theme', 'dark')
    const dark = useTheme()
    expect(dark.theme.value).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(localStorage.getItem('theme')).toBeNull()

    disposeTheme()
    localStorage.clear()
    localStorage.setItem('theme', 'light')
    const light = useTheme()
    expect(light.theme.value).toBe('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
  })

  it('新键已存在时旧键只清理, 不覆盖当前偏好', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    localStorage.setItem(ACCENT_STORAGE_KEY, 'rose')
    localStorage.setItem('theme', 'glacier')

    const { theme, accent } = useTheme()

    expect(theme.value).toBe('dark')
    expect(accent.value).toBe('rose')
    expect(localStorage.getItem('theme')).toBeNull()
  })

  it('非法持久化值回退默认', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'glacier')
    localStorage.setItem(ACCENT_STORAGE_KEY, 'blue')
    localStorage.setItem(DENSITY_STORAGE_KEY, 'huge')
    localStorage.setItem(MOTION_STORAGE_KEY, 'none')

    const { theme, accent, density, motion } = useTheme()

    expect(theme.value).toBe('system')
    expect(accent.value).toBe('ochre')
    expect(density.value).toBe('comfortable')
    expect(motion.value).toBe('full')
  })
})

describe('偏好持久化与 DOM 同步', () => {
  it('setTheme 持久化并写入解析后的 data-theme', () => {
    const api = useTheme()

    api.setTheme('dark')
    expect(api.theme.value).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(rootTheme()).toBe('dark')

    api.setTheme('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(rootTheme()).toBe('light')
  })

  it('accent / density / motion 持久化并写入对应属性', () => {
    const api = useTheme()

    api.setAccent('jade')
    api.setDensity('compact')
    api.setMotion('reduced')

    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBe('jade')
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe('compact')
    expect(localStorage.getItem(MOTION_STORAGE_KEY)).toBe('reduced')
    expect(rootAttribute('data-accent')).toBe('jade')
    expect(rootAttribute('data-density')).toBe('compact')
    expect(rootAttribute('data-motion')).toBe('reduced')
  })

  it('system 主题跟随系统变化', () => {
    const api = useTheme()
    expect(rootTheme()).toBe('dark')

    emitSystemChange(true)
    expect(rootTheme()).toBe('light')
    expect(api.resolvedTheme.value).toBe('light')

    emitSystemChange(false)
    expect(rootTheme()).toBe('dark')
  })

  it('显式 light/dark 不受系统变化影响', () => {
    const api = useTheme()
    api.setTheme('dark')

    emitSystemChange(true)
    expect(api.theme.value).toBe('dark')
    expect(rootTheme()).toBe('dark')

    api.setTheme('light')
    emitSystemChange(false)
    expect(rootTheme()).toBe('light')
  })
})

describe('监听器生命周期', () => {
  it('多次调用只注册一次系统偏好监听', () => {
    useTheme()
    useTheme()
    useTheme()

    expect(addEventListenerSpy).toHaveBeenCalledTimes(1)
    expect(addEventListenerSpy).toHaveBeenCalledWith('change', expect.any(Function))
  })

  it('disposeTheme 移除监听并复位内存状态, 重复调用无副作用', () => {
    const api = useTheme()
    api.setTheme('dark')
    expect(listeners).toHaveLength(1)

    disposeTheme()
    expect(removeEventListenerSpy).toHaveBeenCalledTimes(1)
    expect(listeners).toHaveLength(0)
    expect(api.theme.value).toBe('system')
    expect(api.accent.value).toBe('ochre')

    disposeTheme()
    expect(removeEventListenerSpy).toHaveBeenCalledTimes(1)
  })

  it('dispose 后再次 useTheme 重新读取持久化偏好并重新注册监听', () => {
    useTheme()
    disposeTheme()
    localStorage.setItem(THEME_STORAGE_KEY, 'light')

    const api = useTheme()

    expect(api.theme.value).toBe('light')
    expect(addEventListenerSpy).toHaveBeenCalledTimes(2)
    expect(listeners).toHaveLength(1)
  })
})
