/**
 * T12 副会话运行引擎 —— 类型层（docs/02 §T12；决策 docs/01 D5/D15/D19/D23/D26/D31）。
 *
 * 引擎职责边界（一句话）：把一次「副会话开火」编排成 **账本序正确** 的状态机迁移：
 *   queued →(admission)→ admitted →(expected fsync 落盘)→ running → done|partial|failed。
 *
 * 下游任务依赖声明（接口即契约，改动前先看消费方）：
 *   - T13 对账/重试/死信：消费 LedgerPort 落下的 expected/actual 差集（缺口=有 expected
 *     无 actual）；executor 崩溃形状**故意不写 actual**，把缺口留给对账器（见 engine.dispatch）。
 *     重试记 attempt/trigger/parent_run 全在本模块的行形状里。
 *   - T14 回执+验证块：RunLaunchResult.receipt / LedgerPort.actual payload 的
 *     digest/pointers/blockers 即回执原料；verification 预验块由 T14 在此之上补。
 *   - T15 cron 触发：dispatch({trigger:"cron"}) 即调度入口。
 *   - T17 排班暂停开关：AdmissionControl 就是那个钩子点（expected 写盘之前、
 *     状态离开 queued 之前调用；paused 则账本零痕迹）。
 *   - T25 控制面取消/重派：RunEngine.cancel + DispatchInput.parentRun 是接缝。
 *   - T27/T28 API：RunEngine.get/listRuns 返回的记录形状即列表/详情原料。
 *   - T34/T35/T38：崩溃形状与全新会话零残留由本引擎的时序保证支撑。
 *
 * id 形状契约（docs/04 §3.2，前端永久禁连字符）：run_id/session_id 都必须是
 * `^[a-z][a-z0-9_]{2,4}_[0-9a-f]{16}$`；本模块默认生成器与校验都按此执行。
 */

import { randomBytes } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import type { ForceReason, SideReceipt, SideStatus } from "../convergence/index.js";

/* ────────────── 状态机 ────────────── */

/**
 * run 状态机全集（docs/02 §T12 冻结）：
 *   queued    —— dispatch 已受理、尚未过准入；
 *   admitted  —— 准入通过、expected 尚未落盘（瞬间态）；
 *   running   —— expected 已 fsync 落盘、执行器在途；
 *   done / partial / failed —— 终态（与 SideStatus 同词表）。
 * 准入被拒（paused）不产生状态迁移：run 不进账本、不进引擎登记（D31/T17）。
 * 执行器崩溃 = failed + crashed 标记，但**账本无 actual**（缺口形状，T13 输入）。
 */
export const RUN_STATES = ["queued", "admitted", "running", "done", "failed", "partial"] as const;
export type RunState = (typeof RUN_STATES)[number];

/** 终态三态直接复用 T09 副会话收束词表（done/partial/failed），不另造枚举。 */
export type RunTerminalState = SideStatus;

/* ────────────── 触发行 ────────────── */

/**
 * 触发来源（D15/D24，账本记 trigger 字段）：
 *   cron        —— T15 排班；
 *   script      —— T16 挂载脚本 dispatch 事件；
 *   manual      —— 主会话/人工 dispatch（T28）；
 *   catchup     —— T13 对账补跑（新会话）；
 *   rerun       —— T25 控制面重派（新会话）；
 *   auto-resume —— T13 自动续跑（同 run 同会话 resume 语义由 T13 定义，此处仅记 trigger 词）。
 */
export const RUN_TRIGGERS = [
  "cron",
  "script",
  "manual",
  "catchup",
  "rerun",
  "auto-resume",
] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** trigger 判别守卫（parse 用；避免 as 逃逸口）。 */
export function isRunTrigger(x: unknown): x is RunTrigger {
  return RUN_TRIGGERS.some((t): boolean => t === x);
}

/**
 * 账本 expected 行的载荷 = RunRow（snake_case 字段名按计划冻结：
 * run_id / attempt / trigger / parent_run / workflow / session_id）。
 * parent_run 只在派生 run（catchup/rerun/needs_decision 重派）时非 null（D21/D15）。
 */
export interface RunRow {
  readonly run_id: string;
  readonly workflow: string;
  readonly attempt: number;
  readonly trigger: RunTrigger;
  readonly parent_run: string | null;
  readonly session_id: string;
}

/** id 形状校验正则（run_ / ses_ 前缀 + 16 位小写 hex；连字符永久禁用）。 */
export const RUN_ID_SHAPE_RE = /^[a-z][a-z0-9_]{2,4}_[0-9a-f]{16}$/;

