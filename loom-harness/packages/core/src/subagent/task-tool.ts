/**
 * task 工具（T11 / D5）—— 主会话派发子智能体的**装配层**。
 *
 * 「在其上装配而非重写」：派发管线（agent_type 路由枚举、纵向深度透传 #45、父 signal 透传、
 * onSubagentStart/End hook 事件、子终态 → ToolExecResult 整形）全部复用 vendored
 * `plugins/controllers/routedSubAgentTool`；续聊句柄留存复用 `SubAgentRegistry`。
 * 本文件只加 loom 侧的四件事：
 *   1. **横向闸（并发扇出）**：vendored 计数是「实例累计」，不是「在飞并发」；且阈值须
 *      从注入的 SubagentLimits **事件时刻现读**（热载，对齐 D26 模式）→ 在飞计数 + 到顶
 *      fail-loud 拒绝（throw → kernel 包 isError 回灌模型，绝不排队静默等）。
 *      并发来源 = kernel ToolExecutor 对连续 `isConcurrencySafe` 调用的 safe 段 Promise.all
 *      （同一 assistant message 多个 task 调用即并行扇出），无需 WorkPool（其静态分组
 *      complete/fail/skip 终态模型没有「满则拒」语义，与验收「跑到上限断言拒绝」冲突）。
 *   2. **`<task_metadata>` 回灌**：结果**以工具结果消息形态**进主会话（kernel push 的
 *      toolResult message，非 system 注入）；文本尾部追加字面元数据块（前端反解契约，
 *      `./metadata.js`），session_id 为无连字符 `ses_<hex16>`（`./ids.js` 生成）。
 *   3. **Start/End 回调注入**：hook 通路（fireSubagent*）之外再给一组**直接回调**
 *      （T21 Tracer 接线用，注入回调即可，不要求挂 hook）。
 *   4. **registry 留存 + 父 abort 清空**：子 session 跑完首轮即 retain，父可按 id 续聊；
 *      首个 execute 时把父 ctx.signal 绑到 registry.clear（资源安全，句柄不跨 abort 泄漏）。
 *
 * 不做：不 import main-loop/run-engine（工具由 T10 侧接线）；不碰 core 既有文件。
 * W9 切片 1 注：本文件为**门面**——缺省子会话的 spawn 构造改道 kernel.buildSubSession
 * 唯一工厂（raw-summary 档案，构造逐字节不变）；横/纵闸、signal 链、metadata 渲染、
 * Start/End 回调、registry 留存全部留在本装配层，vendored 路由管线不动。
 */

import type { Usage } from "@earendil-works/pi-ai";
import {
  Type,
  type AgentSession,
  type Api,
  type HarnessTool,
  type HookContext,
  type Model,
  type RunSummary,
  type ToolExecResult,
} from "../index.js";
import { buildSubSession } from "../kernel/kernel.js";
import {
  SubAgentRegistry,
  routedSubAgentTool,
  type AgentSpec,
} from "../plugins/controllers/index.js";
import { SUBAGENT_ID_RE, newSubagentSessionId } from "./ids.js";
import type { SubBackgroundPort, SubFanout } from "../kernel/types.js";
import { defaultRunId, type RunLaunchResult, type RunRow } from "../run-engine/types.js";
import {
  TASK_METADATA_CLOSE,
  TASK_METADATA_OPEN,
  extractSubAgentResultInfo,
  renderTaskMetadata,
} from "./metadata.js";
import {
  DEFAULT_MAX_INFLIGHT_TOTAL,
  DEFAULT_BACKGROUND_DEADLINE_MS,
  DEFAULT_SUBAGENT_LIMITS,
  assertValidSubagentLimits,
  type SubagentLimits,
} from "./limits.js";
import type { AgentTypeDef } from "./agents.js";

/** 派发**开始**事件（子 session 已造好、run 前）。形状对齐 OnSubagentStartInput + agentType。 */
export interface TaskStartEvent {
  readonly agentId: string;
  readonly agentType: string;
  readonly task: string;
  /** 子的递归深度（父 +1）。 */
  readonly depth: number;
  /** W49.2 生效标题（显式或 derived，与账本/状态块同一字符串；观察面 additive，tool-trace 按名取键不受扰）。 */
  readonly title?: string;
}

