/**
 * Web 后端热切换 API (W31)
 *
 * 对应 /api/screen/backend 接口 (契约固定, 勿自行增删字段):
 *   - GET  /api/screen/backend -> 200 { ok: true, backend, options }
 *   - POST /api/screen/backend body { backend } -> 200 同 GET 形态;
 *     非法取值 -> 400 { ok: false, error }
 *
 * 与 session.ts / downloads.ts 等邻居一致: 请求失败/响应无法归一化时
 * 统一吞为 null (apiGet/apiPostVerbose 内部已 console.warn), 不向上抛。
 *
 * 语义: 仅影响网页对话通道 (opencode:5096 / loom:5100);
 * 定时任务/脚本/语音仍按全局配置走 opencode, 与本开关无关。
 */

import { apiGet, apiPostVerbose } from '@/api/client'

// ==================== 类型 ====================

/** Web 对话通道可选后端 */
export type WebBackendId = 'opencode' | 'loom'

/** 合法取值清单 (与后端契约一致, 归一化回退基准) */
const WEB_BACKEND_OPTIONS: readonly WebBackendId[] = ['opencode', 'loom']

/** 当前后端运行状态 */
export interface WebBackendState {
  /** 当前生效后端 */
  backend: WebBackendId
  /** 可选项 (响应缺失/非法时回退全量清单) */
  options: WebBackendId[]
}

/** POST 切换结果 */
export interface WebBackendSwitchResult {
  /** 后端是否确认切换成功 */
  ok: boolean
  /** 切换后的当前生效后端 (失败响应无此字段时为空串) */
  backend: WebBackendId | ''
}

// ==================== 归一化 ====================

/** 运行时判定合法后端标识 (后端新增取值时前端按未知处理, 不会误发) */
function isWebBackendId(v: unknown): v is WebBackendId {
  return typeof v === 'string' && (WEB_BACKEND_OPTIONS as readonly string[]).includes(v)
}

/**
 * 归一化响应体为 WebBackendState
 *
 * 容错: 非对象/backend 非法 -> null;
 * options 缺失或全非法 -> 回退全量清单 (保证 UI 有可选项)。
 */
function normalizeState(raw: unknown): WebBackendState | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!isWebBackendId(r.backend)) return null
  const options = Array.isArray(r.options) ? r.options.filter(isWebBackendId) : []
  return {
    backend: r.backend,
    options: options.length > 0 ? options : [...WEB_BACKEND_OPTIONS],
  }
}

// ==================== API 函数 ====================

/**
 * 查询当前 Web 通道后端
 * GET /api/screen/backend
 * @returns 运行状态; 请求失败或响应非法时 null (不抛异常)
 */
export async function fetchWebBackend(): Promise<WebBackendState | null> {
  try {
    const result = await apiGet<Record<string, unknown>>('/api/screen/backend')
    return normalizeState(result)
  } catch (e) {
    console.warn('[backend] 查询 Web 后端失败:', e)
    return null
  }
}

/**
 * 切换 Web 通道后端
 * POST /api/screen/backend, body { backend }
 *
 * @param backend 目标后端
 * @returns 成功 { ok: true, backend: 新当前值 };
 *          后端明确拒绝 (如 400 非法值) { ok: false, backend: '' };
 *          网络异常无法判定时 null (与"明确失败"区分, 调用方均不应视为成功)
 */
export async function switchWebBackend(
  backend: WebBackendId,
): Promise<WebBackendSwitchResult | null> {
  try {
    const res = await apiPostVerbose<Record<string, unknown>>(
      '/api/screen/backend',
      { backend },
    )
    // status=0 为 apiPostVerbose 网络异常哨兵值, 无法判定后端状态, 吞为 null
    if (res.status === 0) return null
    const state = normalizeState(res.data)
    if (res.ok && state) return { ok: true, backend: state.backend }
    // 4xx (如 400 {ok:false,error}) 或 2xx 但响应体无法归一化: 一律视为未生效
    return { ok: false, backend: state ? state.backend : '' }
  } catch (e) {
    console.warn('[backend] 切换 Web 后端失败:', e)
    return null
  }
}