/** 默认 id 生成：`run_<hex16>` / `ses_<hex16>`（与 T11 子智能体同形状、不同前缀）。 */
export function defaultRunId(): string {
  return `run_${randomBytes(8).toString("hex")}`;
}

/** 默认 session id 生成（副会话不与子智能体共用前缀：ses_ 前缀在 store 里两者同形，靠 run 登记表区分）。 */
export function defaultSessionId(): string {
  return `ses_${randomBytes(8).toString("hex")}`;
}

/**
 * 边界解析：不可信 DispatchInput → 校验过的 RunRow（照 ledger.ts 的 parseLedgerRow 惯例）。
 * 非法即响亮抛 RunEngineError；引擎内部只消费解析后的行，不再重验。
 */
export function parseDispatchInput(
  input: DispatchInput,
  newRunId: () => string = defaultRunId,
  newSessionId: () => string = defaultSessionId,
): RunRow {
  if (typeof input.workflow !== "string" || input.workflow.trim() === "") {
    throw new RunEngineError(
      "dispatch-input",
      `workflow must be non-blank (got ${JSON.stringify(input.workflow)})`,
    );
  }
  if (typeof input.prompt !== "string" || input.prompt.trim() === "") {
    throw new RunEngineError("dispatch-input", `workflow ${input.workflow}: prompt must be non-blank`);
  }
  if (!isRunTrigger(input.trigger)) {
    throw new RunEngineError(
      "dispatch-input",
      `unknown trigger ${JSON.stringify(input.trigger)}; must be one of ${RUN_TRIGGERS.join("/")}`,
    );
  }
  const attempt = input.attempt ?? 1;
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RunEngineError("dispatch-input", `attempt must be an integer >= 1 (got ${String(input.attempt)})`);
  }
  const runId = input.runId ?? newRunId();
  const sessionId = input.sessionId ?? newSessionId();
  if (!RUN_ID_SHAPE_RE.test(runId)) {
    throw new RunEngineError("dispatch-input", `run_id "${runId}" violates id shape (hyphens permanently banned)`);
  }
  if (!RUN_ID_SHAPE_RE.test(sessionId)) {
    throw new RunEngineError("dispatch-input", `session_id "${sessionId}" violates id shape`);
  }
  const parentRun = input.parentRun ?? null;
  if (parentRun !== null && !RUN_ID_SHAPE_RE.test(parentRun)) {
    throw new RunEngineError("dispatch-input", `parent_run "${parentRun}" violates id shape`);
  }
  if (parentRun === runId) {
    throw new RunEngineError("dispatch-input", `parent_run must differ from run_id (${runId})`);
  }
  return {
    run_id: runId,
    workflow: input.workflow,
    attempt,
    trigger: input.trigger,
    parent_run: parentRun,
    session_id: sessionId,
  };
}

/**
 * 角色引用归一（DispatchInput.agent 的边界解析）：
 * undefined → undefined；非空白串 → 去首尾空白；其余（空白串/非字符串）= 非法抛错。
 */
export function parseAgentRef(x: unknown): string | undefined {
  if (x === undefined) return undefined;
  if (typeof x !== "string") {
    throw new RunEngineError("dispatch-input", `agent must be a string (got ${JSON.stringify(x)})`);
  }
  const trimmed = x.trim();
  if (trimmed === "") {
    throw new RunEngineError("dispatch-input", "agent must be non-blank when declared");
  }
  return trimmed;
}

/* ────────────── 引擎侧记录 ────────────── */

/** 正常终局快照（写进账本 actual 行的同款形状）。crash 不产生此形状。 */
export interface TerminalSnapshot {
  readonly at: number;
  readonly status: RunTerminalState;
  readonly digest: string;
  readonly pointers: readonly string[];
  readonly blockers: readonly string[];
  /** 强制收束原因（D26 分级处置），仅 forceEnded 路径出现。 */
  readonly forceReason?: ForceReason;
  /** T09 原始回执（T14 验证块的原料；可能缺省=非法回执被引擎拒收改判）。 */
  readonly receipt?: SideReceipt;
}

/**
 * 引擎登记的 run 记录（对外只读快照）。
 * crashed=true 表示「执行器抛炸」形状：状态记 failed，但账本**只有 expected**，
 * actual 故意缺席（=缺口，T35 崩溃模拟的断言对象）。
 */
