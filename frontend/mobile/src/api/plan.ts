/**
 * 计划 (Plan) API
 *
 * 对应后端只读接口:
 *   - GET /api/plan/{date}            -> PlanDayResponse
 *   - GET /api/plan/{date}/effective  -> EffectivePlanResponse (T13)
 *   - GET /api/plan/long-tasks        -> PlanLongTasksResponse
 *
 * apiGet 对失败统一返回 null (不抛异常); 计划界面需要区分"空计划"
 * (plan: null 是合法响应) 与"请求失败", 因此本模块在 null/结构非法时
 * 抛出 PlanApiError, 由 usePlan 转为 error 状态。
 *
 * 使用方式:
 *   import { fetchPlanDay, fetchLongTasks } from '@/api/plan'
 */

import { apiGet, apiGetVerbose } from '@/api/client';
import type {
  LongTask,
  PlanCoverage,
  PlanDayResponse,
  PlanDocument,
  PlanLongTasksResponse,
} from '@/types';
import type {
  EffectivePlanItem,
  EffectivePlanResponse,
  MasterPlanSummary,
  PlanOverlayDocumentSummary,
} from '@/types/plan';

/** 计划接口错误 (区分空计划与请求失败) */
export class PlanApiError extends Error {
  /** 请求路径 */
  readonly path: string;
  /** HTTP 状态码 (网络异常为 0) */
  readonly status: number;

  constructor(path: string, detail?: string, status = 0) {
    super(detail ? `计划接口请求失败: ${path} (${detail})` : `计划接口请求失败: ${path}`);
    this.name = 'PlanApiError';
    this.path = path;
    this.status = status;
  }
}

/** 判断是否为普通对象 (排除 null / 数组) */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 取受控的非负时间戳 (缺失/非法回退 0) */
function toTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 请求计划接口并保证拿到对象响应
 *
 * apiGet 自身吞掉 HTTP/网络错误返回 null; 这里把 null 与非法结构统一
 * 转成 PlanApiError, 让调用方可以走 error 分支。
 */
async function getPlanObject(path: string): Promise<Record<string, unknown>> {
  try {
    const data = await apiGet<unknown>(path);
    if (!isRecord(data)) {
      throw new PlanApiError(path);
    }
    return data;
  } catch (e) {
    if (e instanceof PlanApiError) throw e;
    const detail = e instanceof Error && e.message ? e.message : String(e);
    throw new PlanApiError(path, detail);
  }
}

/**
 * 获取某日计划
 * GET /api/plan/{date}
 *
 * 无计划时后端返回 plan: null; 该响应正常返回, 不视为错误。
 *
 * @param date YYYY-MM-DD
 * @throws PlanApiError 请求失败或响应结构非法
 */
export async function fetchPlanDay(date: string): Promise<PlanDayResponse> {
  const path = '/api/plan/' + encodeURIComponent(date);
  const data = await getPlanObject(path);

  if (typeof data.date !== 'string') {
    throw new PlanApiError(path, '响应缺少 date');
  }

  const rawPlan = data.plan;
  if (rawPlan !== null && rawPlan !== undefined && !isRecord(rawPlan)) {
    throw new PlanApiError(path, '响应 plan 结构非法');
  }

  const rawCoverage = data.coverage;
  if (
    rawCoverage !== null &&
    rawCoverage !== undefined &&
    !isRecord(rawCoverage)
  ) {
    throw new PlanApiError(path, '响应 coverage 结构非法');
  }

  return {
    date: data.date,
    plan: (rawPlan ?? null) as PlanDocument | null,
    coverage: (rawCoverage ?? null) as PlanCoverage | null,
    long_tasks_due: Array.isArray(data.long_tasks_due)
      ? (data.long_tasks_due as LongTask[])
      : [],
    warnings: Array.isArray(data.warnings)
      ? data.warnings.filter((item): item is string => typeof item === 'string')
      : [],
    generated_at: toTimestamp(data.generated_at),
  };
}

/**
 * 获取长期任务列表
 * GET /api/plan/long-tasks
 *
 * @throws PlanApiError 请求失败或响应结构非法
 */
export async function fetchLongTasks(): Promise<PlanLongTasksResponse> {
  const path = '/api/plan/long-tasks';
  const data = await getPlanObject(path);

  if (!Array.isArray(data.tasks)) {
    throw new PlanApiError(path, '响应缺少 tasks');
  }

  return {
    tasks: data.tasks as LongTask[],
    generated_at: toTimestamp(data.generated_at),
  };
}

/** 旧后端无 effective 端点时的 HTTP 状态 (400 = 被 v1 {date:path} 吞掉) */
const EFFECTIVE_UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([400, 404, 405]);

/**
 * 获取某日有效视图 (母版 + 当日覆盖层)
 * GET /api/plan/{date}/effective
 *
 * 旧后端/路由缺失返回 null, 由调用方回退 v1; 其余失败抛 PlanApiError,
 * 让母版/覆盖层损坏 (500) 如实暴露而不是被静默降级。
 *
 * @param date YYYY-MM-DD
 * @throws PlanApiError 非"端点缺失"的请求失败或响应结构非法
 */
export async function fetchEffectivePlan(
  date: string,
): Promise<EffectivePlanResponse | null> {
  const path = '/api/plan/' + encodeURIComponent(date) + '/effective';
  const response = await apiGetVerbose<unknown>(path);

  if (EFFECTIVE_UNAVAILABLE_STATUSES.has(response.status)) return null;
  if (!response.ok) {
    throw new PlanApiError(
      path,
      response.status === 0 ? '网络异常' : `HTTP ${response.status}`,
      response.status,
    );
  }

  const data = response.data;
  if (!isRecord(data)) {
    throw new PlanApiError(path, '响应结构非法', response.status);
  }
  if (typeof data.date !== 'string') {
    throw new PlanApiError(path, '响应缺少 date', response.status);
  }
  if (!isRecord(data.effective)) {
    throw new PlanApiError(path, '响应缺少 effective', response.status);
  }

  const rawEffective = data.effective;
  if (!Array.isArray(rawEffective.items)) {
    throw new PlanApiError(path, '响应缺少 effective.items', response.status);
  }

  const rawMaster = data.master;
  if (rawMaster !== null && rawMaster !== undefined && !isRecord(rawMaster)) {
    throw new PlanApiError(path, '响应 master 结构非法', response.status);
  }
  const rawOverlay = data.overlay;
  if (rawOverlay !== null && rawOverlay !== undefined && !isRecord(rawOverlay)) {
    throw new PlanApiError(path, '响应 overlay 结构非法', response.status);
  }

  const rawMasterVersion = data.master_version;
  return {
    date: data.date,
    master_version:
      typeof rawMasterVersion === 'number' && Number.isFinite(rawMasterVersion)
        ? rawMasterVersion
        : null,
    master: (rawMaster ?? null) as MasterPlanSummary | null,
    overlay: (rawOverlay ?? null) as PlanOverlayDocumentSummary | null,
    effective: {
      items: rawEffective.items as EffectivePlanItem[],
      coverage: isRecord(rawEffective.coverage)
        ? (rawEffective.coverage as unknown as PlanCoverage)
        : null,
    },
    long_tasks_due: Array.isArray(data.long_tasks_due)
      ? (data.long_tasks_due as LongTask[])
      : [],
    warnings: Array.isArray(data.warnings)
      ? data.warnings.filter((item): item is string => typeof item === 'string')
      : [],
    generated_at: toTimestamp(data.generated_at),
  };
}
