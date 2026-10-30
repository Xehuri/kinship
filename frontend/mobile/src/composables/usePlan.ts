/**
 * 计划 Composable — 单日计划 / 长期任务读取与 Loom 重排
 *
 * 数据面:
 *   - refresh() 同时读取 GET /api/plan/{date}/effective 与 /api/plan/long-tasks;
 *   - effective 端点缺失 (旧后端 400/404) 时回退 GET /api/plan/{date};
 *   - 两个请求都成功后才整体替换状态 (无部分写入); 失败保留上次成功数据。
 *
 * 重排:
 *   - requestReplan() 复用 web 对话的 sendMessage 路径, 向当前会话发送
 *     【计划重排】控制文本, backend 固定为 loom; 本模块不写任何文件。
 *
 * 使用方式:
 *   const { date, plan, coverage, longTasks, loading, error, refresh, setDate, requestReplan } = usePlan()
 *   await refresh()
 */

import { ref, readonly, shallowRef, type Ref } from 'vue';
import type {
  LongTask,
  PlanCoverage,
  PlanDocument,
  PlanItem,
  PlanItemKind,
} from '@/types';
import type { EffectivePlanItem, EffectivePlanResponse } from '@/types/plan';
import { fetchEffectivePlan, fetchLongTasks, fetchPlanDay } from '@/api/plan';
import {
  fetchCurrentSessionId,
  listSessions,
  sendMessage as apiSendMessage,
} from '@/api/session';
import { resolveCurrentSessionId } from '@/composables/chat/sessionList';

/** 重排控制文本 (协议固定, 不要改字) */
export const PLAN_REPLAN_TEXT = '【计划重排】请根据今天的计划重新安排。';

/** YYYY-MM-DD 形状 */
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 本地日期格式化为 YYYY-MM-DD (不用 toISOString, 避免 UTC 偏移) */
export function localPlanDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 严格校验 YYYY-MM-DD (含真实日历日, 拒绝 2026-02-30) */
export function isValidPlanDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

/** 从未知异常中提取可展示的错误信息 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/** 母版类 -> 旧看板类别 (旧 UI 只认识 PlanItemKind) */
const EFFECTIVE_KIND_MAP: Record<string, PlanItemKind> = {
  fixed: 'care',
  anchor: 'coverage',
  long_term: 'long_task',
  care: 'care',
  coverage: 'coverage',
  review: 'review',
  long_task: 'long_task',
  note: 'note',
};

/** 有效视图条目 -> 旧 PlanItem 形状 (丢弃 suppressed/版本等展示无关字段) */
function toPlanItem(item: EffectivePlanItem): PlanItem {
  return {
    id: item.id,
    kind: EFFECTIVE_KIND_MAP[item.kind] ?? 'note',
    intent: item.intent ?? item.title ?? item.id,
    status: item.status,
    source: item.source,
    ...(item.target_date === undefined ? {} : { target_date: item.target_date }),
    ...(item.window === undefined ? {} : { window: item.window }),
    ...(item.checkpoint_id === undefined
      ? {}
      : { checkpoint_id: item.checkpoint_id }),
    ...(item.done_when === undefined ? {} : { done_when: item.done_when }),
    ...(item.not_do === undefined ? {} : { not_do: item.not_do.join('；') }),
    ...(item.note === undefined ? {} : { note: item.note }),
  };
}

/** 把 effective 响应折成旧 PlanDocument 形状; 无条目且无覆盖层时视为空计划 */
function planFromEffective(response: EffectivePlanResponse): PlanDocument | null {
  const items = response.effective.items
    .filter((item) => !item.suppressed)
    .map(toPlanItem);
  if (items.length === 0 && response.overlay === null) return null;
  const overlay = response.overlay;
  return {
    schema: 1,
    date: response.date,
    status: overlay?.status ?? 'committed',
    version: overlay?.version ?? response.master_version ?? 1,
    created_at: overlay?.created_at ?? 0,
    updated_at: overlay?.updated_at ?? 0,
    review_at: 0,
    items,
    coverage: response.effective.coverage ?? {
      profile: 'merged_7',
      checkpoints: [],
      debt: [],
    },
    notes: overlay?.notes ?? [],
  };
}

/** 单日数据: effective 优先, 端点缺失回退 v1 */
interface PlanDayData {
  plan: PlanDocument | null;
  coverage: PlanCoverage | null;
  warnings: string[];
  effective: EffectivePlanResponse | null;
}