/** 派发**结束**事件（子终态到手后）。配对 TaskStartEvent。 */
export interface TaskEndEvent {
  readonly agentId: string;
  readonly agentType: string;
  readonly task: string;
  readonly depth: number;
  readonly reason: string;
  readonly turns: number;
  readonly usage?: Usage;
  readonly summaryText?: string;
}

export interface TaskRegistryOptions {
  readonly maxRetained?: number;
  readonly ttlMs?: number;
}

export interface TaskToolOptions {
  /** 可用 agent 类型（`loadAgentTypes()` 产物）。至少一个。 */
  readonly agentTypes: readonly AgentTypeDef[];
  /** tool 名（默认 "task"）。 */
  readonly name?: string;
  /** description 前缀；各类型的 whenToUse 由 vendored 路由层自动拼在其后。 */
  readonly description?: string;
  /**
   * 注入的**可变** Limits 对象；横/纵两闸都在每次派发时刻现读（热载即刻生效，不快照）。
   * 缺省用 DEFAULT_SUBAGENT_LIMITS 的共享默认实例。
   */
  readonly limits?: SubagentLimits;
  /** 子 session 缺省模型（当 `resolveModel` 未给该类型选模型时的兜底；D5 模型路由）。 */
  readonly model?: Model<Api>;
  /** 按 agent 类型选模型（D5「定义=提示词文件+模型路由」）；缺省回落 `opts.model`。 */
  readonly resolveModel?: (def: AgentTypeDef) => Model<Api> | undefined;
  /** 按 agent 类型给子会话装配 tools（缺省空集）。 */
  readonly childTools?: (def: AgentTypeDef) => HarnessTool[];
  /** 单子会话轮数上限（缺省用 AgentSession 默认 200）。 */
  readonly subMaxTurns?: number;
  /**
   * 整体覆盖子会话构造（T10 特殊装配 / 测试注入用）。**必须**给 session 设无连字符 id
   * （`newSubagentSessionId()`），否则 `<task_metadata>` 前端契约被破坏 → 装配层 fail-loud。
   */
  readonly childSessionFactory?: (
    def: AgentTypeDef,
    task: string,
    parentCtx: HookContext,
  ) => AgentSession;
  /** false = 不留存子句柄（跑完即弃，对齐 vendored 默认）。默认 true。 */
  readonly retain?: boolean;
  readonly registry?: TaskRegistryOptions;
  /** T21 Tracer 接线点：子派发开始的直接回调。 */
  readonly onSubagentStart?: (e: TaskStartEvent) => void | Promise<void>;
  /** T21 Tracer 接线点：子派发终态的直接回调（与 start 配对）。 */
  readonly onSubagentEnd?: (e: TaskEndEvent) => void | Promise<void>;
  /**
   * W9 切片 2：横闸在飞计数委托（缺省 = 局部变量计数，旧调用面逐字节不变）。
   * serve 传 SpawnKernel 的在飞册视图 → 主/副/子跨门面共享一个池。
   * 计数窗等价性：检查→构造注册在**同一同步帧**内完成（JS 单线程，无 await 间隙），
   * 出册在 execute finally（= 子 run 终态的最早可观测点，与今日 finally 同窗）；
   * 构造前即被拒的派发（空任务/未知类型/纵闸/实例累计闸）不再占坑——更精确，
   * 现有测试无该形态覆盖（fanout 用例全部走到构造，depth 用例 fanout 宽裕）。
   */
  readonly fanout?: SubFanout;
  /**
   * W9 切片 3：后台派发内核口（serve 传 SpawnKernel）。缺省不接 = `background:true`
   * 调用响亮拒绝（旧调用面零感知；subagent.test 等既有面逐字节不变）。
   */
  readonly subBackground?: SubBackgroundPort;
  /** 任务号生成器（缺省 defaultRunId；测试确定性注入）。 */
  readonly newTaskId?: () => string;
}

/** createTaskTool 产物：工具 + 续聊 registry（retain=false 时为 null）+ 生效 Limits 引用。 */
export interface TaskToolHandle {
  readonly tool: HarnessTool;
  readonly registry: SubAgentRegistry | null;
  readonly limits: SubagentLimits;
}

