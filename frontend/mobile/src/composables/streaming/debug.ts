/**
 * SSE 调试日志 (T-C5)
 *
 * 从 useStreamingMessage 拆出的调试开关与日志输出:
 *   - 默认关闭, 避免生产环境控制台刷屏;
 *   - 需要排查时调用 setSSEDebug(true), 或在浏览器控制台执行
 *     localStorage.setItem('axeuh_sse_debug', '1') 后刷新。
 *
 * 计数器与开关均为模块级状态, 与单例 useStreamingMessage 行为一致。
 */

/** 调试用: SSE 事件计数器 */
let _sseLogCount = 0

/** SSE 调试日志开关覆盖值 (null 表示未显式设置, 走 localStorage) */
let _sseDebugOverride: boolean | null = null

/** 设置 SSE 调试日志开关 (T-C5) */
export function setSSEDebug(enabled: boolean): void {
  _sseDebugOverride = enabled
}

/** 当前是否开启 SSE 调试日志 */
export function isSSEDebugEnabled(): boolean {
  if (_sseDebugOverride !== null) return _sseDebugOverride
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('axeuh_sse_debug') === '1'
  } catch {
    return false
  }
}

/** 输出 SSE 调试日志 (仅在调试开关开启时) */
export function debugLog(...args: unknown[]): void {
  if (isSSEDebugEnabled()) {
    console.warn(...args)
  }
}

/** SSE 事件计数器自增并返回当前值 (供事件调试日志编号) */
export function nextSSELogCount(): number {
  _sseLogCount++
  return _sseLogCount
}
