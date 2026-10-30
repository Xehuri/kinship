/**
 * T10 主会话长循环 —— 类型契约（docs/01 D5/D23/D25/D26/D30/D31，docs/02 §T10）。
 *
 * 主会话 = 唯一与用户交互的长生命周期体（D5）。本模块把三块已冻结的能力接成"长循环"：
 *   - session.ts 内核（AgentSession：abort / steer / resume / HWM 持久化，只读复用）；
 *   - convergence/（T09 ConvergenceGate：回合终止的唯一合法通道是收束工具成功调用，D25/D30）；
 *   - assembly/（T18 装配器：turn 边界重装配，稳定前缀 + 增量尾，D6/D20）。
 *
 * 协作纪律（D23）：外部投递（副会话回执 / 死信等）经 `deliver` 入队，**只在 turn 边界
 * 消费**——绝不插进进行中的用户回合。
 *
 * 终止分级（D26）：跨请求自动续跑预算 = Limits.autoContinuations（默认 2）；超限主会话
 * **自动收束"需用户确认"**，如实说明卡点，绝不静默假完成。
 */

import type { ConvergenceOutcome, ForceReason, MainReceipt, Receipt } from "../convergence/receipt.js";
import type { Limits } from "../convergence/limits.js";
import type { Hook, LogLevel } from "../hook.js";
import type { CompactionCheckpointPayload } from "../compaction-checkpoint.js";
import type { HarnessTool } from "../types.js";
import type { LlmOptions } from "../llm-model.js";
import type { WireRequestSnapshot } from "../wire-capture.js";
import type { RunSummary, SystemPromptRefreshReason } from "../session.js";
import type { SessionCompactionOptions } from "../compaction/session-compaction.js";
import type { SessionStore } from "../session-store.js";
import type { FlowRunOutcome } from "../flow/gate.js";
import type { FlowStore } from "../flow/store.js";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { Assembly, AssemblyPlan, AssemblyReader, ContextBaseline, SessionContextWatcher } from "../assembly/index.js";

/**
 * 装配 plan 热重载结果：plan 与可选上下文基线。
 * plan null = 不换 plan（但仍可 rebase baseline）；contextBaseline 缺省 = 不 rebase。
 */
export interface AssemblyPlanRefreshResult {
  readonly plan: AssemblyPlan | null;
  readonly contextBaseline?: ContextBaseline | undefined;
}

