/**
 * T28 任务/运行域 API —— 类型契约（docs/02 §T28；决策 docs/01 D15/D17/D22/D31）。
 *
 * 一句话职责：把 run-engine（T12）+ 控制面（T25）+ 暂停开关（T17）拼成 HTTP 命令面：
 *   POST /runs                 —— 手动 dispatch（经 ControlPlane.spawnSide，actor 落账）
 *   GET  /runs                 —— run 列表（引擎登记表，?workflow= 过滤）
 *   GET  /runs/:runID          —— run 详情：ledger + trace join + attempt 链
 *   POST /runs/:runID/cancel   —— 取消（ControlPlane.cancel，actor 落账）
 *   POST /runs/:runID/rerun    —— 重派（ControlPlane.rerun：新 run、parent_run=源、attempt+1）
 *   GET  /pause                —— 暂停开关**只读**（写开关=配置文件走 T20，API 无写端点）
 *
 * 前端硬口径（docs/04 §3.2）：JSON 字段 snake_case；run_id 形状
 * `^[a-z][a-z0-9_]{2,4}_[0-9a-f]{16}$`，连字符永久禁用。
 * 响应必含 run_id / attempt / trigger / status 四字段（任务验收冻结）。
 */

import type { RunEngine, RunRecord, RunRow, RunState, LedgerTerminalStatus } from "@axeuh/loom-core/run-engine";
import type { SubTaskRecord } from "@axeuh/loom-core/kernel";
import type { ControlPlane } from "@axeuh/loom-core/control";
import type { PauseSwitchSource } from "@axeuh/loom-core/pause";
import type { LedgerRow } from "@axeuh/loom-adapters";

/** 账本行读取端口（server 装配接 `() => ledger.rows()`；只读，不改 T08 写侧）。 */
export type LedgerRowsSource = () => readonly LedgerRow[];

/** trace 读取配置（缺省不接 = 详情 trace 恒空数组；接了按日分片现读）。 */
export interface TaskApiTraceOptions {
  /** trace 根目录（内含 `trace/{dateKey}.jsonl`，与 T21 Tracer 同布局）。 */
  readonly stateRoot: string;
}

/** 路由装配依赖（T31 serve 组装时接真实实例；测试注入内存假件）。 */
export interface TaskApiDeps {
  /** 被查询的运行引擎（列表/详情原料：get/listRuns）。 */
  readonly engine: RunEngine;
  /** 控制面（dispatch/cancel/rerun 三指令 + actor 审计的唯一通道）。必填：控制即账。 */
  readonly plane: ControlPlane;
  /** 暂停开关热读源（GET /pause 只读展示）。必填：缺则装配期编译不过。 */
  readonly pauseSwitches: PauseSwitchSource;
  /** 账本行读取源（详情 ledger join 与重启后回退原料）。必填：join 是验收项。 */
  readonly ledgerRows: LedgerRowsSource;
  /** trace 读取（可选注入；缺省详情 trace 为空数组）。 */
  readonly trace?: TaskApiTraceOptions;
  /**
   * W12 归属旁路（可选）：POST /runs/rerun body 带 parentSessionId（发起主会话 sid）时
   * 派发成功即回调登记。**不进账本行形状**（RunRow 冻结）——终态提醒的目标解析消费面
   * 在 serve/run-reminder.ts；未接 = 字段被静默忽略（旧调用面不变）。
   */
  readonly noteRunParent?: (runId: string, parentSessionId: string) => void;
  /**
   * W9 切片 3（可选）：/tasks 面数据源（内核后台 sub 账本册的投影口，boot 传 SpawnKernel
   * 适配器）。未接 = 三端点 404 not_wired（旧调用面与 /runs 契约逐字节不变）。
   */
  readonly tasks?: TaskSurfaceSource;
}

/** /tasks 数据源窄接口（list/get/cancel；SpawnKernel 结构满足）。 */
export interface TaskSurfaceSource {
  list(): readonly SubTaskRecord[];
  get(taskId: string): SubTaskRecord | undefined;
  cancel(taskId: string, reason?: string): boolean;
}

/**
 * 响应 status 词表：引擎状态机 + 准入拒绝态（paused，不落登记）+ 账本死信态
 * + 「引擎与账本均无痕」的兜底词（仅重启回退路径理论上到不了，类型先行）。
 */
