/**
 * MainSessionLoop（T10）—— 主会话长循环接线层（docs/01 D5/D23/D25/D26/D30/D31）。
 *
 * 组合三块既有能力，零内核改动：
 *   - session.ts 的 AgentSession：turn loop / abort / steer / HWM 持久化 / `resume`。
 *     孤儿 toolCall 尾巴的修复是 vendor 既有能力（`AgentSession.resume` 给未配对 toolCall
 *     合成 isError toolResult 并即时落盘；快照侧剔除悬挂用 vendor `filterIncompleteToolCalls`），
 *     本层一律复用、不重新实现。
 *   - convergence/ 的 ConvergenceGate（T09，kind="main"）：回合终止走它，converge 成功调用
 *     是唯一合法终止通道。内核 `maxContinuations` 取 `max(gate.minKernelBudget(), 5)`——
 *     催办要能在内核续跑预算掐死前全部投递（T09 冻结的接线契约）。
 *     W26 例外（仅限主会话）：`convergenceEnforced:false` 时**强制执行面**整体缺席
 *     （零催办、零分级强制、零自动续跑——模型自然收尾即终局），但 W47 起
 *     **终审子集恒挂**：模型自愿 converge 的受理必须真实终结本轮（不兑现"收束已受理"
 *     即是 hm/ai 主会话挂死事故的根因）。旁路在接线层，gate/machine 本体零改动；
 *     side/子会话各端口自建 gate 全量挂载，不受本开关影响。
 *   - boundary.ts 的 TurnBoundary：`deliver` 收件箱只在 turn 边界消费（D23）+ T18 turn 边界重装配。
 *
 * 跨请求自动续跑（D26，预算 = Limits.autoContinuations，默认 2）：
 * gate 未盖棺而内核以 done / max_turns / max_continuations 收尾时，用 `session.continue()`
 * 再接续；预算用尽仍未收束 → 主会话**自动收束"需用户确认"**（合成如实回执 + 持久
 * 【强制收束】marker 注入下个 turn 边界），绝不静默假完成。
 */

import {
  AgentSession,
  type AgentSessionOptions,
  type RunSummary,
  type SteerHandle,
  type SteerOptions,
} from "../session.js";
import type { SessionStore } from "../session-store.js";
import type { Hook } from "../hook.js";
import type { CompactionCheckpointPayload } from "../compaction-checkpoint.js";
import type { ConvergenceOutcome } from "../convergence/receipt.js";
import { ConvergenceGate } from "../convergence/gate.js";
import { DEFAULT_LIMITS, type Limits } from "../convergence/limits.js";
import { FlowGate } from "../flow/gate.js";
import { FlowCommitTool } from "../flow/tool.js";
import { createFlowReadTools } from "../flow/read-tools.js";
import { filterIncompleteToolCalls, type HarnessTool } from "../types.js";
import type { Message } from "@earendil-works/pi-ai"; // 环纪律：深路径直引，不 import 自身 barrel（见 convergence/gate.ts 注释）
import { renderAssemblyPrefix, type Assembly, type SessionContextPreview } from "../assembly/index.js";
import { TurnBoundary } from "./boundary.js";
import {
  budgetExhaustedReceipt,
  classifyOutcome,
  classifyTerminal,
  forceMarker,
} from "./outcome.js";
import type {
  LoopEvent,
  MainLoopResult,
  MainSessionLoopOptions,
} from "./types.js";

/** resume 的必配项：同一 lineage 续跑必须有 store + sessionId。 */
export interface MainSessionLoopResumeOptions extends MainSessionLoopOptions {
  readonly store: SessionStore;
  readonly sessionId: string;
}

/** 内核续跑预算下限（= AgentSession 默认值）；nudgeLimit 更大时以 gate 需求为准。 */
const MIN_KERNEL_CONTINUATIONS = 5;

/** 除 model/tools/hooks 外的内核初始化项（create/resume 共用，逐字段条件展开）。 */
type KernelInit = Omit<
  AgentSessionOptions,
  "model" | "tools" | "hooks" | "store" | "sessionId" | "initialMessages" | "resumedMessageCount"
