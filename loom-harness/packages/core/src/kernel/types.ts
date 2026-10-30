/**
 * W9 切片 1 —— SpawnKernel 类型层（统一 spawn 内核的输入/输出形状；纯重构零行为变更）。
 *
 * 一句话职责：把「造一个会跑的 AgentSession」这件事的全部形状收口到一处词表——
 *   - SpawnPolicy：两类派发的判别联合（run = RunEngine 门面产出，sub = task 门面产出）；
 *   - KernelHandle：一次 run 的句柄（身份/状态/终态 completion/cancel）；
 *   - KernelRunRecord：**从 engine 的 RunRecord 平移**（同一类型引用，字段零漂移；
 *     定义仍留在 run-engine/types.ts——账本/对账/task-api 全链压在这名上，动定义=行为面，
 *     本切片只做别名收口）；
 *   - TerminalProfile：**gate 组合差异，不是内核分支**——converge-receipt（副会话：挂
 *     ConvergenceGate 并以回执判终局）与 raw-summary（task 子会话：vendored 管线直取
 *     RunSummary）是两条各自独立的构造/整形路径，kernel 内部没有 profile 判别分支。
 *
 * 形状决策（policy 携带 row 而非扁平字段）：任务冻结的 run 字段
 * {workflow,prompt,trigger,attempt,parentRun,agent} 全部已在 RunRow（snake_case 账本行，
 * 冻结不许改形）或 policy 附加位上；run_id/session_id 走 row 是因为
 * DispatchInput.runId/sessionId 覆盖面（测试/幂等重放在用）必须先经 parseDispatchInput
 * 校验再入内核——policy 扁平化会迫使内核重造 id 校验/生成，属行为面漂移，禁止。
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ConvergenceGate, Limits, NudgeObservation } from "../convergence/index.js";
import type { Hook } from "../hook.js";
import type { HarnessTool } from "../types.js";
import type { LlmOptions } from "../llm-model.js";
import type { AgentSession } from "../session.js";
import type { WireRequestSnapshot } from "../wire-capture.js";
import type { SessionStore } from "../session-store.js";
import type { SessionContextWatcher } from "../assembly/session-context.js";
import type { RunLaunchResult, RunRecord, RunRow } from "../run-engine/types.js";

/** 终局整形词表（gate 组合差异；见模块头，非内核分支）。 */
export type TerminalProfile = "converge-receipt" | "raw-summary";

/** run 派发输入：parseDispatchInput 已验的账本行 + 执行侧两附加（prompt 原样、agent 归一后）。 */
export interface SpawnRunPolicy {
  readonly kind: "run";
  readonly row: RunRow;
  readonly prompt: string;
  readonly agent?: string;
}

/**
 * sub 派发输入：task 门面的路由四元组（agentType/task/parentSessionId/depth）。
 * 本切片内核只按 vocabulary 收口（构造入参由调用方经 SubSessionProfile 显式给全，
 * 深度/信号链/metadata 行为不动，仍走 vendored 管线）；四字段为切片 2 全局在飞
 * 记账预备的观察面——**切片 1 不消费即不新增行为**。
 */
export interface SpawnSubPolicy {
  readonly kind: "sub";
  readonly agentType: string;
  readonly task: string;
  readonly parentSessionId: string;
  readonly depth: number;
}

/** 判别联合（内核唯一入口词表）。 */
export type SpawnPolicy = SpawnRunPolicy | SpawnSubPolicy;

/* ────────────── W9 切片 3：后台 sub 账本面（durable，/tasks 原料） ────────────── */

/**
 * 后台 sub 账本记录 = RunRecord 全字段 + sub 身份。
 * **分册决策**（与 _runs 两立）：RunRecord 读面（toRunView/detailOf/golden）冻结不许混入
 * sub 形状——engine.get/listRuns 保持纯 run 语义，/runs 契约逐字节不变；
 * sub 账本走内核独立册 + /tasks 专属视图（task_id/agent_type/parent_session 附加）。
 * kind 判别键让 views 读侧能把 sub 账本行从 /runs/:id 的账本回退面排除（契约纯度）。
 */
