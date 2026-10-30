/**
 * T25 控制面 cancel/rerun + actor 审计 —— 类型契约层
 * （docs/02 §T25；决策 docs/01 D5/D15/D19/D22/D25）。
 *
 * 一句话职责：主会话/HTTP/脚本（=控制面，非上下文信道）对在途 run 发出 **取消/重派**
 * 指令，并对每次控制动作留下带 `actor` 的审计行；同时提供 D22 防环谓词
 * （副会话禁止派生副会话，副会话内仍可用子智能体工具）。
 *
 * 与 run-engine 的分工（只 import run-engine 现有导出，**不改其文件**）：
 *   - 取消：转发到 `RunEngine.cancel(runId, reason)` —— 引擎把 AbortSignal 交给在途
 *     执行端口的句柄（signal 契约见 run-engine/types.ts §RunLaunchContext）；
 *   - 重派：调 `RunEngine.dispatch` 开一条**新 run 新会话**，行内 parent_run=源 run、
 *     attempt=源 attempt+1、trigger 默认 `manual`（人工重跑语义，D15）；
 *   - 引擎只认「账本 expected/actual 两型行」，控制动作**绝不能**混入 run 账本
 *     （否则伪造 T13 对账缺口）。故控制审计走独立 `ControlAuditSink` 通道，
 *     与 T17 暂停审计（pause/pause.ts §PauseAuditSink）同一惯例：控制即账，另立一账。
 */

import type { DispatchResult, RunTrigger } from "../run-engine/index.js";

/* ────────────── actor 词表（控制动作发起方） ────────────── */

/**
 * 控制动作发起方（actor）：
 *   main   —— 主会话（D5，唯一与用户交互的长生命周期体）；
 *   http   —— 控制面 HTTP API（T27/T28）；
 *   script —— 挂载脚本 dispatch 事件（D17/D18）；
 *   side   —— 副会话（D19；**不得**派生副会话，见下方防环谓词）。
 */
export const CONTROL_ACTORS = ["main", "http", "script", "side"] as const;
export type ControlActor = (typeof CONTROL_ACTORS)[number];

/** actor 判别守卫（边界解析用；避免 as 逃逸口）。 */
export function isControlActor(x: unknown): x is ControlActor {
  return typeof x === "string" && CONTROL_ACTORS.some((a): boolean => a === x);
}

/* ────────────── D22 防环谓词 ────────────── */

/**
 * D22 防环谓词：该 actor 是否允许派生副会话。
 * 副会话（side）**禁止**派生副会话；其余控制面身份允许。
 * 注意语义边界：副会话内仍可用**子智能体工具**（subagent，另一条通道），
 * 本谓词只拦「副会话 → 副会话」的纵向自派生。
 */
export function canSpawnSide(spawner: ControlActor): boolean {
  return spawner !== "side";
}

/** 谓词的 fail-loud 形态：拒绝时抛类型化错误（调用方无需求值布尔）。 */
export function assertCanSpawnSide(spawner: ControlActor): void {
  if (!canSpawnSide(spawner)) {
    throw new ControlPlaneError(
      "side-to-side-forbidden",
      `actor "side" is forbidden from spawning a side-session (D22 anti-loop)`,
    );
  }
}

/* ────────────── 控制审计通道 ────────────── */

/** 控制动作词表（审计行的 action 字段）。 */
export const CONTROL_ACTIONS = ["cancel", "rerun", "spawn"] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

/**
 * 一条控制审计行。snake_case 字段与账本行同风格（docs/04）；
 * `actor` 是 T25 的核心落账字段（谁下的指令）；`accepted` 记命中/被拒；
 * `reason` 记取消原因或拒绝原因；`at` 为发生时刻（epoch ms）。
 * 控制行**不占** run 账本的 expected/actual 两型，走独立审计流。
 */