>;

/** create / resume 共享的接线件。`buildHooks()` 每个 gate 只可调一次，故在此一次性取全。 */
interface WiredParts {
  readonly limits: Limits;
  readonly gate: ConvergenceGate;
  /** L4：flow 未接线时为 null（无工具/hook，终局判别完全旧行为）。 */
  readonly flowGate: FlowGate | null;
  /** L8：false = 本主循环不挂 converge 工具与钩子（flow 接管终止）。 */
  readonly convergeEnabled: boolean;
  readonly boundary: TurnBoundary;
  readonly events: LoopEvent[];
  readonly assemblies: Assembly[];
  readonly tools: HarnessTool[];
  readonly hooks: Hook<Message | CompactionCheckpointPayload>[];
  readonly kernel: KernelInit;
  /**
   * W26 强制开关现值（types.ts convergenceEnforced 的解析结果；缺省/true = true）。
   * create/resume 两条构造路都经 wireParts 取此项：W47 起仅判别 hook 挂载面
   * （全量 buildHooks vs 终审子集）与终态面（_drive 是否短路 _naturalOutcome）；
   * 落盘改标门面已两态恒挂，不再受本值分叉。
   */
  readonly enforced: boolean;
}

/**
 * W16-F3 终态改标的 store 门面（仅主会话面）：converge 受理轮经 gate 盖棺机制收尾，
 * 内核冻结契约是其 reason==="aborted" + abortReason 前缀 "convergence:converged"
 * （gate.ts 头注终止通道）；转录层 terminal entry 照抄 "aborted" 属系统错标。
 * 落盘口按 outcome.ts 既有词表的 converged 终态语义把 terminal 持久副本的 reason
 * 改写为 "done"（内核既有词，不造第三词；abortReason 原样留审计）。
 * 只改持久副本：内核内存 RunSummary 与 MainLoopResult 判别逐字节不动，
 * classifyTerminal 仍以 gate 账本为唯一真相。判据 = gate 冻结唯一通道
 * isConvergedTermination（abortReason 前缀 + 本会话账本）；L4 flow 的 closed 同属完成语义
 * （`flow:closed:<subject_id>`），一并改标，waiting_* 仍留 aborted；真 abort 留 "aborted"。
 */
function isFlowClosedTermination(
  flowGate: FlowGate | null,
  abortReason: string | undefined,
): boolean {
  if (flowGate === null || abortReason === undefined) return false;
  const outcome = flowGate.runOutcome();
  return (
    outcome !== null &&
    outcome.state === "closed" &&
    abortReason === `flow:closed:${outcome.subject_id}`
  );
}

function convergeTerminalStore(
  store: SessionStore,
  gate: ConvergenceGate,
  flowGate: FlowGate | null,
): SessionStore {
  return {
    appendEntry(sessionId, entry) {
      if (entry.kind === "terminal" && entry.result.reason === "aborted") {
        const converged =
          gate.isConvergedTermination(sessionId, entry.result.abortReason) ===
          "converged";
        // L4：flow closed 是完成语义（kernel abort 词表里只有 aborted）；waiting_* 是
        // 等待而非完成，保持 aborted 原样。converge 判据在无 flow 时逐字节不变。
        if (converged || isFlowClosedTermination(flowGate, entry.result.abortReason)) {
          return store.appendEntry(sessionId, {
            kind: "terminal",
            result: { ...entry.result, reason: "done" },
          });
        }
      }
      return store.appendEntry(sessionId, entry);
    },
    getLeafId: (sessionId) => store.getLeafId(sessionId),
    getPathToLeaf: (sessionId, leafId) => store.getPathToLeaf(sessionId, leafId),
    fork: (sessionId, fromEntryId) => store.fork(sessionId, fromEntryId),
    getLineage: (sessionId) => store.getLineage(sessionId),
  };
}