/** 主会话长循环的构造参数（全部只读复用既有类型，零新增 schema）。 */
export interface MainSessionLoopOptions {
  readonly model: Model<Api>;
  /** 干活工具。收束工具（gate.tool）自动前置，调用方不要重复传。 */
  readonly tools?: readonly HarnessTool[];
  readonly systemPrompt?: string;
  /**
   * 收束阈值对象（D26，热载可改：注入可变引用，gate 事件时刻现读）。
   * 缺省 = DEFAULT_LIMITS 的可变克隆（nudgeLimit 5 / escalateSameError 3 /
   * turnHardCap 60 / autoContinuations 2）。
   */
  readonly limits?: Limits;
  /**
   * W26 主会话收束**强制**开关（用户决策 2026-10-10 10:19："主会话增加 converge 开关，
   * 可以选择关闭这个强制要求，但仅限主会话"）。
   *
   * - true / 缺省 = 现状逐字节：gate 强制（催办链、分级强制收束、盖棺终止通道、
   *   W16-F3 终态改标）全部在位——本开关只关"强制"，不改机器本身。
   * - false = 模型自然收尾即终局：**强制执行面**整体缺席（零催办、零分级强制、
   *   零跨请求自动续跑、零 turnHardCap 盖棺），但 W47 起挂 gate 的**终审子集**
   *   （onSessionStart 复位 + onTurnEnd 受理判别）：模型自愿 converge 一旦被受理
   *   即真实终结本轮，终局归类 converged（与 text-only 自然停的 naturalStop 可区分）。
   *   converge 工具**仍在工具面**（模型自愿调用照常走 execute 校验与回执通道）；
   *   系统不再"催"也不再"杀"，只兑现"收束已受理"这一句承诺。
   *   遗留风险（W47 申报，未设生产兜底值）：本模式下模型**永不**自愿 converge 时，
   *   主会话单 run 的唯一封顶 = 内核缺省 DEFAULT_MAX_TURNS 200（本文件 maxTurns 键
   *   缺席时生效；配置 turnHardCap 不参与——它属强制执行面，此处如实死配置）。
   *
   * 为什么旁路在 loop 接线层而不是 gate 内部：强制机器（machine reducer / turnEndGuard
   * 投递引擎）的任何一行逻辑都不该被本开关改写——摘掉 hook 挂载即摘掉全部执行力，
   * gate 对象本体（tool/账本形状）保持在场、保持可观测。
   * 纪律：**仅限主会话**。side 会话（run-engine/side-session-port）与子会话
   * （kernel buildConvergeSession）各自建 gate 并挂 hooks，绝不读取本项，纪律不松。
   */
  readonly convergenceEnforced?: boolean;
  /**
   * L4 flow 接线：给了 store 即在本主会话预置 `flow_commit` 工具并挂 FlowGate
   * （工具/hook 均只进主会话面，side/子会话不读本项）。terminal 提交
   * （waiting_user / waiting_event / closed）让本次 start() 以 `flowEnded` 收尾；
   * active 提交或未提交保持既有终止行为。缺省 = 无 flow 面，逐字节旧行为。
   */
  readonly flow?: { readonly store: FlowStore };
  /**
   * L8 分阶段开关：`"disabled"` = 本主会话不挂 converge 工具与 converge 钩子，
   * 由 flow 接管终止；没有 flow 终态时按内核自然停收尾、不合成强制收束回执。
   * 缺省/`"enabled"` = 现状逐字节。side/子会话绝不读本项（各自 converge 不变）。
   */
  readonly converge?: "enabled" | "disabled";
  /**
   * 主会话自动唤醒开关：缺席/undefined = 启用；显式 false 关闭 server.autoWakeEnabled
   * （converge 无 wake 键、带 wake 回执被拒）。重启生效；side/子会话绝不读本项。
   */
  readonly autoWakeEnabled?: boolean;
  /** 可注入时钟（确定性测试）；缺席 = Date.now。仅用于 wake 解析。 */
  readonly now?: () => number;
  /** 会话存储（HWM 持久化 + resume 的前提；主会话生产配置必须给）。 */
  readonly store?: SessionStore;
  /** 固定 sessionId（abort→resume 同一 lineage 依赖它）。 */
  readonly sessionId?: string;
  /**
   * 内核单请求轮数上限（缺省 200；强制在位时 gate 的 turnHardCap 先行盖棺）。
   * W47 申报：自然停（convergenceEnforced:false）不挂任何封顶链——本键缺席时
   * 内核缺省 200 是该模式主会话 run 的唯一轮数上限（turnHardCap 死配置）。
   */
  readonly maxTurns?: number;
  /**
   * W42a 透传 AgentSessionOptions.llmErrorRetries（瞬时 provider 错误的带退避重试上限：
   * error/异常-aborted 终态放弃前对同一 LLM call 重发，缺省 2、0=禁用、重试不耗回合数）。
   * 键缺席=不注入内核、走 core 缺省（undefined-honest）；配置键接线归 server 侧。
   */
  readonly llmErrorRetries?: number;
  /**
   * T4：透传 AgentSessionOptions.llmErrorRetryBackoffMs（重试退避基数毫秒，退避 = base×2ⁿ）。
   * 键缺席 = 不注入内核、走 core 缺省 1000（undefined-honest）；配置键接线归 server 侧。
   */
  readonly llmErrorRetryBackoffMs?: number;
  readonly llmOptions?: LlmOptions;
  /**
   * W57 P2c-2：会话级压缩接线（透传 AgentSessionOptions.compaction）。键缺席 = 旧行为；
   * server 生产装配尚不构造本项（stateRoot/summarize 由后续波次接线）。
   */
  readonly compaction?: SessionCompactionOptions;
  /**
   * 额外观测 hook（trace / metrics 等），排在 gate/boundary 钩子之后。
   * Plan B：onAfterFlush 可返回 `CompactionCheckpointPayload`；legacy `Hook<Message>`
   * 数组仍可直接赋值（协变，窄类型进宽类型）。
   */
  readonly extraHooks?: readonly Hook<Message | CompactionCheckpointPayload>[];
  /**
   * T18 装配接线：给定后每个 turn 边界重装配一次（稳定前缀 + 增量尾），
   * 产物记入 loop.assemblies()。reader 为注入接口（core 不 import adapters）。
   */
  readonly assembly?: MainAssemblyOptions;
  /**
   * 装配 plan 热重载 provider（需同时给 `assembly`）：session-start / compaction 时调用。
   * 返回 null = plan 不变；返回新 plan = 更新 turn 边界 plan 并重渲染 systemPrompt。
   * 渲染字节与当前 prompt 相同则视为不变（不换 plan、cache 前缀稳定）。
   * 返回对象时可附带 contextBaseline：plan 不变/字节相同也照样 rebase 会话水位。
   */
  readonly refreshAssemblyPlan?: (
    reason: SystemPromptRefreshReason,
  ) =>
    | Promise<AssemblyPlan | AssemblyPlanRefreshResult | null>
    | AssemblyPlan
    | AssemblyPlanRefreshResult
    | null;
  /**
   * 每会话上下文侦听器（透传 AgentSessionOptions.contextWatcher）。
   * 键缺席 = 不注入、内核完全旧行为。
   */
  readonly contextWatcher?: SessionContextWatcher;
  /**
   * 每 turn 上下文检查开关（透传 AgentSessionOptions.contextCheckEachTurn）。
   * 键缺席 = 内核缺省（watcher 在场即 true）；主会话装配显式 false。
   */
  readonly contextCheckEachTurn?: boolean;
  readonly logSink?: (level: LogLevel, msg: string, fields: Record<string, unknown>) => void;
  readonly consoleSink?: (msg: string, ctx: { sessionId: string; turnIdx: number }) => void;
  /**
   * W12 提醒注入回报（turn 边界 drain 时刻现报）：server 侧在此 publish
   * delivery.notify（"随注入"发帧，非终态时刻）。回调异常由 loop 吞断，绝不反噬回合。
   */
  readonly onRemindersDrained?: (turnIdx: number, texts: readonly string[]) => void;
  /**
   * W23-A 发线面持久回调（透传 AgentSessionOptions.onWireSnapshot）：每次 LLM call
   * 解析完成后恰好一次（A1 槽已设 + A2 载荷落位；fake 通道 providerPayload 如实 null）。
   * 主/副/子会话共用同一选项形状；server 装配逐会话包 sid 后落 wire/{sid}.json。
   */
  readonly onWireSnapshot?: (
    snapshot: WireRequestSnapshot,
    providerPayload: string | null,
  ) => void;
}