async function loadPlanDay(date: string): Promise<PlanDayData> {
  const effective = await fetchEffectivePlan(date);
  if (effective !== null) {
    return {
      plan: planFromEffective(effective),
      coverage: effective.effective.coverage,
      warnings: effective.warnings,
      effective,
    };
  }
  const day = await fetchPlanDay(date);
  return {
    plan: day.plan,
    coverage: day.coverage,
    warnings: day.warnings,
    effective: null,
  };
}

/** usePlan 返回值 */
export interface UsePlanReturn {
  /** 当前查看日期 (YYYY-MM-DD) */
  date: Ref<string>;
  /** 当前日计划, 无计划为 null */
  plan: Ref<PlanDocument | null>;
  /** Coverage 概览 */
  coverage: Ref<PlanCoverage | null>;
  /** 长期任务列表 */
  longTasks: Ref<LongTask[]>;
  /** 后端非致命告警 */
  warnings: Ref<string[]>;
  /** 最近一次 effective 响应 (旧后端回退时为 null) */
  effectivePlan: Readonly<Ref<EffectivePlanResponse | null>>;
  /** 正在加载 */
  loading: Readonly<Ref<boolean>>;
  /** 最近一次加载/重排错误 (null 表示无错误) */
  error: Readonly<Ref<string | null>>;
  /** 重新读取当前日期的计划与长期任务 */
  refresh: () => Promise<void>;
  /** 切换日期并刷新 (非法日期返回 false, 不发起请求) */
  setDate: (next: string) => Promise<boolean>;
  /** 请求 Loom 按今天的计划重排 (发送控制文本, 不写文件) */
  requestReplan: () => Promise<boolean>;
}

/**
 * @param initialDate 可选初始日期 (YYYY-MM-DD), 非法/缺省时使用本地今天
 */
export function usePlan(initialDate?: string): UsePlanReturn {
  const date = ref(
    initialDate && isValidPlanDate(initialDate)
      ? initialDate
      : localPlanDate(),
  );
  const plan = ref<PlanDocument | null>(null);
  const coverage = ref<PlanCoverage | null>(null);
  const longTasks = ref<LongTask[]>([]);
  const warnings = ref<string[]>([]);
  const effectivePlan = shallowRef<EffectivePlanResponse | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  /**
   * 同时加载单日计划与长期任务
   *
   * Promise.all: 任一请求失败都不会写入任何字段, 保证 plan/coverage/
   * longTasks/warnings 始终来自同一批成功响应。
   */
  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const [day, taskList] = await Promise.all([
        loadPlanDay(date.value),
        fetchLongTasks(),
      ]);
      plan.value = day.plan;
      coverage.value = day.coverage;
      longTasks.value = taskList.tasks;
      warnings.value = day.warnings;
      effectivePlan.value = day.effective;
    } catch (e) {
      error.value = '计划加载失败：' + toErrorMessage(e);
    } finally {
      loading.value = false;
    }
  }

  /** 切换日期; 非法日期不改变当前状态 */
  async function setDate(next: string): Promise<boolean> {
    if (!isValidPlanDate(next)) return false;
    date.value = next;
    await refresh();
    return true;
  }

  /**
   * 解析当前 web 会话 ID
   *
   * 复用 api/session 的当前会话查询 + 会话列表, 并交给 chat/sessionList
   * 的 resolveCurrentSessionId 做统一裁决 (current_session 优先, 回退首个)。
   */
  async function resolveSessionId(): Promise<string> {
    const [currentSession, sessions] = await Promise.all([
      fetchCurrentSessionId(),
      listSessions(),
    ]);
    return resolveCurrentSessionId(
      sessions ?? [],
      currentSession ?? undefined,
      '',
    );
  }

  /** 发送重排控制文本; 不触碰计划文件或本地数据 */
  async function requestReplan(): Promise<boolean> {
    error.value = null;
    try {
      const sessionId = await resolveSessionId();
      if (!sessionId) {
        error.value = '当前没有可用的会话，无法发送重排请求';
        return false;
      }

      const result = await apiSendMessage({
        session_id: sessionId,
        content: PLAN_REPLAN_TEXT,
        backend: 'loom',
      });
      if (!result) {
        error.value = '重排请求发送失败';
        return false;
      }
      return true;
    } catch (e) {
      error.value = '重排请求发送失败：' + toErrorMessage(e);
      return false;
    }
  }

  return {
    date,
    plan,
    coverage,
    longTasks,
    warnings,
    effectivePlan,
    loading: readonly(loading),
    error: readonly(error),
    refresh,
    setDate,
    requestReplan,
  };
}
