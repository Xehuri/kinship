/**
 * 计划 (Plan) 类型
 *
 * 对应后端只读接口:
 *   - GET /api/plan/{date}
 *   - GET /api/plan/long-tasks
 *
 * 字段以 docs/loom-plan-flow-persona-2026-10-27.md 的计划/长期任务契约为准;
 * 前端 v1 只读, 不提供编辑写回。
 */

/** 计划条目类别 */
export type PlanItemKind = 'care' | 'coverage' | 'review' | 'long_task' | 'note';

/** 计划条目状态 */
export type PlanItemStatus = 'planned' | 'done' | 'skipped' | 'carried' | 'blocked';

/** 计划文档状态 */
export type PlanStatus = 'draft' | 'committed' | 'closed';

/** Coverage 档位 (默认 merged_7, 可选 merged_6) */
export type PlanCoverageProfile = 'merged_7' | 'merged_6';

/** 长期任务节奏 */
export type LongTaskCadence = 'daily' | 'weekly' | 'monthly' | 'once';

/** 长期任务状态 */
export type LongTaskStatus = 'active' | 'paused' | 'archived';

/** 长期任务完成后的复盘策略 */
export type LongTaskReviewPolicy = 'after_done' | 'none';

/** 单条计划条目 */
export interface PlanItem {
  /** 条目 ID (当日计划内唯一) */
  id: string;
  /** 条目类别 */
  kind: PlanItemKind;
  /** 意图: 为什么做, 不是怎么做 */
  intent: string;
  /** 当前状态 */
  status: PlanItemStatus;
  /** 目标日期 (跨日条目, 如 cov-00 指向昨天) */
  target_date?: string;
  /** 时间窗 (如 "09:30~11:00") */
  window?: string;
  /** 关联的 coverage 检查点 ID */
  checkpoint_id?: string;
  /** 可观察的完成条件 */
  done_when?: string;
  /** 不主动做的事项 */
  not_do?: string;
  /** 条目来源 (如 "data_check") */
  source?: string;
  /** 备注 */
  note?: string;
}

/** Coverage 概览 */
export interface PlanCoverage {
  /** 使用的检查点档位 */
  profile: PlanCoverageProfile;
  /** 检查点 ID 列表 */
  checkpoints: string[];
  /** 未收口的 coverage 欠账 */
  debt: string[];
}

/** 单日计划文档 */
export interface PlanDocument {
  /** Schema 版本 */
  schema: 1;
  /** 计划日期 (YYYY-MM-DD) */
  date: string;
  /** 计划状态 */
  status: PlanStatus;
  /** 修订版本号 */
  version: number;
  /** 创建时间 (Unix 秒) */
  created_at: number;
  /** 更新时间 (Unix 秒) */
  updated_at: number;
  /** 复盘时间 (Unix 秒) */
  review_at: number;
  /** 计划条目 */
  items: PlanItem[];
  /** Coverage 概览 */
  coverage: PlanCoverage;
  /** 计划备注 */
  notes: string[];
}

/** 长期任务模板 */
export interface LongTask {
  /** Schema 版本 */
  schema: 1;
  /** 任务 ID */
  id: string;
  /** 标题 */
  title: string;
  /** 意图 */
  intent: string;
  /** 节奏 */
  cadence: LongTaskCadence;
  /** 下次检查时间 (ISO 8601) */
  next_check: string;
  /** 上次完成时间 (ISO 8601, 未完成为 null) */
  last_done: string | null;
  /** 任务状态 */
  status: LongTaskStatus;
  /** 完成后的复盘策略 */
  review_policy: LongTaskReviewPolicy;
  /** 备注 */
  notes: string[];
  /** 创建时间 (Unix 秒) */
  created_at: number;
  /** 更新时间 (Unix 秒) */
  updated_at: number;
  /** 修订版本号 */
  version: number;
}

/** GET /api/plan/{date} 响应 */
export interface PlanDayResponse {
  /** 请求日期 (YYYY-MM-DD) */
  date: string;
  /** 当日计划, 无计划时为 null */
  plan: PlanDocument | null;
  /** Coverage 概览, 无数据时为 null */
  coverage: PlanCoverage | null;
  /** 当日到期的长期任务 */
  long_tasks_due: LongTask[];
  /** 非致命告警 */
  warnings: string[];
  /** 生成时间 (Unix 秒) */
  generated_at: number;
}