/** 装配接线参数（对齐 assembly/types.ts 的 AssemblyPlan + AssemblyReader）。 */
export interface MainAssemblyOptions {
  readonly plan: AssemblyPlan;
  /** null = 无历史源（装配仍产出占位增量）。 */
  readonly reader: AssemblyReader | null;
}

/**
 * 强制收束的原因：gate 的分级强制（催办上限 / 轮数硬顶）之外，
 * 主循环还多一档"跨请求自动续跑预算用尽"（D26 超限分级处置）。
 */
export type ForceEndCause = ForceReason | "auto-continuations-exhausted";

/**
 * 一次 start() 的结构化终态（判别联合，消费方 exhaustive switch）。
 *
 * - converged   ：模型经 converge 工具合法收束（唯一"真完成"通道，D25/D30）。
 *                 强制路（gate 盖棺）与自然停路（W47 终审子集兑现受理）同一形状，
 *                 回执出自 gate 账本 terminal，两路判据同源（isConvergedTermination）。
 * - forceEnded  ：强制收束——gate 分级强制或自动续跑预算用尽；主会话恒等于
 *                 自动收束"需用户确认"，**绝不静默假完成**（receipt 如实）。
 * - aborted     ：用户/外部 abort（store 已按 HWM 落盘，可直接 resume 续跑）。
 * - error       ：LLM/内核错误终态。
 * - naturalStop ：W26 `convergenceEnforced:false` 专属终局——模型自然收尾（内核
 *                 reason 如实：done / max_turns / max_continuations）即终局，
 *                 无收束回执可报（故**不并入** converged/forceEnded，两者形状强制
 *                 要求 receipt，伪造即谎报）。summary 携带内核真实 reason。
 *
 * runs = 本次 start() 内实际执行的 run 数（1 + 自动续跑次数）；
 * autoContinuationsUsed = 本次用掉的跨请求自动续跑次数（D26 默认预算 2）。
 */
