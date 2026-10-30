import { ref, watch, type WatchStopHandle } from 'vue'

/**
 * 顶部页边距调节 (模块级单例)
 *
 * 背景: 全面屏手机的状态栏会压住网页顶部元素 (例如全屏浮层右上角的关闭按钮),
 * 而 Android WebView 下 env(safe-area-inset-top) 常为 0 (缺少 viewport-fit=cover),
 * 无法纯自动避让, 因此提供用户手动调节。
 *
 * 数据流:
 *   localStorage('top_inset') → 模块级 ref → <html> 内联样式 --user-top-inset
 *   → CSS: --app-top-inset = max(--user-top-inset, --safe-top-env) → 各顶部元素 padding
 *
 * 与 useTheme.ts 保持一致的设计: 模块级共享状态 + 幂等初始化 + 只注册一次 watch。
 */

/** localStorage 键名 */
const STORAGE_KEY = 'top_inset'

/** 可调范围下限 [px] */
export const TOP_INSET_MIN = 0
/** 可调范围上限 [px] */
export const TOP_INSET_MAX = 80
/** 调节步长 [px] */
export const TOP_INSET_STEP = 4

/** 当前顶部页边距 [px] (模块级共享) */
const topInset = ref(0)

/** 是否已完成首次初始化 (懒初始化, 避免模块加载时就访问 window/localStorage) */
let initialized = false
/** 值变化的同步句柄 (仅用于测试/HMR 清理) */
let stopWatch: WatchStopHandle | null = null

/**
 * 将任意输入收敛到合法值
 * 非数字 → 0; 越界 → 边界值; 按步长四舍五入
 */
export function clampTopInset(value: number): number {
  if (!Number.isFinite(value)) return TOP_INSET_MIN
  const snapped = Math.round(value / TOP_INSET_STEP) * TOP_INSET_STEP
  if (snapped < TOP_INSET_MIN) return TOP_INSET_MIN
  if (snapped > TOP_INSET_MAX) return TOP_INSET_MAX
  return snapped
}

/** 写入根元素内联 CSS 变量 (优先级高于 :root 初始值) */
function applyTopInset(value: number): void {
  document.documentElement.style.setProperty('--user-top-inset', `${value}px`)
}

/** 读取初始值: localStorage 中的合法数值, 否则 0 */
function getInitialTopInset(): number {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === null) return TOP_INSET_MIN
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return TOP_INSET_MIN
  return clampTopInset(parsed)
}

/** 幂等的首次初始化: 读取持久化值, 应用, 并建立同步 watch */
function ensureInitialized(): void {
  if (initialized) return
  initialized = true

  topInset.value = getInitialTopInset()
  applyTopInset(topInset.value)

  // 值变化时同步到 DOM (setTopInset / resetTopInset 均会触发)
  stopWatch = watch(
    topInset,
    (v) => {
      applyTopInset(v)
    },
    { flush: 'sync' },
  )
}

/** 设置顶部页边距并持久化 (自动收敛到合法值) */
function setTopInset(value: number): void {
  const next = clampTopInset(value)
  topInset.value = next
  localStorage.setItem(STORAGE_KEY, String(next))
  applyTopInset(next)
}

/** 重置为默认值 0 (跟随系统安全区) */
function resetTopInset(): void {
  setTopInset(TOP_INSET_MIN)
}

/**
 * 顶部页边距管理 (模块级单例)
 * 所有消费者共享同一份 topInset 状态。
 */
export function useTopInset() {
  ensureInitialized()
  return {
    topInset,
    setTopInset,
    resetTopInset,
    TOP_INSET_MIN,
    TOP_INSET_MAX,
    TOP_INSET_STEP,
  }
}

/**
 * 移除模块级 watch 并重置初始化标记 (仅用于测试与 Vite HMR)
 * 注意: 不重置 topInset 当前值, 重置后下次 useTopInset() 会重新读取初始值。
 */
export function disposeTopInset(): void {
  if (stopWatch) {
    stopWatch()
    stopWatch = null
  }
  initialized = false
}
