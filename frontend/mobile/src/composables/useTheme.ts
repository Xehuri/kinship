import { computed, ref, watch, type WatchStopHandle } from 'vue'

/**
 * 主题与外观偏好 (模块级单例)
 *
 * 偏好模型:
 *   theme   light | dark | system      (system 跟随 prefers-color-scheme)
 *   accent  ochre | jade | indigo | rose
 *   density comfortable | compact
 *   motion  full | reduced
 *
 * 持久化键: axeuh-theme / axeuh-accent / axeuh-density / axeuh-motion。
 * 旧版单值主题键 theme (light|dark|glacier) 会在首次初始化时迁移:
 *   glacier -> light + indigo, light/dark -> 同名偏好, 然后删除旧键。
 *
 * DOM 契约: <html data-theme="light|dark" data-accent data-density data-motion>。
 * data-theme 始终是解析后的值, 不写 "system"。
 */

/** 主题偏好 (system = 跟随系统) */
export type ThemeName = 'light' | 'dark' | 'system'
/** 解析后的实际主题 */
export type ResolvedTheme = 'light' | 'dark'
/** 强调色 */
export type AccentName = 'ochre' | 'jade' | 'indigo' | 'rose'
/** 信息密度 */
export type DensityName = 'comfortable' | 'compact'
/** 动效强度 */
export type MotionName = 'full' | 'reduced'

export const THEME_STORAGE_KEY = 'axeuh-theme'
export const ACCENT_STORAGE_KEY = 'axeuh-accent'
export const DENSITY_STORAGE_KEY = 'axeuh-density'
export const MOTION_STORAGE_KEY = 'axeuh-motion'

/** 旧版单值主题键 (仅用于迁移) */
const LEGACY_THEME_KEY = 'theme'

export const availableThemes: readonly ThemeName[] = ['light', 'dark', 'system']
export const availableAccents: readonly AccentName[] = ['ochre', 'jade', 'indigo', 'rose']
export const availableDensities: readonly DensityName[] = ['comfortable', 'compact']
export const availableMotions: readonly MotionName[] = ['full', 'reduced']

const DEFAULT_THEME: ThemeName = 'system'
const DEFAULT_ACCENT: AccentName = 'ochre'
const DEFAULT_DENSITY: DensityName = 'comfortable'
const DEFAULT_MOTION: MotionName = 'full'

/** 模块级共享状态: 多次调用 useTheme() 返回同一组 ref */
const theme = ref<ThemeName>(DEFAULT_THEME)
const accent = ref<AccentName>(DEFAULT_ACCENT)
const density = ref<DensityName>(DEFAULT_DENSITY)
const motion = ref<MotionName>(DEFAULT_MOTION)

/** 系统是否偏好浅色 (仅在 theme=system 时参与解析) */
const systemPrefersLight = ref(false)

/** 解析后的实际主题 (永不等于 system) */
const resolvedTheme = computed<ResolvedTheme>(() => {
  if (theme.value === 'system') {
    return systemPrefersLight.value ? 'light' : 'dark'
  }
  return theme.value
})

/** 是否已完成首次初始化 (懒初始化, 避免模块加载时就访问 window/localStorage) */
let initialized = false
/** 偏好变化同步句柄 */
let stopWatch: WatchStopHandle | null = null
let mediaQuery: MediaQueryList | null = null
let mediaQueryHandler: ((e: MediaQueryListEvent) => void) | null = null

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // localStorage 不可用时仅保留内存状态
  }
}

function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

function isThemeName(value: string | null): value is ThemeName {
  return value !== null && (availableThemes as readonly string[]).includes(value)
}

function isAccentName(value: string | null): value is AccentName {
  return value !== null && (availableAccents as readonly string[]).includes(value)
}

function isDensityName(value: string | null): value is DensityName {
  return value !== null && (availableDensities as readonly string[]).includes(value)
}

function isMotionName(value: string | null): value is MotionName {
  return value !== null && (availableMotions as readonly string[]).includes(value)
}

/**
 * 旧键迁移: theme=glacier -> light + indigo; theme=light|dark -> 同名偏好。
 * 新键已存在时只清理旧键, 不覆盖用户当前偏好。
 */