export type MainLoopResult =
  | {
      type: "converged";
      receipt: Receipt;
      summary: RunSummary;
      runs: number;
      autoContinuationsUsed: number;
    }
  | {
      type: "forceEnded";
      cause: ForceEndCause;
      receipt: Receipt;
      deadLetter: boolean;
      summary: RunSummary;
      runs: number;
      autoContinuationsUsed: number;
    }
  | {
      type: "aborted";
      summary: RunSummary;
      runs: number;
      autoContinuationsUsed: number;
    }
  | {
      type: "error";
      summary: RunSummary;
      runs: number;
      autoContinuationsUsed: number;
    }
  | {
      /** W26 免强制终局（仅 convergenceEnforced:false 时出现；语义见联合头部注释）。 */
      type: "naturalStop";
      summary: RunSummary;
      runs: 1;
      autoContinuationsUsed: 0;
    }
  | {
      /**
       * L4 flow 终局：本 run 受理了 terminal flow 提交（waiting_user / waiting_event /
       * closed）。`flow` 即 FlowGate 的终态视图（subject/state/next_decision_at）；
       * 落盘 terminal 仅在 closed 时改标 "done"（waiting_* 如实保持 aborted）。
       * flow 未接线或本 run 无 terminal 提交时绝不出现本变体。
       */
      type: "flowEnded";
      flow: FlowRunOutcome;
      summary: RunSummary;
      runs: number;
      autoContinuationsUsed: number;
    };

/**
 * 账本事件的处置分类（Outcome 消费的记账结果）。
 *
 * 语义映射（D25/D26）：
 * - round-continued     ：continued → 放行下一轮（内核已在跑）。
 * - nudge-injected      ：nudged → 催办**已持久注入**会话（gate 的 persist / turnEndGuard 通道）。
 * - escalation-recorded ：escalated → 升级提示如实记账（不终止会话）。
 * - terminal-converged / terminal-forced：终态记录（forceEnded = 主会话自动收束"需用户确认"）。
 */
export type OutcomeDisposition =
  | "terminal-converged"
  | "terminal-forced"
  | "nudge-injected"
  | "escalation-recorded"
  | "round-continued";

/**
 * 循环可观测事件流（T21/T27 消费；只追加）。
 *
 * - outcome          ：gate 账本里每条 ConvergenceOutcome 的消费记录（含处置分类）。
 * - delivery-drained ：deliver 收件箱消息在 turn 边界被 drain（D23）。
 * - reminder-drained ：W12 提醒队列在 turn 边界被 drain（transient 注入，texts 按入队序；
 *                      不进转录，trace/事件面由 server 侧消费本记录发 delivery.notify）。
 * - assembly         ：turn 边界的 T18 重装配产物。
 * - loop-forced      ：循环级自动收束（自动续跑预算用尽，非 gate 分级强制）。
 */
export type LoopEvent =
  | { type: "outcome"; outcome: ConvergenceOutcome; disposition: OutcomeDisposition }
  | { type: "delivery-drained"; turnIdx: number; count: number }
  | { type: "reminder-drained"; turnIdx: number; count: number; texts: readonly string[] }
  | { type: "assembly"; turnIdx: number; assembly: Assembly }
  | { type: "loop-forced"; receipt: MainReceipt };