/** GET /api/plan/long-tasks 响应 */
export interface PlanLongTasksResponse {
  /** 长期任务列表 */
  tasks: LongTask[];
  /** 生成时间 (Unix 秒) */
  generated_at: number;
}

/* ── 有效视图 (母版 + 当日覆盖层, T13 只读) ────────────────────── */

/** 母版条目类别 (loom-harness master-plan) */
export type MasterEntryKind = 'fixed' | 'anchor' | 'long_term';

/** 母版排班种类 */
export type MasterScheduleKind = 'daily' | 'weekly' | 'monthly' | 'once';

/** 母版排班 (周几 0=周日..6=周六, 允许 "mon" 这类简写) */
export type MasterSchedule =
  | { kind: 'daily'; at: string }
  | { kind: 'weekly'; days: (string | number)[]; at: string }
  | { kind: 'monthly'; days: (number | string)[]; at: string }
  | { kind: 'once'; date: string; at: string };

/** 母版条目 (GET effective 的 master.entries) */
export interface MasterPlanEntry {
  id: string;
  kind: MasterEntryKind;
  title: string;
  intent?: string;
  enabled: boolean;
  action?: string;
  payload?: unknown;
  instruction?: string;
  schedule: MasterSchedule;
  target_date?: 'today' | 'previous_day';
  window?: string;
  done_when?: string;
  created_at: number;
  updated_at: number;
  last_done?: string;
  status?: LongTaskStatus;
  next_check?: string;
  legacy_long_task_id?: string;
}

/** 母版摘要 (GET effective 的 master 字段) */
export interface MasterPlanSummary {
  timezone: string;
  entries: MasterPlanEntry[];
}

/** 覆盖层状态 */
export type PlanOverlayStatus = 'draft' | 'committed' | 'closed';

/** 覆盖层 add 的条目输入 */
export interface PlanOverlayItemInput {
  id: string;
  kind: PlanItemKind;
  intent: string;
  status: PlanItemStatus;
  at?: string;
  action?: string;
  payload?: unknown;
  window?: string;
  done_when?: string;
  target_date?: string;
  checkpoint_id?: string;
  not_do?: string[];
  note?: string;
  evidence?: string;
  done_at?: string;
}

/** 覆盖层 update 的局部修改 (null 表示清除可选字段) */
export interface PlanOverlayPatch {
  at?: string | null;
  action?: string | null;
  payload?: unknown;
  intent?: string | null;
  window?: string | null;
  done_when?: string | null;
  note?: string | null;
  status?: PlanItemStatus;
  evidence?: string | null;
  done_at?: string | null;
}

/** 覆盖层差量操作 */
export type PlanOverlayOp =
  | { op: 'add'; item: PlanOverlayItemInput }
  | { op: 'update'; id: string; patch: PlanOverlayPatch }
  | { op: 'remove'; id: string }
  | { op: 'note'; text: string };

/** 当日覆盖层文档 (GET effective 的 overlay 字段) */
export interface PlanOverlayDocumentSummary {
  schema: 1;
  kind: 'plan-overlay';
  date: string;
  base_version: number;
  version: number;
  status: PlanOverlayStatus;
  created_at: number;
  updated_at: number;
  ops: PlanOverlayOp[];
  notes: string[];
  coverage: PlanCoverage;
}

/** 有效视图条目种类 (母版类 + 旧日计划类) */
export type EffectivePlanItemKind = MasterEntryKind | PlanItemKind;

/** 有效视图条目 (母版物化 + 覆盖层差量后的只读投影) */
export interface EffectivePlanItem {
  id: string;
  kind: EffectivePlanItemKind;
  title?: string;
  intent?: string;
  at?: string;
  at_override: boolean;
  action?: string;
  payload?: unknown;
  instruction?: string;
  window?: string;
  done_when?: string;
  target_date?: string;
  checkpoint_id?: string;
  not_do?: string[];
  note?: string;
  status: PlanItemStatus;
  evidence?: string;
  done_at?: string;
  source: 'master' | 'overlay';
  suppressed: boolean;
  master_version: number | null;
  overlay_version: number | null;
}

/** GET /api/plan/{date}/effective 响应 */
export interface EffectivePlanResponse {
  date: string;
  master_version: number | null;
  master: MasterPlanSummary | null;
  overlay: PlanOverlayDocumentSummary | null;
  effective: {
    items: EffectivePlanItem[];
    coverage: PlanCoverage | null;
  };
  long_tasks_due: LongTask[];
  warnings: string[];
  generated_at: number;
}