export interface RunRecord {
  readonly row: RunRow;
  readonly state: RunState;
  /** dispatch 受理时刻（epoch ms）。 */
  readonly dispatchedAt: number;
  /** 进终态时刻；未终态 = null。 */
  readonly terminalAt: number | null;
  readonly terminal: TerminalSnapshot | null;
  /** 执行器崩溃/引擎内部错误文本；正常终局 = null。 */
  readonly error: string | null;
  readonly crashed: boolean;
  /** T25 取消请求记录（原因）；未请求 = null。注意：取消生效依赖执行器尊重 signal。 */
  readonly cancelRequested: string | null;
  /**
   * W16-F4 终局实测 usage（执行端口自内核 RunSummary 如实上报；崩溃形无终局数据 = 缺席）。
   * **只进内存登记面**：账本 actual payload（TerminalSnapshot）形状逐字节不动；
   * trace run_end totals 经 onRunTerminal→finishRun 由此取数（对齐会话 terminal usage）。
   */
  readonly usage?: Usage;
}

/* ────────────── 账本端口 ────────────── */

/** 账本终态词表 = T08 Ledger 的 LedgerStatus（含 dead-letter，由 T13 写；本引擎只写三态）。 */
export type LedgerTerminalStatus = "done" | "partial" | "failed" | "dead-letter";

/**
 * LedgerPort —— T08 `packages/adapters/src/state/ledger.ts` 的 Ledger 类的**结构化**端口。
 *
 * 为什么不直接 import Ledger：core→adapters 会形成包级循环（adapters 已依赖 core，
 * `tsc -b` 工程直接拒）。所以这里按 Ledger 的公开签名声明同形接口，
 * **server 装配时把真 `new Ledger(dayPath)` 原样传进来即可满足**（已逐签名核对）；
 * core 测试用本目录 `MemoryLedger`（语义镜像：序校验 + fsync 语义以「同步即落盘」模拟）。
 *
 * 时序铁律（D15）：`expected()` 必须在对该 run 做任何执行动作**之前**同步返回
 * （真实现内部 fsync）；`actual()` 只在 run 进终态时写、且必须先有 expected。
 */
export interface LedgerPort {
  expected(runId: string, at: number, payload?: unknown): void;
  actual(runId: string, at: number, status: LedgerTerminalStatus, payload?: unknown): void;
}

/* ────────────── 执行端口（一次 run = 全新会话） ────────────── */

/** 传给执行端口的运行上下文。row 即账本行；signal 供 T25 取消。 */
export interface RunLaunchContext {
  readonly row: RunRow;
  readonly prompt: string;
  readonly signal: AbortSignal;
  /**
   * 角色文件引用（task yaml `agent:` 字段透传；未声明 = undefined →
   * 副会话走缺省语义：只 AGENTS.md 基础集）。不进账本行——角色声明是装配
   * 事实不是账本事实（state/ 既有账本形状不动）。
   */
  readonly agent?: string;
}

/**
 * 执行端口返回的终局。字段语义：
 *   status    —— 副会话三态（T09 收束词表）；
 *   digest    —— 一行结论（D23）；
 *   pointers  —— **声明产物路径列表**（T14 验证块的预验对象；本引擎原样转交 ArtifactSink）；
 *   blockers  —— 待处置/卡点清单（D21 partial 的异常清单走这里）；
 *   receipt   —— T09 原始 SideReceipt（合法收束路径必有；强制收束可能缺省）；
 *   forceReason —— 分级强制收束原因（D26）。
 * 抛异常（reject/throw）= 进程级崩溃形状：引擎不写 actual，留缺口给 T13。
 */
export interface RunLaunchResult {
  readonly status: RunTerminalState;
  readonly digest: string;
  readonly pointers: readonly string[];
  readonly blockers: readonly string[];
  readonly receipt?: SideReceipt;
  readonly forceReason?: ForceReason;
  /** W16-F4：会话内核 RunSummary.usage 实测终局（additive；执行端口如实上报，缺省=无数据不谎报）。 */
  readonly usage?: Usage;
}

/** 副会话执行端口。真实现 = 本目录 createSideSessionPort（全新 AgentSession + ConvergenceGate）。 */
export interface RunSessionPort {
  run(ctx: RunLaunchContext): Promise<RunLaunchResult>;
}

/* ────────────── 准入钩子（T17 接缝） ────────────── */

/**
 * AdmissionControl —— 账本准入层的钩子点（D31/T17）：
 * 引擎在写 expected **之前**同步调用；`paused` 时 run 不落任何账本痕迹、
 * 不进引擎登记，dispatch 返回 paused 结果。T17 在此读全局/逐工作流开关并
 * **把 paused 记进审计行**（那是 T17 的职责，引擎只负责「拒了就不开火」）。
 */
