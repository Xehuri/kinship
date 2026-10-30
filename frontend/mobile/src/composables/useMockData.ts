/**
 * 全局模拟数据开关 — 生产部署时默认为 false
 *
 * 所有组件的 mock 模式统一由此导出控制。
 * 导入方式: import { USE_MOCK_DATA } from '@/composables/useMockData'
 *
 * 开关值从 localStorage 读取 (key: mobile_mock_data), 可在设置页运行时切换。
 * 切换后需刷新页面生效 (模块加载时读取)。
 */

/** localStorage 存储 key */
const MOCK_DATA_KEY = 'mobile_mock_data'

/** 读取持久化的开关值, 默认 false (生产模式) */
function readMockDataFlag(): boolean {
  try {
    return localStorage.getItem(MOCK_DATA_KEY) === 'true'
  } catch {
    return false
  }
}

/** 设为 true 时跳过 API 调用, 直接返回 mock 数据 (用于 UI 开发/调试) */
export const USE_MOCK_DATA = readMockDataFlag()

/**
 * 持久化演示模式开关值
 * 写入 localStorage, 页面刷新后 USE_MOCK_DATA 读取新值
 */
export function setMockDataEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(MOCK_DATA_KEY, enabled ? 'true' : 'false')
  } catch {
    // localStorage 不可用时静默失败
  }
}