export interface SubTaskRecord extends RunRecord {
  readonly kind: "sub";
  /** 任务号 = 账本 run_id（run_ 形状；/tasks、trace、提醒、task_fetch 三面同一 join 键）。 */
  readonly taskId: string;
  readonly agentType: string;
  /** 派发方会话 id（主/副/子皆然；提醒目标）。 */
  readonly parentSessionId: string;
  /** 任务正文（详情面原料；提醒行不带正文=W12 纪律延续）。 */
  readonly task: string;
  readonly depth: number;
  /**
   * W49.2 人读标题（派发显式或 derived，task-tool 一次算定）。
   * **可选**：直接走内核口的旧调用（不带 title）= 键缺席，视图面 ?? null 投影不造假。
   */
  readonly title?: string;
}

/**
 * 后台派发输入（task 门面组好后交内核）：row 由门面造（workflow=`subagent.<agentType>`，
 * run_id=defaultRunId 形状、session_id=已构建子会话 id）；执行闭包=门面整形
 * （预构建 session 的 run → raw-summary 词表 → RunLaunchResult 形状）。
 * 内核负责：登记（sub 册）→ expected（payload 携 kind:"sub" 判别，RunRow 既有六键不动，
 * W49.2 title 给了才落键，reader 宽容）→ running → 执行（自备 AbortController，**不吃父 turn abort**=D24 重定义）→
 * actual/crash 缺口 → 终态观察者（onTerminalLocal：fireEnd/retain/出池/提醒经统一 onRunTerminal 缝）。
 */
export interface SpawnSubBackgroundArgs {
  readonly row: RunRow;
  readonly agentType: string;
  readonly task: string;
  readonly parentSessionId: string;
  readonly depth: number;
  /** W49.2 生效标题（task 门面恒给；直连内核口的旧调用可缺=账本 payload 键整体缺席）。 */
  readonly title?: string;
  /** 执行闭包（signal=内核自备 aborter；resolve=子 run 终态，reject=崩溃形状）。 */
  readonly run: (signal: AbortSignal) => Promise<RunLaunchResult>;
  /** 强制 deadline（内核定时器到点 cancel(reason:"deadline")=既有 failed+cancelRequested 形状；缺省=不设）。 */
  readonly deadlineMs?: number;
  /** 终态本地观察（派发门面接线：fireSubagentEnd/onSubagentEnd 回调、registry retain、出池；同步执行于盖棺后）。 */
  readonly onTerminalLocal?: (record: SubTaskRecord, result: RunLaunchResult | null) => void;
}

/** 后台派发产物：即返句柄（toolResult 靠它组状态块；completion 供观察，不阻塞门面）。 */
export interface SubBackgroundHandle {
  readonly taskId: string;
  readonly sessionId: string;
  readonly completion: Promise<SubTaskRecord>;
  cancel(reason?: string): boolean;
}

/**
 * task 门面所需的内核窄接口（结构面；SpawnKernel 实现）。
 * 缺省不注入 = background 参数被拒（旧调用面逐字节不变）。
 */
export interface SubBackgroundPort {
  /** 后台在飞册中非终态计数（maxInflightTotal 闸现读源）。 */
  subActiveCount(): number;
  dispatchSubBackground(args: SpawnSubBackgroundArgs): SubBackgroundHandle;
  getSub(taskId: string): SubTaskRecord | undefined;
}

/** /tasks 视图数据源（task-api 注入面；ServeKernel 适配器满足）。 */
export interface TaskSurface {
  list(): readonly SubTaskRecord[];
  get(taskId: string): SubTaskRecord | undefined;
  cancel(taskId: string, reason?: string): boolean;
}

/** task_fetch 的 run_ 寻址解析面（serve 注入；解析=taskId→sid+状态）。 */
export interface TaskIndexPort {
  resolve(taskId: string): { readonly sessionId: string; readonly status: string } | undefined;
}

/**
 * W9 切片 2：子会话在飞账的窄接口（SpawnKernel 的 sub 册对外形状；
 * task 门面经装配方注入的适配器委托，计数=构建入册→run 终态观测点出册）。
 * 独立于 _runs 账本面（RunRecord 形状冻结、sub 无账本行——混 map 会污染
 * listRuns/gaps 语义，分册是最小正解，见 kernel.ts 注释）。
 */
export interface SubFanout {
  /** 当前在飞数（检查时刻现读，热载闸语义的计数源）。 */
  count(): number;
  /** 构建即入册；重复 id = 响亮抛（sid 逐派发全新，理论不可达，撞了就是 bug）。 */
  register(id: string): void;
  /** 出册（幂等：未知/已出册返回 false）；返回是否真实移除。 */
  release(id: string): boolean;
}

/** policy → 终局整形词表（纯映射；测试/文档用，内核实现不读它）。 */
export function terminalProfileOf(policy: SpawnPolicy): TerminalProfile {
  return policy.kind === "run" ? "converge-receipt" : "raw-summary";
}