export type RunViewStatus = RunState | "paused" | "dead-letter" | "unknown";

/**
 * W9 切片 3：后台任务视图（toRunView 镜像 + task_id/agent_type/parent_session 三键）。
 * run_id=task_id 同值镜像（账本 join 键纪律：/tasks、trace、提醒、task_fetch 四面同一 id）。
 *
 * W23-C 历史合流面加宽（GET /tasks = 内核在飞 ∪ 账本 kind:"sub" 历史，run_id 并集）：
 * - `in_memory?: true` 来源标：**内核在飞册行 = true**；**账本-only 行 = 键缺席**
 *   （形状稳定：旧消费者按名取值不受影响；面板据此标"实时/历史"）；
 * - agent_type/parent_session/workflow/session_id/crashed 允许 null：账本行只如实携带
 *   expected payload 写过的键（kernel.ts:362-369 六键+三附加+W49.2 条件 title），缺/坏 = null 诚实，
 *   绝不造空串占位。内核行这些字段恒有值（SubTaskRecord 类型保证）。
 */
export interface TaskView {
  readonly task_id: string;
  readonly agent_type: string | null;
  readonly parent_session: string | null;
  /**
   * W49.2 人读标题：内核行直读登记册 / 账本行取 expected payload["title"]（宽容 .get 语义）；
   * 旧行无键 / 直连内核口未给 = **null 诚实**，绝不截任务正文现造（不 fabrication）。
   */
  readonly title: string | null;
  readonly run_id: string;
  readonly workflow: string | null;
  readonly session_id: string | null;
  readonly status: RunViewStatus;
  readonly dispatched_at: number;
  readonly terminal_at: number | null;
  readonly crashed: boolean | null;
  readonly cancel_requested: string | null;
  readonly error: string | null;
  readonly in_memory?: true;
}

/**
 * /tasks/:id 详情 = RunDetailView 同构（ledger+trace join）+ 任务身份-overlay。
 * W23-C：账本-only 详情 task/depth 不可导出（任务正文/深度从未进账本）= null 如实，
 * terminal 同 /runs 账本回退先例 = null（终局原料只到 status/at 粒度）。
 */
export interface TaskDetailView extends TaskView {
  readonly task: string | null;
  readonly depth: number | null;
  readonly terminal: RunRecord["terminal"];
  readonly ledger: LedgerJoin;
  readonly trace: readonly unknown[];
}

/** 列表视图（RunRecord → 响应行；snake_case）。 */
export interface RunView {
  readonly run_id: string;
  readonly workflow: string;
  readonly attempt: number;
  readonly trigger: string;
  readonly parent_run: string | null;
  readonly session_id: string;
  readonly status: RunViewStatus;
  readonly dispatched_at: number;
  readonly terminal_at: number | null;
  readonly crashed: boolean;
  readonly cancel_requested: string | null;
  readonly error: string | null;
}

/** 详情视图 = 列表视图 + 终局快照 + ledger join + trace spans + attempt 链。 */
export interface RunDetailView extends RunView {
  /** 终局快照（digest/pointers/blockers）；未达终态 = null。 */
  readonly terminal: RunRecord["terminal"];
  /** 账本行 join（D15）：开火时刻与终态行。 */
  readonly ledger: LedgerJoin;
  /** 当日 trace span 列表（T21 原料；未接 trace 或无记录 = 空数组）。 */
  readonly trace: readonly unknown[];
  /** attempt 链：由 parent_run 逐级上溯（含自身，旧→新）。 */
  readonly chain: readonly RunView[];
}

/** 详情里的账本 join 形状。 */
export interface LedgerJoin {
  /** expected 行时刻；无 = null（重启后不在本引擎登记且账本无行时可能）。 */
  readonly expected_at: number | null;
  /** actual 行；未收口/缺口 = null（缺口=D15 对账输入，如实暴露）。 */
  readonly actual: { readonly at: number; readonly status: LedgerTerminalStatus } | null;
}

/** GET /pause 响应（D31 开关快照，只读）。 */
export interface PauseStateView {
  readonly global: boolean;
  /** 逐工作流表（仅显式出现的键；缺键=未暂停）。 */
  readonly per_workflow: Readonly<Record<string, boolean>>;
}

/** RunRow 复用导出（测试断言响应行形状时引用）。 */
export type { RunRow };