function wireParts(opts: MainSessionLoopOptions): WiredParts {
  const limits: Limits = opts.limits ?? { ...DEFAULT_LIMITS };
  // W26 强制开关：仅 `=== false` 免强制；undefined/true 走现状逐字节（缺省=强制在位，
  // 与"unset => true"的部署语义同源——server 配置键缺席时根本不把该项传下来）。
  const enforced = opts.convergenceEnforced !== false;
  // L8：仅显式 "disabled" 摘除 converge 面；缺省/enabled 逐字节旧行为。
  const convergeEnabled = opts.converge !== "disabled";
  const flow = opts.flow;
  const flowGate = flow !== undefined ? new FlowGate({ store: flow.store }) : null;
  const flowTools: HarnessTool[] =
    flow !== undefined
      ? [
          FlowCommitTool({ store: flow.store }),
          ...createFlowReadTools({ store: flow.store }),
        ]
      : [];
  // gate 照常构造：tool（收束工具挂载面）与账本形状（runOutcome()/isConvergedTermination）
  // 保持在场。免强制摘的是**执行面**——hooks 不挂，machine reducer 便无任何事件入口，
  // 催办/分级强制/盖棺终止全部失能；这比向 gate 内部塞开关小得多（gate 零改动，
  // side/子会话共用的强制机器不被本主会话专属开关污染）。
  const gate = new ConvergenceGate({
    kind: "main",
    limits,
    ...(opts.autoWakeEnabled !== undefined ? { autoWakeEnabled: opts.autoWakeEnabled } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  // flow hooks 必须先于 converge hooks 入册：onTurnEnd 事件并行、合并时第一个
  // continue:false 的 stopReason 生效（dispatcher.mergeResults），flow 终局不得被
  // converge 的 stopReason 抢占。
  const flowHooks: Hook<Message | CompactionCheckpointPayload>[] =
    flowGate !== null ? flowGate.buildHooks() : [];
  const convergeHooks: Hook<Message | CompactionCheckpointPayload>[] = convergeEnabled
    ? enforced
      ? gate.buildHooks()
      : gate.buildAdjudicationHooks()
    : [];
  const events: LoopEvent[] = [];
  const assemblies: Assembly[] = [];
  const boundary = new TurnBoundary({
    assembly: opts.assembly ?? null,
    onDelivered: (turnIdx, count) => {
      events.push({ type: "delivery-drained", turnIdx, count });
    },
    onRemindersDrained: (turnIdx, texts) => {
      events.push({ type: "reminder-drained", turnIdx, count: texts.length, texts });
      // 观测面纪律（同 trace 全系）：回调反噬回合 = 缺陷，吞断留 events 记账即可。
      try {
        opts.onRemindersDrained?.(turnIdx, texts);
      } catch {
        /* swallow */
      }
    },
    onAssembly: (turnIdx, assembly) => {
      events.push({ type: "assembly", turnIdx, assembly });
      assemblies.push(assembly);
    },
  });

  // 请求面接线（Unit B，决策）：装配接线时逐轮上送模型的 systemPrompt = plan 前缀段
  // 渲染字节（身份段+memory 段+workflow 段，renderAssemblyPrefix 与 assemble 前三段
  // 字节同源 ⇒ sha256(systemPrompt)==prefixHash，trace 声明的前缀就是发给模型的字节）。
  // 主会话与副会话请求面同构（side 路同样是 systemPrompt 字符串携 renderMemorySegment），
  // 不另造 cache 层：plan 跨轮静态 ⇒ 该字节跨轮恒定（W14 前缀纪律），provider prompt-cache
  // 前缀命中；增量段3 不进 systemPrompt——对话 messages 本体就是增长尾巴，恒挂前缀之后。
  // 优先级：装配接线 ⇒ plan 是 prompt 字节唯一真源，不与 opts.systemPrompt 叠加
  // （叠加=身份段双份进请求；boot 链路线上 registry 不传 systemPrompt，无现caller两者齐传）。
  // 装配事件/trace/W13 context 面零改动：TurnBoundary 仍每边界重装配、assemblies() 照记。
  const promptBytes =
    opts.assembly !== undefined ? renderAssemblyPrefix(opts.assembly.plan) : opts.systemPrompt;

  // 装配 plan 热重载：provider 返回新 plan → 更新 turn 边界 plan，并把新渲染前缀交给内核。
  // 渲染字节不变 = 无重载（不 bump plan 版本，currentAssembly 保持同一缓存对象）。
  let currentPromptBytes = promptBytes;
  const refreshAssemblyPlan = opts.refreshAssemblyPlan;
  let refreshSystemPrompt: NonNullable<AgentSessionOptions["refreshSystemPrompt"]> | undefined;
  if (refreshAssemblyPlan !== undefined && opts.assembly !== undefined) {
    refreshSystemPrompt = async (reason) => {
      const refreshed = await refreshAssemblyPlan(reason);
      const nextPlan =
        refreshed === null ? null : "plan" in refreshed ? refreshed.plan : refreshed;
      const contextBaseline =
        refreshed !== null && "plan" in refreshed
          ? refreshed.contextBaseline
          : undefined;
      if (nextPlan === null) {
        return contextBaseline === undefined ? null : { prompt: null, contextBaseline };
      }
      const nextBytes = renderAssemblyPrefix(nextPlan);
      if (nextBytes === currentPromptBytes) {
        return contextBaseline === undefined ? null : { prompt: null, contextBaseline };
      }
      boundary.setAssemblyPlan(nextPlan);
      currentPromptBytes = nextBytes;
      return contextBaseline === undefined
        ? nextBytes
        : { prompt: nextBytes, contextBaseline };
    };
  }

  const kernel: KernelInit = {
    maxContinuations: Math.max(gate.minKernelBudget(), MIN_KERNEL_CONTINUATIONS),
    ...(promptBytes !== undefined ? { systemPrompt: promptBytes } : {}),
    ...(refreshSystemPrompt !== undefined ? { refreshSystemPrompt } : {}),
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    // W42a：瞬时 provider 错误重试上限透传（键缺席=不注入、内核缺省 2；显式 0 禁用）。
    ...(opts.llmErrorRetries !== undefined ? { llmErrorRetries: opts.llmErrorRetries } : {}),
    // T4：重试退避基数透传（键缺席 = 不注入、内核缺省 1000；显式 0 = 立即重发）。
    ...(opts.llmErrorRetryBackoffMs !== undefined
      ? { llmErrorRetryBackoffMs: opts.llmErrorRetryBackoffMs }
      : {}),
    ...(opts.llmOptions !== undefined ? { llmOptions: opts.llmOptions } : {}),
    ...(opts.compaction !== undefined ? { compaction: opts.compaction } : {}),
    ...(opts.contextWatcher !== undefined ? { contextWatcher: opts.contextWatcher } : {}),
    ...(opts.contextCheckEachTurn !== undefined
      ? { contextCheckEachTurn: opts.contextCheckEachTurn }
      : {}),
    ...(opts.onWireSnapshot !== undefined ? { onWireSnapshot: opts.onWireSnapshot } : {}),
    ...(opts.logSink !== undefined ? { logSink: opts.logSink } : {}),
    ...(opts.consoleSink !== undefined ? { consoleSink: opts.consoleSink } : {}),
  };

  return {
    limits,
    gate,
    flowGate,
    convergeEnabled,
    boundary,
    events,
    assemblies,
    // L4：flow_commit 前置（先于 converge），其余调用方工具顺延；flow 未接线时逐字节旧数组。
    tools: [...flowTools, ...(convergeEnabled ? [gate.tool] : []), ...(opts.tools ?? [])],
    // W26/W47：免强制摘的是**强制执行面**（催办投递引擎 turnEndGuard/分级/硬顶），
    // 但终审子集恒挂——受理面（gate.tool）无条件在场，"收束已受理"的承诺必须有人兑现
    // （hm/ai 事故：tools 挂、hooks 全摘 → 受理无人终审 → 内核唯一出口"无 toolUse 轮"
    // 永不触发 → 挂死至内核缺省 maxTurns=200）。终审子集只含复位+受理判别，
    // 零催办零强制（见 gate.buildAdjudicationHooks）。
    hooks: [...flowHooks, ...convergeHooks, boundary.buildHook(), ...(opts.extraHooks ?? [])],
    kernel,
    enforced,
  };
}

export class MainSessionLoop {
  readonly id: string;

  private readonly _session: AgentSession;
  private readonly _gate: ConvergenceGate;
  private readonly _flowGate: FlowGate | null;
  private readonly _convergeEnabled: boolean;
  private readonly _boundary: TurnBoundary;
  private readonly _limits: Limits;
  private readonly _enforced: boolean;
  private readonly _events: LoopEvent[];
  private readonly _assemblies: Assembly[];
  private _active = false;
  /** W17-G resume 前置的记忆化槽（首跑装载一次；null=尚未发起）。 */
  private _hydration: Promise<boolean> | null = null;

  private constructor(parts: WiredParts, session: AgentSession) {
    this._session = session;
    this._gate = parts.gate;
    this._flowGate = parts.flowGate;
    this._convergeEnabled = parts.convergeEnabled;
    this._boundary = parts.boundary;
    this._limits = parts.limits;
    this._enforced = parts.enforced;
    this._events = parts.events;
    this._assemblies = parts.assemblies;
    this.id = session.id;
  }

  /** 新建主循环；给 store + sessionId 即具备 abort→resume（HWM 落盘 + 同 lineage 重建）。 */
  static create(opts: MainSessionLoopOptions): MainSessionLoop {
    const parts = wireParts(opts);
    const session = new AgentSession({
      model: opts.model,
      tools: parts.tools,
      hooks: parts.hooks,
      ...parts.kernel,
      // W16-F3：主会话落盘口经 gate 终审改标（仅 terminal entry 持久副本，见 convergeTerminalStore）。
      // W47：改标门面两态恒挂——自然停的终审同样以 aborted+"convergence:converged" 前缀
      // 收尾（受理必终结），落盘诚实化需要同一改标；纯 text-only 自然停 reason "done"
      // 无 abort 信号，门面按判据透传（逐字段原值，旧语义不漂）。
      ...(opts.store !== undefined
        ? { store: convergeTerminalStore(opts.store, parts.gate, parts.flowGate) }
        : {}),
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    });
    return new MainSessionLoop(parts, session);
  }

  /**
   * 从 store 落盘历史重建绑回同一 lineage 的主循环——abort 后接续的唯一合法路径。
   * 孤儿 toolCall 尾巴由 vendor `AgentSession.resume` 修复（合成 isError toolResult 并
   * 即时 append 回 store），本层不另造修复逻辑。
   */
  static async resume(opts: MainSessionLoopResumeOptions): Promise<MainSessionLoop> {
    const parts = wireParts(opts);
    // W47：resume 与 create 同一落盘口径——改标门面恒挂（判据不满足即透传，见 convergeTerminalStore）。
    const store = convergeTerminalStore(opts.store, parts.gate, parts.flowGate);
    const session = await AgentSession.resume(
      store,
      opts.sessionId,
      {
        model: opts.model,
        tools: parts.tools,
        hooks: parts.hooks,
        ...parts.kernel,
      },
    );
    return new MainSessionLoop(parts, session);
  }

  /**
   * 一次用户请求：run +（gate 未盖棺时）跨请求自动续跑，直到收束 / 强制收束 / abort / error。
   * `signal` 透传内核，与 `abort()` 同一通道。
   * `contextNotices`（W16）只在**首个 request** 的 run 入口消费——自动续跑走
   * `session.continue()`（source!=="run"），notice 天然不重放；notice 缺失 ⇒ 逐字节旧调用面。
   */
  async start(
    prompt: string,
    opts?: {
      signal?: AbortSignal;
      contextNotices?: readonly string[];
      contextPreview?: SessionContextPreview | null;
      promptTimestamp?: number;
    },
  ): Promise<MainLoopResult> {
    if (this._active) {
      throw new Error("MainSessionLoop.start(): a run is already in progress");
    }
    this._active = true;
    try {
      this._boundary.notePrompt(prompt);
      const signal = opts?.signal;
      const first = await this._session.run(prompt, {
        ...(signal !== undefined ? { signal } : {}),
        ...(opts?.contextNotices !== undefined ? { contextNotices: opts.contextNotices } : {}),
        ...(opts?.contextPreview !== undefined ? { contextPreview: opts.contextPreview } : {}),
        ...(opts?.promptTimestamp !== undefined ? { promptTimestamp: opts.promptTimestamp } : {}),
      });
      return await this._drive(first, signal);
    } finally {
      this._active = false;
    }
  }

  /**
   * T5 失败回合重放：**不追加用户消息**，从已落盘/已载入的转录续跑（= `AgentSession.continue()`）。
   * 用于瞬时 provider 错误后的同一轮重试——prompt 已在转录里，重放绝不能 `run(text)`，
   * 否则同一 user 消息会二次落盘、已执行的工具会被重跑。
   *
   * 与 `start()` 的差别只有两处：无 prompt 参数（故不 `notePrompt`），也不接受
   * contextNotices/promptTimestamp（这些属首请求面，continue 天然不重放）。
   * 互斥口径不变：同一 loop 同一时刻只允许一个 run/continue。
   */
  async continueRun(opts?: { signal?: AbortSignal }): Promise<MainLoopResult> {
    if (this._active) {
      throw new Error("MainSessionLoop.continueRun(): a run is already in progress");
    }
    this._active = true;
    try {
      const signal = opts?.signal;
      const first = await this._session.continue(signal !== undefined ? { signal } : {});
      return await this._drive(first, signal);
    } finally {
      this._active = false;
    }
  }

  /** 结束当前回合并落盘（HWM 已逐条 flush），随时可 `MainSessionLoop.resume` 续跑。 */
  abort(reason = "abort() called"): void {
    this._session.abort(reason);
  }

  /**
   * W17-G 重启对话连续性（仅 SessionRegistry 首跑前调用；side/子会话路径不经此面）：
   * 本 sid 在 store 有转录 ⇒ 用 `AgentSession.resume` 同一重放体把 durable 历史载入内核
   * 内存（含压缩边界裁剪 + 孤儿 toolCall 修复，语义见 core/session.ts）；无转录 ⇒ false，
   * 逐字节旧行为。请求面 systemPrompt 出自同一 `wireParts` 装配（create/resume 共享），
   * 装载不触碰前缀字节（W15-B）。记忆化：重放每 loop 至多发生一次，排队/语音轮零成本。
   */
  hydrate(): Promise<boolean> {
    if (this._hydration === null) {
      this._hydration = this._session.hydrateFromStore();
    }
    return this._hydration;
  }

  /**
   * 外部投递入队（副会话回执 / 死信，D23）：**只在 turn 边界消费**，绝不打断进行中的
   * 用户回合（turn 边界 = 内核 fire onTurnStart，下一次 LLM call 组 messages 之前）。
   */
  deliver(content: string | Message): void {
    this._boundary.deliver(content);
  }

  /**
   * 系统提醒入队（W12）：同 deliver 只在 turn 边界消费，但走内核 transient attachment
   * 通道——只进下一次 LLM call 的 messages view 与 T18 段3，**不进 session.messages、
   * 不随 HWM 落盘**（"提醒不在历史中"的实现位；副会话终态提醒即此通道的首个生产者）。
   */
  remind(text: string): void {
    this._boundary.remind(text);
  }

  /** W12 滞留可见性：待注入提醒深度（主会话不在跑时提醒滞留此队列，下轮边界消费）。 */
  pendingReminders(): number {
    return this._boundary.pendingReminders;
  }

  /** 用户插队（内核 steering）：park 后同样只在 turn 边界 drain。 */
  steer(message: Message, opts?: SteerOptions): SteerHandle {
    return this._session.steer(message, opts);
  }

  /** 待消费 deliver 深度（边界 drain 后归零）。 */
  pendingDeliveries(): number {
    return this._boundary.pendingCount;
  }

  /** fork / subagent 快照：用 vendor `filterIncompleteToolCalls` 剔除悬挂 toolCall 尾巴。 */
  snapshot(): { sessionId: string; messages: Message[] } {
    const raw = [...this._session.messages];
    return { sessionId: this.id, messages: filterIncompleteToolCalls(raw) };
  }

  /** 只读底层内核（供 T27 上层接线；不要绕过 loop 直接 run）。 */
  get session(): AgentSession {
    return this._session;
  }

  get messages(): ReadonlyArray<Message> {
    return this._session.messages;
  }

  /** gate 账本 outcome（每次 run 起账，含终态）。 */
  outcomes(): ReadonlyArray<ConvergenceOutcome> {
    return this._gate.runOutcome().outcomes;
  }

  /** 本 loop 消费过的全部事件（只追加，T21 trace 可直接落账）。 */
  events(): ReadonlyArray<LoopEvent> {
    return [...this._events];
  }

  /** T18 装配产物（每个装配过的 turn 边界一条；未接线为空）。 */
  assemblies(): ReadonlyArray<Assembly> {
    return [...this._assemblies];
  }

  /**
   * 当前 plan 对应的装配视图：未发生真实装配 → null；plan 未变 → 最近一次装配对象；
   * plan 已热重载 → 用新前缀 rebase（不重读历史、不改写 `assemblies()`）。
   */
  currentAssembly(): Assembly | null {
    return this._boundary.currentAssembly();
  }

  /** 热载阈值引用（D26：注入的可变 Limits，gate/loop 事件时刻现读）。 */
  get limits(): Limits {
    return this._limits;
  }

  private async _drive(first: RunSummary, signal?: AbortSignal): Promise<MainLoopResult> {
    const flowEnded = this._flowEnded(first, 1);
    if (flowEnded !== null) return flowEnded;
    // W26 免强制终局（用户决策 2026-10-10 10:19，仅限主会话）：模型的自然停止**就是**
    // 终局——不进 gate 账本判别、不跨请求自动续跑、不改标。若照旧走 _drive，
    // classifyTerminal 会把 reason:"done" 判成 "pending"（账本无 terminal 的旧语义
    // = "未盖棺"），继而自动续跑到预算用尽 forceEnded——那正是本开关要摘掉的强制链。
    // L8 converge:"disabled" 同走自然停：没有 converge 钩子时账本恒空，继续跑
    // _drive 只会合成强制收束回执（本开关明令不得伪造）。
    if (!this._convergeEnabled || !this._enforced) {
      return this._naturalOutcome(first);
    }
    let current = first;
    let runs = 1;
    for (;;) {
      const flow = this._flowEnded(current, runs);
      if (flow !== null) return flow;
      this._consumeOutcomes();
      const decision = classifyTerminal(this._gate.runOutcome().outcome, current);
      switch (decision.kind) {
        case "converged":
          return {
            type: "converged",
            receipt: decision.receipt,
            summary: current,
            runs,
            autoContinuationsUsed: runs - 1,
          };
        case "forceEnded":
          return {
            type: "forceEnded",
            cause: decision.cause,
            receipt: decision.receipt,
            deadLetter: decision.deadLetter,
            summary: current,
            runs,
            autoContinuationsUsed: runs - 1,
          };
        case "userAbort":
          return { type: "aborted", summary: current, runs, autoContinuationsUsed: runs - 1 };
        case "error":
          return { type: "error", summary: current, runs, autoContinuationsUsed: runs - 1 };
        case "pending": {
          if (runs - 1 >= this._limits.autoContinuations) {
            return this._forceBudgetExhausted(current, runs);
          }
          runs += 1;
          current =
            signal !== undefined
              ? await this._session.continue({ signal })
              : await this._session.continue();
          continue;
        }
        default: {
          const unreachable: never = decision;
          throw new Error(`unhandled TerminalDecision: ${JSON.stringify(unreachable)}`);
        }
      }
    }
  }

  /** 自动续跑预算用尽 → 自动收束"需用户确认"（绝不静默假完成，D26）。 */
  private _forceBudgetExhausted(summary: RunSummary, runs: number): MainLoopResult {
    const receipt = budgetExhaustedReceipt(this._limits);
    // 持久 marker 经内核 steer inbox 在下个 turn 边界注入（进对话、随 HWM 落盘）。
    this._session.steer(forceMarker(receipt));
    this._events.push({ type: "loop-forced", receipt });
    return {
      type: "forceEnded",
      cause: "auto-continuations-exhausted",
      receipt,
      deadLetter: false,
      summary,
      runs,
      autoContinuationsUsed: runs - 1,
    };
  }

  /**
   * W26 免强制的终局映射（与 classifyTerminal 的"账本唯一真相"判别互斥——账本此处
   * 只有终审子集受理盖棺时写一条 converged，其余恒空）。
   * error / 真 abort（用户/外部掐）沿用既有变体；**aborted + gate 盖棺前缀**
   * （W47 终审子集兑现"收束已受理"的通道，与强制路同一 isConvergedTermination 判据）
   * 如实归 converged——回执取账本 terminal，模型自愿收束与 text-only 自然停两态可区分，
   * 受理终结不被 naturalStop 误标。其余内核收尾（done / max_turns / max_continuations）
   * 一律 naturalStop——免强制没有"续跑"概念，runs 恒 1、预算恒 0，
   * 类型级钉死"未经自动续跑"（防未来误在此路径塞 continue）。内核真实 reason 由
   * summary 携带；落盘 terminal 经恒挂的改标门面：盖棺轮改标 done、其余透传。
   */
  private _naturalOutcome(first: RunSummary): MainLoopResult {
    const flowEnded = this._flowEnded(first, 1);
    if (flowEnded !== null) return flowEnded;
    switch (first.reason) {
      case "error":
        return { type: "error", summary: first, runs: 1, autoContinuationsUsed: 0 };
      case "aborted": {
        if (this._gate.isConvergedTermination(this.id, first.abortReason) === "converged") {
          const terminal = this._gate.runOutcome().outcome;
          if (terminal !== null && terminal.type === "converged") {
            return {
              type: "converged",
              receipt: terminal.receipt,
              summary: first,
              runs: 1,
              autoContinuationsUsed: 0,
            };
          }
        }
        return { type: "aborted", summary: first, runs: 1, autoContinuationsUsed: 0 };
      }
      case "done":
      case "max_turns":
      case "max_continuations":
        return { type: "naturalStop", summary: first, runs: 1, autoContinuationsUsed: 0 };
      default: {
        const unreachable: never = first.reason;
        throw new Error(`unhandled RunSummary.reason: ${String(unreachable)}`);
      }
    }
  }

  /** L4 flow 终态判别：只有本 run 受理了 terminal 提交才非 null（active/未提交恒 null）。 */
  private _flowEnded(summary: RunSummary, runs: number): MainLoopResult | null {
    const flow = this._flowGate?.runOutcome() ?? null;
    if (flow === null) return null;
    return {
      type: "flowEnded",
      flow,
      summary,
      runs,
      autoContinuationsUsed: runs - 1,
    };
  }

  /** Outcome 消费：continued→续 / nudged→催办注入 / escalated→升级记账 / 终态→盖棺记录。 */
  private _consumeOutcomes(): void {
    for (const outcome of this._gate.runOutcome().outcomes) {
      this._events.push({ type: "outcome", outcome, disposition: classifyOutcome(outcome) });
    }
  }
}