function migrateLegacyPreferences(): void {
  const legacy = readStorage(LEGACY_THEME_KEY)
  if (legacy === null) return

  const storedTheme = readStorage(THEME_STORAGE_KEY)
  if (!storedTheme) {
    if (legacy === 'glacier') {
      writeStorage(THEME_STORAGE_KEY, 'light')
      if (!readStorage(ACCENT_STORAGE_KEY)) {
        writeStorage(ACCENT_STORAGE_KEY, 'indigo')
      }
    } else if (legacy === 'light' || legacy === 'dark') {
      writeStorage(THEME_STORAGE_KEY, legacy)
    }
  }
  removeStorage(LEGACY_THEME_KEY)
}

function readTheme(): ThemeName {
  const stored = readStorage(THEME_STORAGE_KEY)
  return isThemeName(stored) ? stored : DEFAULT_THEME
}

function readAccent(): AccentName {
  const stored = readStorage(ACCENT_STORAGE_KEY)
  return isAccentName(stored) ? stored : DEFAULT_ACCENT
}

function readDensity(): DensityName {
  const stored = readStorage(DENSITY_STORAGE_KEY)
  return isDensityName(stored) ? stored : DEFAULT_DENSITY
}

function readMotion(): MotionName {
  const stored = readStorage(MOTION_STORAGE_KEY)
  return isMotionName(stored) ? stored : DEFAULT_MOTION
}

/** 将解析后的偏好写入 <html> 属性 (只写 data-theme 的 light/dark) */
function applyPreferences(): void {
  const root = document.documentElement
  root.setAttribute('data-theme', resolvedTheme.value)
  root.setAttribute('data-accent', accent.value)
  root.setAttribute('data-density', density.value)
  root.setAttribute('data-motion', motion.value)
}

/** 系统偏好变化: 仅更新解析输入; theme != system 时 resolvedTheme 不变 */
function handleSystemThemeChange(e: MediaQueryListEvent): void {
  systemPrefersLight.value = e.matches
}

/** 幂等的首次初始化: 迁移、读取、应用, 并注册唯一监听与同步 watch */
function ensureInitialized(): void {
  if (initialized) return
  initialized = true

  migrateLegacyPreferences()
  theme.value = readTheme()
  accent.value = readAccent()
  density.value = readDensity()
  motion.value = readMotion()
  systemPrefersLight.value = !!window.matchMedia?.('(prefers-color-scheme: light)').matches

  applyPreferences()

  stopWatch = watch(
    [resolvedTheme, accent, density, motion],
    () => {
      applyPreferences()
    },
    { flush: 'sync' },
  )

  if (window.matchMedia) {
    mediaQuery = window.matchMedia('(prefers-color-scheme: light)')
    mediaQueryHandler = handleSystemThemeChange
    mediaQuery.addEventListener('change', mediaQueryHandler)
  }
}

/** 设置主题偏好并持久化 */
function setTheme(next: ThemeName): void {
  if (!isThemeName(next)) return
  theme.value = next
  writeStorage(THEME_STORAGE_KEY, next)
}

/** 设置强调色并持久化 */
function setAccent(next: AccentName): void {
  if (!isAccentName(next)) return
  accent.value = next
  writeStorage(ACCENT_STORAGE_KEY, next)
}

/** 设置信息密度并持久化 */
function setDensity(next: DensityName): void {
  if (!isDensityName(next)) return
  density.value = next
  writeStorage(DENSITY_STORAGE_KEY, next)
}

/** 设置动效强度并持久化 */
function setMotion(next: MotionName): void {
  if (!isMotionName(next)) return
  motion.value = next
  writeStorage(MOTION_STORAGE_KEY, next)
}

/**
 * 主题与外观偏好 (模块级单例)
 * 所有消费者共享同一份状态与同一个系统偏好监听器。
 */
export function useTheme() {
  ensureInitialized()
  return {
    theme,
    resolvedTheme,
    accent,
    density,
    motion,
    setTheme,
    setAccent,
    setDensity,
    setMotion,
    availableThemes,
    availableAccents,
    availableDensities,
    availableMotions,
  }
}

/**
 * 移除模块级监听与 watch 并把内存偏好复位 (仅用于测试与 Vite HMR)
 * 不会清理 localStorage; 下次 useTheme() 会重新读取持久化值。
 */
export function disposeTheme(): void {
  if (stopWatch) {
    stopWatch()
    stopWatch = null
  }
  if (mediaQuery && mediaQueryHandler) {
    mediaQuery.removeEventListener('change', mediaQueryHandler)
  }
  mediaQuery = null
  mediaQueryHandler = null
  initialized = false
  theme.value = DEFAULT_THEME
  accent.value = DEFAULT_ACCENT
  density.value = DEFAULT_DENSITY
  motion.value = DEFAULT_MOTION
  systemPrefersLight.value = false
}