/** run 登记表记录（= engine RunRecord 平移别名，字段一字不动）。 */
export type KernelRunRecord = RunRecord;

/**
 * 一次 run 的进程句柄：身份对（run_id/账本 session_id）、实时状态快照、
 * **恒 resolve** 的终态 completion（crash 也是数据不是异常——engine.ts:244-275 语义照搬）、
 * cancel（engine.ts:173-183 语义照搬：state=running 才命中，记原因 + abort signal）。
 */
export interface KernelHandle {
  readonly id: string;
  readonly sessionId: string;
  status(): KernelRunRecord | undefined;
  readonly completion: Promise<KernelRunRecord>;
  cancel(reason?: string): boolean;
}

/**
 * run 派发结果（穷尽判别）：launched = 已开火（expected 已 fsync，handle.completion 在途）；
 * paused = 准入挡下（账本零痕迹、内核未登记——D31/T17 语义，engine.ts:143-149 照搬）。
 */
export type KernelSpawnResult =
  | { readonly kind: "launched"; readonly row: RunRow; readonly handle: KernelHandle }
  | { readonly kind: "paused"; readonly row: RunRow; readonly reason: string };

/* ────────────── 唯一 AgentSession 工厂的输入形状（构造段逐字节平移自现网两处） ────────────── */

/**
 * converge-receipt 构造入参（side-session-port.ts:109-123 平移）：
 * gate 三件（kind:"side" 恒 + limits/onNudge 条件挂）+ session 六件（tools 首位恒为
 * gate.tool；systemPrompt/llmOptions/store 条件展开，undefined 即不给——与现网一致）。
 */
export interface ConvergeSessionProfile {
  readonly model: Model<Api>;
  readonly sessionId: string;
  readonly tools: readonly HarnessTool[];
  readonly hooks: readonly Hook[];
  readonly limits?: Limits | undefined;
  readonly onNudge?: ((ev: NudgeObservation) => void) | undefined;
  readonly llmOptions?: LlmOptions | undefined;
  readonly store?: SessionStore | undefined;
  readonly systemPrompt?: string | undefined;
  /** 每会话上下文侦听器（条件展开；undefined = 键缺席 = 内核旧行为）。 */
  readonly contextWatcher?: SessionContextWatcher | undefined;
  /** 每 turn 上下文检查开关（条件展开；缺省由内核按 watcher 存在性推导）。 */
  readonly contextCheckEachTurn?: boolean | undefined;
  /** W23-A 发线面持久回调（条件展开，同 llmOptions 纪律；server 装配逐 run 包 sid 注入）。 */
  readonly onWireSnapshot?:
    | ((snapshot: WireRequestSnapshot, providerPayload: string | null) => void)
    | undefined;
}

/** converge-receipt 构造产物：gate（终局判读面）+ session（执行面）。 */
export interface ConvergeSessionBundle {
  readonly gate: ConvergenceGate;
  readonly session: AgentSession;
}

/**
 * raw-summary 构造入参（tool-wiring.ts childSessionFactory / task-tool.ts
 * buildDefaultChild 构造语义平移）：无 gate、终局由调用方/vendored 管线整形；
 * hooks/maxTurns/llmOptions/store 均条件展开（undefined = 键缺席，与现网两工厂一致）。
 */
export interface SubSessionProfile {
  readonly model: Model<Api>;
  readonly sessionId: string;
  readonly systemPrompt: string;
  // 可变数组：session.tools 直传引用（旧两工厂同为直传，不做二次拷贝——引用语义即行为）。
  readonly tools: HarnessTool[];
  readonly hooks?: readonly Hook[] | undefined;
  readonly llmOptions?: LlmOptions | undefined;
  readonly store?: SessionStore | undefined;
  readonly maxTurns?: number | undefined;
  /** 每会话上下文侦听器（条件展开；undefined = 键缺席 = 旧工厂行为）。 */
  readonly contextWatcher?: SessionContextWatcher | undefined;
  /** 每 turn 上下文检查开关（条件展开；缺省由内核按 watcher 存在性推导）。 */
  readonly contextCheckEachTurn?: boolean | undefined;
  /** W23-A 发线面持久回调（serve childSessionFactory 注入；条件展开同 llmOptions 纪律）。 */
  readonly onWireSnapshot?:
    | ((snapshot: WireRequestSnapshot, providerPayload: string | null) => void)
    | undefined;
}