/** 读当前会话的子代理深度（vendored DEPTH_KEY 已注册进 HookStateRegistry → 类型化，无 cast）。 */
function currentDepth(ctx: HookContext): number {
  return ctx.state.get("subAgent.depth") ?? 0;
}

/** 取 ToolExecResult 的纯文本（content 为 block 数组）。 */
function resultText(result: ToolExecResult): string {
  return result.content
    .map((b) => ("text" in b && typeof b.text === "string" ? b.text : ""))
    .join("");
}

/** 崩溃兜底 usage 占位（与 vendored spawnSubAgent finally 零值同形）。 */
const ZERO_USAGE: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 取一条 message 的纯文本（vendored sub-agent-tool 同款行语，模块级复用）。 */
function messageText(m: import("../index.js").Message | undefined): string {
  if (m === undefined) return "";
  return typeof m.content === "string"
    ? m.content
    : m.content.map((b) => ("text" in b && typeof b.text === "string" ? b.text : "")).join("");
}

/**
 * W49.2 标题 derived 兜底：折叠空白后取前 40 **码点**（Array.from 口径，补充平面一字
 * 不算两个 UTF-16 单位），截断补 …。显式 title 同走折叠（行式 metadata 块与 JSONL
 * 账本都要单行安全），但不截（尊重派发方选词，≤40 是描述里的建议值）。
 */
const TITLE_FALLBACK_CODEPOINTS = 40;

function collapseWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function deriveTitle(task: string): string {
  const collapsed = collapseWs(task);
  const cps = Array.from(collapsed);
  return cps.length > TITLE_FALLBACK_CODEPOINTS
    ? `${cps.slice(0, TITLE_FALLBACK_CODEPOINTS).join("")}…`
    : collapsed;
}

/**
 * raw-summary 终态整形（后台账本的 RunLaunchResult 视图）：词表对齐 vendored
 * subAgentResult（无文本兜底语逐字）与 side-port 未收束分支（failed+说明，不伪装成功）。
 *
 * **W42a error 终态**：`why` 取词把 summary.error（provider errorMessage 原文，内核 throw 路必携）
 * 提到 abortReason 之前——error 收尾时真实错误就是第一叙事，父会话 digest/blockers 不再只剩
 * 泛化文案（事故实证：trace 只见兜底语、provider "terminated" 全丢）。其余终态取词次序旧语义不动
 * （aborted 等仍 abortReason 优先——compaction restart 等策略 abort 的 reason 是用户可见叙事）。
 */
function summaryToLaunchResult(summary: RunSummary): RunLaunchResult {
  if (summary.reason === "done") {
    const text = messageText(summary.lastMessage);
    return {
      status: "done",
      digest: text !== "" ? text : "(sub-agent produced no text output)",
      pointers: [],
      blockers: [],
      usage: summary.usage,
    };
  }
  const why = summary.reason === "error"
    ? summary.error?.message ?? summary.abortReason ?? summary.reason
    : summary.abortReason ?? summary.error?.message ?? summary.reason;
  return {
    status: "failed",
    digest: `failed：子会话未经收束终止（${why}）`,
    pointers: [],
    blockers: [`termination:${summary.reason}`, `detail:${String(why)}`],
    usage: summary.usage,
  };
}

/**
 * 装配 `task` 工具。异步仅为保留既有调用面：正文不再启动期预载，
 * 子会话构造期经 `loadSystemPromptSync()` 现读（文件改了下次 spawn 即生效）。
 */
