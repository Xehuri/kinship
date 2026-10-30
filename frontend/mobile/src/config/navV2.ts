/**
 * v2 导航配置 (单一事实来源)
 *
 * 路由、壳层导航与 Ctrl+1~6 快捷键均从此派生。
 * 桌面 6 项 / 移动 4 项; 不包含看板或健康入口。
 * 计划页插在对话之后、提醒之前 (桌面第二项; 移动端对话之后), 因为
 * 计划是每天最先要看的上下文, 但不抢占对话的默认入口。
 */

/** 桌面导航标识 */
export type NavV2Id = 'chat' | 'plan' | 'reminders' | 'reports' | 'files' | 'settings'

/** 移动端底部导航标识 (桌面导航的子集) */
export type MobileNavV2Id = 'chat' | 'plan' | 'reports' | 'settings'

/** 单个 v2 导航项 */
export interface NavV2Item {
  id: NavV2Id
  route: string
  label: string
  icon: string
}

/** 移动端导航项 */
export interface MobileNavV2Item {
  id: MobileNavV2Id
  route: string
  label: string
  icon: string
}

/** 桌面主栏: 恰好 6 项, 顺序固定 */
export const NAV_V2_DESKTOP: readonly NavV2Item[] = [
  { id: 'chat', route: '/chat', label: '对话', icon: 'chat-circle-text' },
  { id: 'plan', route: '/plan', label: '计划', icon: 'list-checks' },
  { id: 'reminders', route: '/reminders', label: '提醒', icon: 'bell' },
  { id: 'reports', route: '/reports', label: '报告', icon: 'chart-bar' },
  { id: 'files', route: '/files', label: '文件', icon: 'files' },
  { id: 'settings', route: '/settings', label: '设置', icon: 'gear' },
]

/** 移动端底部导航: 恰好 4 项 */
export const NAV_V2_MOBILE: readonly MobileNavV2Item[] = [
  { id: 'chat', route: '/chat', label: '对话', icon: 'chat-circle-text' },
  { id: 'plan', route: '/plan', label: '计划', icon: 'list-checks' },
  { id: 'reports', route: '/reports', label: '报告', icon: 'chart-bar' },
  { id: 'settings', route: '/settings', label: '设置', icon: 'gear' },
]

/** Ctrl+数字 -> 路由路径 (数字从 1 开始), 顺序与桌面导航一致 */
export const NAV_V2_SHORTCUT_ROUTES: Record<string, string> = Object.fromEntries(
  NAV_V2_DESKTOP.map((item, index) => [String(index + 1), item.route]),
)