export interface ControlAuditEntry {
  readonly kind: "control";
  readonly action: ControlAction;
  readonly actor: ControlActor;
  /** 指令是否被接受（cancel 命中在途 / rerun·spawn 成功开火；被拒 = false）。 */
  readonly accepted: boolean;
  /** 目标 run（cancel/rerun 为源 run；spawn 为新 run 时填其 id，拒绝时 null）。 */
  readonly run_id: string | null;
  /** 派生源 run（仅 rerun 非 null；其余 null）。 */
  readonly parent_run: string | null;
  /** 重派代数（仅 rerun 非 null；spawn/cancel 为 null）。 */
  readonly attempt: number | null;
  /** 实际使用的 trigger（仅开火类动作非 null）。 */
  readonly trigger: RunTrigger | null;
  /** 取消原因 / 拒绝原因；无 = null。 */
  readonly reason: string | null;
  readonly at: number;
}

/**
 * 控制审计出口（注入端口，core 不 import adapters）。
 * server 装配接当日 jsonl 审计流（D14 审计归属 + T17 暂停审计同通道惯例）；
 * core 测试用下方 MemoryControlAudit。
 */
export interface ControlAuditSink {
  audit(entry: ControlAuditEntry): void;
}

/** 内存审计假件：语义 = 同步收下即记账（server 接线前的占位 + 测试观察对象）。 */
export class MemoryControlAudit implements ControlAuditSink {
  private readonly _entries: ControlAuditEntry[] = [];

  /** 全部审计行（按写入序）。测试据此断「actor 落账」「拒绝也留痕」。 */
  get entries(): readonly ControlAuditEntry[] {
    return this._entries;
  }

  audit(entry: ControlAuditEntry): void {
    this._entries.push(entry);
  }
}

/* ────────────── 指令形状 ────────────── */

/** cancel 指令：目标 run + 发起方 + 可选原因。 */
export interface CancelRequest {
  readonly runId: string;
  readonly actor: ControlActor;
  readonly reason?: string;
}

/** rerun 指令：源 run + 新会话 prompt + 发起方；trigger 缺省 manual（人工重跑，D15）。 */
export interface RerunRequest {
  readonly parentRunId: string;
  readonly prompt: string;
  readonly actor: ControlActor;
  /** 缺省 `manual`（任务验收冻结：rerun 新行 trigger=manual）。 */
  readonly trigger?: RunTrigger;
  /** 覆盖自动生成（测试/幂等重放用），透传 dispatch。 */
  readonly runId?: string;
  readonly sessionId?: string;
  /** 角色引用（装配事实，账本不记）：重跑沿用角色需调用方重新声明。 */
  readonly agent?: string;
}

/** spawnSide 指令：经 D22 防环谓词的副会话派发入口。 */
export interface SpawnSideRequest {
  readonly workflow: string;
  readonly prompt: string;
  readonly actor: ControlActor;
  readonly trigger?: RunTrigger;
  readonly runId?: string;
  readonly sessionId?: string;
  /** 副会话角色文件引用（task `agent:` 同义），透传 dispatch。 */
  readonly agent?: string;
}

/** cancel 结果：命中与否 + actor + 时刻（cancel 无新 run 行，故返回轻量回执）。 */
export interface CancelOutcome {
  readonly run_id: string;
  readonly actor: ControlActor;
  /** true = 命中在途 run 且已转发 abort；false = 未命中（终态/未知/无句柄）。 */
  readonly accepted: boolean;
  readonly reason: string;
  readonly at: number;
}

/** 开火类动作结果 = dispatch 结果（launched 含新行；paused 为准入拒绝）。 */
export type ControlLaunchOutcome = DispatchResult;

/* ────────────── 错误 ────────────── */

/** 控制面类型化错误（fail-loud；message 带 cause 标签便于审计切片）。 */
export class ControlPlaneError extends Error {
  readonly cause_kind: "input" | "unknown-run" | "side-to-side-forbidden";
  constructor(causeKind: ControlPlaneError["cause_kind"], message: string) {
    super(`[control-plane:${causeKind}] ${message}`);
    this.name = "ControlPlaneError";
    this.cause_kind = causeKind;
  }
}