export async function createTaskTool(opts: TaskToolOptions): Promise<TaskToolHandle> {
  if (opts.agentTypes.length === 0) {
    throw new Error("createTaskTool: agentTypes must not be empty");
  }
  // W17-E 派发面过滤：kind:main 是主会话人格声明极，不是可派发子智能体——
  // 枚举/描述表/路由 specs/后台查表四处同源剔除（缺一处即泄漏派发面）。
  // 全 main = 无可派发面，属配置错误，与空表同族 fail-loud。
  const dispatchable: readonly AgentTypeDef[] = opts.agentTypes.filter((d) => d.kind !== "main");
  if (dispatchable.length === 0) {
    throw new Error(
      "createTaskTool: no dispatchable agent types (all entries are kind:main persona declarations)",
    );
  }
  const limits = opts.limits ?? DEFAULT_SUBAGENT_LIMITS;
  assertValidSubagentLimits(limits);

  const retain = opts.retain ?? true;
  const registry = retain
    ? new SubAgentRegistry({
        ...(opts.registry?.maxRetained !== undefined
          ? { maxRetained: opts.registry.maxRetained }
          : {}),
        ...(opts.registry?.ttlMs !== undefined ? { ttlMs: opts.registry.ttlMs } : {}),
      })
    : null;

  // 在飞子计数：横向闸的并发语义载体。JS 单线程 + execute 入口同步「先检查后自增」，
  // 无竞态；finally 必自减（abort/error 路径同样回收，不留 ghost in-flight）。
  // W9 切片 2：注入 fanout（内核在飞册）时本局部变量退役——计数改池读、入册改构造点、
  // 出册仍在 finally；两路径语义见 TaskToolOptions.fanout 注释。
  const fanout = opts.fanout;
  const subBackground = opts.subBackground;
  let inFlight = 0;
  let parentAbortBound = false;

  // W9 切片 3 决策：构建漏斗统一抽 constructChild——同步（vendored sessionFactory）与
  // 后台分支走**同一函数**（factory→id 守卫→入册→start 回调），杜绝两条构建路径漂移；
  // 同步路径行为逐字节不变（纯函数抽取）。
  const constructChild = (
    def: AgentTypeDef,
    task: string,
    ctx: HookContext,
    onConstructed: (id: string) => void,
    title: string,
  ): AgentSession => {
    const sub = opts.childSessionFactory
      ? opts.childSessionFactory(def, task, ctx)
      : buildDefaultChild(def);
    // 前端契约守卫：id 必须匹配无连字符白名单（含连字符 = 破坏 task_metadata 反解）。
    if (!SUBAGENT_ID_RE.test(sub.id)) {
      throw new Error(
        `task: sub-agent id "${sub.id}" violates ${SUBAGENT_ID_RE.source} ` +
          "(childSessionFactory must use newSubagentSessionId())",
      );
    }
    // 子构建即入册（id 闸后：脏 id 不入账）。与入口检查同帧完成 → 并发批窗口=旧语义。
    onConstructed(sub.id);
    // Start 回调（直接注入通路；hook 通路 fireSubagentStart 在 vendored 管线内并行存在）。
    void opts.onSubagentStart?.({
      agentId: sub.id,
      agentType: def.type,
      task,
      depth: currentDepth(ctx) + 1,
      title,
    });
    return sub;
  };

  const buildSpecs = (onConstructed: (id: string) => void, title: string): AgentSpec[] =>
    dispatchable.map((def) => ({
      type: def.type,
      whenToUse: def.description,
      sessionFactory: (task: string, ctx: HookContext): AgentSession =>
        constructChild(def, task, ctx, onConstructed, title),
    }));

  const buildDefaultChild = (def: AgentTypeDef): AgentSession => {
    const model = opts.resolveModel?.(def) ?? opts.model;
    if (model === undefined) {
      throw new Error(
        `createTaskTool: no model for agent type "${def.type}" (set opts.model or opts.resolveModel)`,
      );
    }
    // W9 切片 1：spawn 动作改道内核唯一工厂（raw-summary 档案；构造逐字节不变）。
    return buildSubSession({
      model,
      sessionId: newSubagentSessionId(),
      systemPrompt: def.loadSystemPromptSync(),
      tools: opts.childTools?.(def) ?? [],
      ...(opts.subMaxTurns === undefined ? {} : { maxTurns: opts.subMaxTurns }),
    });
  };

  /**
   * W9 切片 3 后台派发（execute 的 background:true 分支）：三闸 → 同漏斗构建子会话 →
   * 内核 durable 账本开火（expected-before-fire 同铁律）→ **即返状态块**（不 await 子完成）。
   * 决策：
   * - 出池点从同步面的 finally 迁到内核账本终态（onTerminalLocal）——后台在飞=账本在册，
   *   fanout 池与 durable 册同生同灭（跨门面封顶语义连续，切片 2 论证的迁移兑现）。
   * - depth 注入/Start·End 回调/registry retain 与同步面对齐：injector hook 逐字同 vendored
   *   spawnSubAgent 形（不 import 其私有常数=路由层零改动，两处同形有注释锚）；
   *   fireSubagent* 观察钩 fire-and-forget（后台立身之本=不 await 观察面，fail-soft 吞错）。
   * - 拒绝文案 task: 前缀（后台不经 vendored 管线，其 subAgent: 前缀不适用；闸语义逐字同构）。
   */
  async function runInBackground(
    args: Record<string, unknown>,
    ctx: HookContext,
    task: string,
    title: string,
  ): Promise<ToolExecResult> {
    if (subBackground === undefined || fanout === undefined) {
      throw new Error(
        "task: background mode requires the kernel task ledger (subBackground+fanout wiring); not wired in this assembly",
      );
    }
    const agentType = typeof args.agent_type === "string" ? args.agent_type : "";
    const def = dispatchable.find((d) => d.type === agentType);
    if (def === undefined) {
      throw new Error(
        `task: unknown agent_type "${agentType}" (expected one of: ${dispatchable.map((d) => d.type).join(", ")})`,
      );
    }
    // 总量闸（现读，热载口径同横闸）：后台账本在册非终态到顶 → fail-loud 不排队。
    const capTotal = limits.maxInflightTotal ?? DEFAULT_MAX_INFLIGHT_TOTAL;
    const inLedger = subBackground.subActiveCount();
    if (inLedger >= capTotal) {
      throw new Error(
        `task: inflight-total limit (maxInflightTotal=${capTotal}) reached (${inLedger} in flight)`,
      );
    }
    // 纵闸（同步路径由 vendored 管线把守；后台自守，语义同 #45：depth>=maxDepth 拒）。
    const depth = currentDepth(ctx);
    if (depth >= limits.maxDepth) {
      throw new Error(`task: depth limit (maxDepth=${limits.maxDepth}) reached`);
    }
    let backgroundId: string | null = null;
    const sub = constructChild(def, task, ctx, (id) => {
      fanout.register(id);
      backgroundId = id;
    }, title);
    // 纵深透传：与 vendored spawnSubAgent 的 depthInjector hook 同形（name/internal/key 逐字）。
    sub.use({
      name: "subAgent.depth-injector",
      internal: true,
      onSessionStart(_input, subCtx) {
        subCtx.state.set("subAgent.depth", depth + 1);
      },
    });
    // O5 观察钩对：start 即发（fire-and-forget，观察面绝不阻塞派发）。
    void ctx.fireSubagentStart({ agentId: sub.id, task, depth: depth + 1 }).catch(() => {});
    const taskId = (opts.newTaskId ?? defaultRunId)();
    const row: RunRow = {
      run_id: taskId,
      workflow: `subagent.${def.type}`,
      attempt: 1,
      trigger: "manual",
      parent_run: null,
      session_id: sub.id,
    };
    // 终态整形词表（raw-summary 档案）：done→正文文本（vendored subAgentResult 同款兜底语）；
    // 其余 reason（aborted/max_turns/error…）→ failed+digest 说明，绝不伪装成功。
    let finalSummary: RunSummary | undefined;
    const handle = subBackground.dispatchSubBackground({
      row,
      agentType: def.type,
      task,
      title,
      parentSessionId: ctx.sessionId,
      depth: depth + 1,
      deadlineMs: limits.backgroundDeadlineMs ?? DEFAULT_BACKGROUND_DEADLINE_MS,
      run: async (runSignal) => {
        const summary = await sub.run(task, { signal: runSignal });
        finalSummary = summary;
        return summaryToLaunchResult(summary);
      },
      onTerminalLocal: () => {
        // 盖棺后本地观察链：出池（账本终态=在飞终结）→ retain（首轮跑完即留，同同步时点）
        // → End 回调（TaskEndEvent 词表：终态 reason 由 RunSummary 供，崩溃回落 error 兜底形）。
        if (backgroundId !== null) fanout.release(backgroundId);
        registry?.retain(sub);
        const s = finalSummary;
        const reason = s?.reason ?? "error";
        // W42a：error 终态无正文时 summaryText 退携 provider 错误文本——trace 的
        // failure.reason 直接消费 summaryText，兜底/泛化文案不得吃掉排障线索。
        const text = s === undefined
          ? ""
          : messageText(s.lastMessage) || (s.reason === "error" ? (s.error?.message ?? "") : "");
        void opts.onSubagentEnd?.({
          agentId: sub.id,
          agentType: def.type,
          task,
          depth: depth + 1,
          reason,
          turns: s?.turns ?? 0,
          ...(s !== undefined ? { usage: s.usage } : {}),
          ...(text.length > 0 ? { summaryText: text } : {}),
        });
        void ctx.fireSubagentEnd({
          agentId: sub.id,
          task,
          depth: depth + 1,
          reason,
          turns: s?.turns ?? 0,
          // 崩溃兜底形与 vendored spawnSubAgent finally 同构（zero usage 占位=无真实终态数据）。
          usage: s?.usage ?? ZERO_USAGE,
          ...(text.length > 0 ? { summaryText: text } : {}),
        }).catch(() => {});
      },
    });
    // 状态块：<task_metadata> 既有五键同形 + title 块首行 + 三 additive 行（task_id/status/mode）——
    // 前端与 parseTaskMetadata 逐行宽容，additive 安全（精确 5 行正则只咬同步面回灌）。
    const meta = [
      TASK_METADATA_OPEN,
      `title: ${title}`,
      `agent_type: ${def.type}`,
      `session_id: ${sub.id}`,
      "reason: running",
      "turns: 0",
      `depth: ${depth + 1}`,
      `task_id: ${handle.taskId}`,
      "status: running",
      "mode: background",
      TASK_METADATA_CLOSE,
    ].join("\n");
    return {
      content: [
        {
          type: "text",
          text:
            `已派发后台任务（不等待结果）：task_id=${handle.taskId} status=running mode=background。\n` +
            `完成前查状态：GET /tasks/${handle.taskId}；完成后取件：task_fetch(session_id="${sub.id}") 或 task_fetch(task_id="${handle.taskId}")。\n\n` +
            meta,
        },
      ],
      details: { subAgent: { sessionId: sub.id, reason: "running", turns: 0, task_id: handle.taskId } },
    };
  }

  const tool: HarnessTool = {
    name: opts.name ?? "task",
    description:
      (opts.description ??
        "Delegate a self-contained sub-task to a bounded sub-agent; the sub-agent runs to a terminal state and its final answer is returned to you as this tool result.") +
      "\n\nMultiple task calls in one assistant message run in parallel (bounded by the configured fan-out limit).",
    parameters: Type.Object({
      agent_type: Type.Union(
        dispatchable.map((d) => Type.Literal(d.type)),
        {
          description:
            "Which kind of sub-agent to route this task to. " +
            dispatchable.map((d) => `${d.type}: ${d.description}`).join("; "),
        },
      ),
      task: Type.String({
        description: "A self-contained task for the chosen sub-agent to carry out.",
      }),
      // W9 切片 3：后台派发开关（additive；缺省 false=今日同步行为逐字节不变）。
      background: Type.Optional(
        Type.Boolean({
          description:
            "true = fire-and-forget: return immediately with task_id (status via /tasks, fetch result later with task_fetch(task_id=...)). Default false = run to completion synchronously.",
          default: false,
        }),
      ),
      // W49.2：人读标题（additive；缺省 derived=任务正文前 40 码点兜底）。
      title: Type.Optional(
        Type.String({
          description:
            "简短人读标题（≤40字，用于子会话列表区分，建议含日期/时段/目的）。缺省将用任务正文前 40 字兜底。",
        }),
      ),
    }),
    // 同 message 内多个 task 调用可并行（kernel safe 段 Promise.all）——横向闸在 execute 入口现读。
    isConcurrencySafe: () => true,

    async execute(args, ctx, signal) {
      assertValidSubagentLimits(limits);
      const task = typeof args.task === "string" ? args.task : "";
      if (task.trim().length === 0) {
        throw new Error("task: empty task");
      }
      // W49.2 标题一次算定：显式（折叠空白后非空）优先，否则 derived 兜底；
      // 各下游载体（Start 事件/后台登记与账本/状态块/前台块显式行）共用**同一字符串**。
      const explicitTitle = collapseWs(typeof args.title === "string" ? args.title : "");
      const derivedTitle = explicitTitle !== "" ? explicitTitle : deriveTitle(task);
      // 横向闸（事件时刻现读，计数源=注入池或局部变量）：到顶 → fail-loud 拒绝，不排队。
      const inflight = fanout ? fanout.count() : inFlight;
      if (inflight >= limits.maxFanout) {
        throw new Error(
          `task: fan-out limit (maxFanout=${limits.maxFanout}) reached (${inflight} in flight)`,
        );
      }
      // ── W9 切片 3：后台分支（派发即返状态块，不 await 子完成）──
      if (args.background === true) {
        return runInBackground(args, ctx, task, derivedTitle);
      }
      let countedLocally = false;
      // 池路径入册推迟到构造点（sessionFactory 内），与检查同帧——见 options.fanout 注释。
      let registeredId: string | null = null;
      if (!fanout) {
        inFlight++;
        countedLocally = true;
      }
      // 父 abort → 清空留存句柄（SubAgentRegistry 构造期拿不到父 signal，首派发时绑定一次）。
      if (registry && !parentAbortBound) {
        parentAbortBound = true;
        if (ctx.signal.aborted) {
          registry.clear();
        } else {
          ctx.signal.addEventListener("abort", () => registry.clear(), { once: true });
        }
      }
      const depth = currentDepth(ctx);
      const agentType = typeof args.agent_type === "string" ? args.agent_type : "";
      try {
        // 每次派发用**当前** Limits.maxDepth 现造路由管线（热载生效）；
        // maxSubAgents=1：vendored 累计闸退化为「本管线只许 spawn 一次」，真实横向闸在上面。
        const pipeline = routedSubAgentTool({
          specs: buildSpecs((id) => {
            if (fanout) {
              fanout.register(id);
              registeredId = id;
            }
          }, derivedTitle),
          ...(opts.name !== undefined ? { name: opts.name } : {}),
          maxSubAgents: 1,
          maxDepth: limits.maxDepth,
          ...(registry ? { onSpawn: registry.retain } : {}),
        });
        const result = await pipeline.execute(args, ctx, signal);
        // W49.2 前台块：title 行仅显式给定时加（缺省保持既有精确 5 行反解形状，字节保真）。
        return await withTaskMetadata(
          result,
          agentType,
          task,
          depth,
          explicitTitle !== "" ? derivedTitle : undefined,
        );
      } finally {
        // 出册点=子 run 终态的最早可观测帧（pipeline.resolve 之后），与今日 finally 同窗。
        if (fanout) {
          if (registeredId !== null) fanout.release(registeredId);
        } else if (countedLocally) {
          inFlight--;
        }
      }
    },
  };

  /** 结果整形：子正文尾部追加 `<task_metadata>` 字面块 + fire End 回调。 */
  async function withTaskMetadata(
    result: ToolExecResult,
    agentType: string,
    task: string,
    parentDepth: number,
    title?: string,
  ): Promise<ToolExecResult> {
    const info = extractSubAgentResultInfo(result.details);
    if (info === null) {
      // 非子终态形态（理论不可达：管线成功路径必带 details.subAgent）→ 原样回灌，不造假元数据。
      return result;
    }
    const depth = parentDepth + 1;
    const text = resultText(result);
    const meta = renderTaskMetadata({
      agentType,
      sessionId: info.sessionId,
      reason: info.reason,
      turns: info.turns,
      depth,
      ...(title !== undefined ? { title } : {}),
    });
    void opts.onSubagentEnd?.({
      agentId: info.sessionId,
      agentType,
      task,
      depth,
      reason: info.reason,
      turns: info.turns,
      ...(info.usage !== undefined ? { usage: info.usage } : {}),
      ...(text.length > 0 ? { summaryText: text } : {}),
    });
    return {
      content: [{ type: "text", text: `${text}\n\n${meta}` }],
      ...(result.isError !== undefined ? { isError: result.isError } : {}),
      details: result.details,
    };
  }

  return Object.freeze({ tool, registry, limits });
}