export type AdmissionDecision =
  | { readonly kind: "admit" }
  | { readonly kind: "paused"; readonly reason: string };

export interface AdmissionControl {
  admit(row: RunRow): AdmissionDecision;
}

/** 默认准入：全放行（T17 接线前的占位实现）。 */
export const admitAll: AdmissionControl = {
  admit: () => ({ kind: "admit" }),
};

/* ────────────── 产物快照 / 死信端口 ────────────── */

/**
 * 产物快照（D5「靠产物协作不靠对话协作」的单向通道）：run **正常到达终态**
 * （含 failed/partial，产物声明也是事实记录）时把回执声明的产物路径列表交给 sink。
 * 崩溃形状（crashed）不发——产物清单不可信，由 T13 对账后重派补。
 */
export interface ArtifactSnapshot {
  readonly run_id: string;
  readonly workflow: string;
  readonly attempt: number;
  readonly session_id: string;
  readonly status: RunTerminalState;
  readonly artifacts: readonly string[];
  readonly at: number;
}

export interface ArtifactSink {
  publish(snapshot: ArtifactSnapshot): void | Promise<void>;
}

/**
 * 死信形状（D26：副会话 failed → 死信投主 + 通知）。
 * 本引擎只负责在 failed 终态**产出并投递形状**；「搬运到主收件箱 + 通知双轨」
 * 是 T13（重试耗尽后）与 server 装配的职责，所以 sink 也是注入端口。
 * 崩溃形状不发死信：缺口先过 T13 重试判定，重试尽才转 dead-letter。
 */
export interface DeadLetterPayload {
  readonly kind: "dead-letter";
  readonly run_id: string;
  readonly workflow: string;
  readonly attempt: number;
  readonly trigger: RunTrigger;
  readonly parent_run: string | null;
  readonly session_id: string;
  readonly digest: string;
  readonly blockers: readonly string[];
  readonly forceReason?: ForceReason;
  readonly at: number;
  /**
   * W9 切片 3（additive）：后台 sub 死信自证身份三键——run 面永不写（旧形状逐字节），
   * 内核 sub 册 failed 时投。观察级判读（死信文件 reader 宽容，docs/07 §4.3）。
   */
  readonly sub_kind?: "sub";
  readonly agent_type?: string;
  readonly parent_session?: string;
}

export interface DeadLetterSink {
  emit(payload: DeadLetterPayload): void | Promise<void>;
}

/* ────────────── dispatch 面 ────────────── */

/** dispatch 输入（边界形状；引擎在此一次性解析校验，内部不再验）。 */
export interface DispatchInput {
  readonly workflow: string;
  readonly prompt: string;
  readonly trigger: RunTrigger;
  /** 重试代数，缺省 1；catchup/rerun/自动续跑由 T13/T25 递增（D15）。 */
  readonly attempt?: number;
  /** 派生源 run；缺省 null。needs_decision 重派同族 run 时传（D21）。 */
  readonly parentRun?: string;
  /** 覆盖自动生成（测试/幂等重放用）。 */
  readonly runId?: string;
  readonly sessionId?: string;
  /**
   * 副会话角色文件引用（task yaml `agent:`；agents/ 下文件名、stem 或相对路径）。
   * parseDispatchInput 归一（去首尾空白；空白串 = 非法抛错）；不进账本行。
   */
  readonly agent?: string;
}

/** dispatch 同步返回：要么「已开火」（含 completion），要么「被准入拒绝」。穷尽判别用。 */
export type DispatchResult =
  | { readonly kind: "launched"; readonly row: RunRow; readonly completion: Promise<RunRecord> }
  | { readonly kind: "paused"; readonly row: RunRow; readonly reason: string };

/* ────────────── 错误 / 日志 ────────────── */

/** 引擎类型化错误（fail-loud；message 带 cause 标签便于审计切片）。 */
export class RunEngineError extends Error {
  readonly cause_kind: "dispatch-input" | "ledger" | "side-session-port" | "sink";
  constructor(causeKind: RunEngineError["cause_kind"], message: string) {
    super(`[run-engine:${causeKind}] ${message}`);
    this.name = "RunEngineError";
    this.cause_kind = causeKind;
  }
}

/** 结构化日志 sink（与内核 logSink 同形；缺省静默，server 装配 pino）。 */
export type RunEngineLog = (
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  fields: Record<string, unknown>,
) => void;
