/**
 * T31 serve 装配 —— 全栈组装与生命周期（createLoomApp + serveLoom + 信号优雅停机）。
 *
 * 装配链（docs/01 §10 五域；docs/02 §T31）：
 *   loom.yaml --loadServeConfig--> LoomConfig + HotConfigStore（基线 apply + config.applied 审计）
 *   models[]  --resolveServeModel--> 模型句柄（fake 通道：LOOM_FAKE_MODEL=1 或 provider: fake；
 *             真 provider：providers[]/models[].baseUrl +（providers[].apiKey 优先，
 *             否则 credentials 的 env 解析值）→ llmOptions.apiKey）
 *   workspace --createServeToolWiring--> 工具面单缝：七件套（文件类咽喉 resolveToolPath=
 *             workspace realpath 包含断言；bash=D7 ToolExecutor default-deny 单缝）同一数组
 *             同时进副会话端口与主会话 registry（同一缝、同一边界）；tool span 落 trace
 *   workspace --createSideBindingResolver--> 记忆注入：主会话 = AGENTS.md 单件前缀
 *             （W33 用户决策 2026-10-12，原慢→快五件退役为按需读取；T18 装配 plan 喂
 *             MainSessionLoop turn 边界）；副会话 = 角色 frontmatter.memory
 *             声明（task `agent:` 引用），无引用只 AGENTS.md 基础集
 *   L0 state  --StateLayout--> ledger/{date}.jsonl（真 Ledger，fsync）+ trace/（task-api join）
 *   Router(tokens) += ops（/health /config /catalog/models /config/audit）
 *                   += session 域 + task 域 + 事件域 SSE（sseStreamHandler）
 *
 * 停机口径（任务冻结）：停止 accept（server.close）→ 逐会话 hub.close() 优雅 end 订阅流
 * → L0 flush 检查点 → exit 0；全程 5s 硬上限，超时强制退出。
 * L0 写侧契约（T08 Journal / T21 Tracer / JsonlSessionStore）= append 即同步落盘
 * （Ledger 逐行 fsync），无内存缓冲可丢——"flush"在此是**核验点而非搬运**：
 * 打印账本缺口数（D15 expected-without-actual = T13 对账输入），如实留痕后放行退出。
 *
 * 深度协议语义（收束/回执/事件全谱）归 T38；本模块只保证"装得起来、拆得干净"。
 */

import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";

import { JsonlSessionStore, RotatingLedger, StateLayout } from "@axeuh/loom-adapters";
import type { HarnessTool, NudgeObservation, WireRequestSnapshot } from "@axeuh/loom-core";
import { DEFAULT_LIMITS, FLOW_LIMITS, type FlowLimits, type Limits } from "@axeuh/loom-core";
import { ControlPlane, MemoryControlAudit } from "@axeuh/loom-core/control";
import { MemoryPauseAudit, PauseAdmission, PauseSwitchBoard } from "@axeuh/loom-core/pause";
import { createSideSessionPort, RunEngine } from "@axeuh/loom-core/run-engine";
import type { RunEngineOptions, RunLaunchContext, RunRecord, RunRow, RunSessionPort } from "@axeuh/loom-core/run-engine";
import { SpawnKernel } from "@axeuh/loom-core/kernel";
import {
  createFsAssemblyReader,
  memorySourceContractRelaxed,
  resolveMemorySources,
  SKILLS_CATALOG_REL_PATH,
  type AssemblyPlan,
  type ContextFileSeed,
} from "@axeuh/loom-core/assembly";

import type { LoomConfig } from "../config/loom-config.js";
import {
  createFlowObservationSink,
  JsonFlowStore,
  type WakeObservationInput,
} from "../flow/index.js";
import type { HotConfigStore } from "../hotreload/index.js";
import { HttpError, Router, readJsonBody, sendJson } from "../http/index.js";
import { registerOpsRoutes } from "../ops-api/index.js";
import {
  assembleContextManifest,
  registerSessionRoutes,
  SessionRegistry,
  type ContextManifest,
} from "../session-api/index.js";
import type { WakeQueueEntryLike } from "../session-api/types.js";
import { registerTaskRoutes } from "../task-api/index.js";
import type { TaskSurfaceSource } from "../task-api/types.js";
import { createToolOutputStream, sseStreamHandler, type ToolOutputStream, type ToolOutputSink } from "../events/index.js";
import { JsonMasterPlanStore } from "../plan/json-master-plan-store.js";
import { JsonPlanOverlayStore } from "../plan/json-plan-overlay-store.js";
import { PlanLedger } from "../plan/plan-ledger.js";
import { PlanScheduler, type ReconcileReason, type ReconcileResult } from "../plan/plan-scheduler.js";
import { zonedDateKey } from "../plan/timezone.js";
import { renderWakeEntry } from "../plan/wake-render.js";
import { createAssemblyTraceWriter } from "./assembly-trace.js";
import { resolveMainSession } from "./main-session.js";
import {
  buildCompactionHooks,
  buildSessionCompactionOptions,
  resolveSummaryPerspectives,
} from "./compaction-wiring.js";
import { createCompactContextTool } from "./compact-tool.js";
import { createDeadLetterSink } from "./dead-letter-sink.js";
import { readConfigAudit, resolvePlanRoot } from "./config-source.js";
import { createCoverageVerifier } from "./coverage-verify.js";
import { createServeMcpWiring, type ServeMcpWiring } from "./mcp-wiring.js";
import { resolveServeModels, type ServeModelHandle, type ServeModelSet } from "./model-source.js";
import { createServeRunTrace } from "./run-trace.js";
import { createRunReminderRouter, type RunReminderRouter } from "./run-reminder.js";
import { createSideBindingResolver } from "./side-binding.js";
import { createServeSkillsWiring, type ServeSkillsWiring } from "./skills-wiring.js";
import { createSystemPromptResync } from "./system-prompt-resync.js";
import { createServeToolWiring, SERVE_SUB_MAX_TURNS, UnknownAgentModelError } from "./tool-wiring.js";
import { createPlanOverlayTool } from "./plan-overlay-tool.js";
import { autoWakeNotifyProps, WakeScheduler } from "./wake-scheduler.js";
import {
  toWakeEntry,
  WakeQueue,
  type WakeQueueEntry,
} from "./wake-queue.js";
import { WireCacheStore } from "./wire-cache.js";
import { SessionMetaStore } from "../session-meta.js";
import type { TodoUpdatedSink } from "./todo-tool.js";
import { handleHarnessUiRequest } from "./harness-ui.js";

/** W16 种子构造的 stat 观测：非普通文件 / IO 失败 = null（与 registry 嗅探同一 fail-soft 口径）。 */
function statForSeed(abs: string): { mtimeMs: number; size: number } | null {
  try {
    const st = statSync(abs);
    return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : null;
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 计划条目的日期键：调度器入队时已写 payload.date；外部写入的条目按 at 就地折算。 */
function planWakeDate(entry: WakeQueueEntry, timezone: string): string {
  const payload = isPlainRecord(entry.payload) ? entry.payload : {};
  const declared = payload["date"];
  return typeof declared === "string" && declared.length > 0
    ? declared
    : zonedDateKey(entry.at, timezone);
}

/**
 * 队列投递的 delivery.notify 字段。special 复用旧自动唤醒文案（逐字节）；
 * plan/flow 用来源标题，绝不让 registry 的缺省 PTY 文案误标计划/心流唤醒。
 */
function wakeNotifyProps(entry: WakeQueueEntry): Readonly<Record<string, unknown>> {
  if (entry.source === "special") return autoWakeNotifyProps(entry.at);
  const payload = isPlainRecord(entry.payload) ? entry.payload : {};
  const title =
    typeof payload["title"] === "string" && payload["title"].trim() !== ""
      ? payload["title"]
      : entry.id;
  if (entry.source === "plan") return { title: "计划唤醒", message: title, variant: "info" };
  return { title: "心流唤醒", message: title, variant: "info" };
}

/** 队列条目 -> 唤醒行：plan 走计划渲染，flow 由 registry 现算，special 保留旧自动唤醒文案。 */
function renderQueueWakeEntry(
  entry: WakeQueueEntry,
  timezone: string,
  flowLine: (at: number) => string | null,
  warn: (message: string, entry: WakeQueueEntry) => void,
): string | null {
  return renderWakeEntry(toWakeEntry(entry), {
    timezone,
    date: planWakeDate(entry, timezone),
    ...(entry.source === "flow"
      ? { renderFlow: (_entry: Parameters<typeof renderWakeEntry>[0], at: number) => flowLine(at) }
      : {}),
    warn: (message: string) => warn(message, entry),
  });
}

/** 优雅停机硬上限（毫秒）：超时视同完成直接退出（宁可截流，不可挂死）。 */
export const SHUTDOWN_TIMEOUT_MS = 5_000;

/** 宿主日志出口（与 RunEngineLog 同形；console 接线归 cli.ts，库不猜日志后端）。 */
export type ServeLog = (
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  fields: Record<string, unknown>,
) => void;

/** createLoomApp 输入（装配所需的全部外部事实，无隐式读取）。 */
export interface LoomAppOptions {
  readonly config: LoomConfig;
  readonly store: HotConfigStore;
  readonly stateRoot: string;
  readonly tokens: readonly string[];
  readonly version: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly log?: ServeLog;
  /**
   * W17-B manifest.configPath 数据源：cli.ts 的 resolveConfigPath 产物（CLI 参数 >
   * LOOM_CONFIG > 仓库缺省——解析真源在 cli，库层不猜）。缺省 = ""（诚实缺席：
   * 直调 createLoomApp 的测试/嵌入式装配未告知配置文件取址）。
   */
  readonly configPath?: string;
}

/** 装配产物：HTTP server + 停机时要拆的持有物。 */
export interface LoomApp {
  readonly server: Server;
  readonly registry: SessionRegistry;
  readonly model: ServeModelHandle;
  /**
   * W53 T3：models[] 全量句柄集（main + byId）。停机统一走 teardownAll()（覆盖全部句柄、
   * 幂等；main 已含其中）；model 字段保留 = main，兼容既有消费者。
   */
  readonly models: ServeModelSet;
  readonly ledger: RotatingLedger;
  readonly engine: RunEngine;
  /** W9 切片 2：进程唯一 SpawnKernel（在飞册/登记面观察口；测试与运维取证用）。 */
  readonly kernel: SpawnKernel;
  /** 主/副会话共用的工具面（同一缝、同一边界；观测/取证面）。 */
  readonly tools: readonly HarnessTool[];
  /** W5-A skills 装配结局（loom.yaml 无 skills 段 = undefined；W25：entries/degraded 为活读面）。 */
  readonly skillsWiring: ServeSkillsWiring | undefined;
  /** W5-B MCP 装配结局（无 mcp 段 = 空面；单 server 失败在其 statuses 里留痕）。 */
  readonly mcpWiring: ServeMcpWiring;
  /**
   * W17-B 引用清单（W25 起为**现算面**：memory/mcp/角色段仍 boot 定值，
   * skillFiles 段随 loader 目录视图热重载即刻反映）；/context/full v2 的 manifest 块
   * 经 registerSessionRoutes deps 同源挂载；此处暴露供测试/运维取证。
   */
  readonly contextManifest: ContextManifest;
  /** L6 flow 真源（flow.enabled=false 时 undefined：零 store、零 flow 面）。 */
  readonly flowStore: JsonFlowStore | undefined;
  /** 停机扩展点：外部持有资源关停（当前 = MCP 子进程收尸；boot 停机序列消费，幂等）。 */
  closeExtras(): Promise<void>;
}

/**
 * 组装一棵完整 loom 服务树。零监听副作用（不 listen），失败一律响亮抛
 * （空 tokens / 真 provider 未接线 → 装配期即炸，好过起一个不可用服务）。
 */
export async function createLoomApp(options: LoomAppOptions): Promise<LoomApp> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  if (options.tokens.length === 0) {
    throw new Error("serve 装配失败：tokens 为空——Router 将拒绝一切请求，属部署错误");
  }

  const planRootResolution = resolvePlanRoot(options.config.plan?.root, env);
  if (planRootResolution.planRoot === undefined) {
    log("info", "loom plan tools disabled", { reason: planRootResolution.reason });
  } else {
    log("info", "loom plan tools enabled", {
      planRoot: planRootResolution.planRoot,
      source: planRootResolution.source,
    });
  }

  const models = resolveServeModels(options.config, env);
  const model = models.main;

  // 记忆注入解析器（B 面：workspace 角色自声明；构造即 realpath 归一，坏 workspace 装配期响亮）。
  // W35：实例级字节契约口径直通（undefined-honest——键缺席不物化，与 convergenceEnforced
  // 的 exactOptionalPropertyTypes 条件展开同纪律；"缺省⇒strict"只在下方日志面材料化）。
  const bindings = createSideBindingResolver({
    workspaceRoot: options.config.workspace,
    log,
    ...(options.config.server.sourceContract === undefined
      ? {}
      : { sourceContract: options.config.server.sourceContract }),
  });

  // W5 两线数据源（config 段缺省 = 不接；skills 配置级错误由 loader 响亮上抛）：
  //   skills: loader 的 hook 进主/副/子会话 system prompt catalog、tool 进 D7 单缝共用面；
  //   mcp:    每个 server spawn+握手+listTools → mcp_<server>_<tool> 映射进同一面，
  //           单 server 失败 = warn + 该面缺席（degrade 不 crash）；closeAll 挂停机序列。
  const skillsWiring =
    options.config.skills === undefined
      ? undefined
      : await createServeSkillsWiring({ allowlist: options.config.skills.allowlist, log });
  const mcpWiring = await createServeMcpWiring({
    servers: options.config.mcp?.servers ?? [],
    log,
    ...(skillsWiring === undefined
      ? {}
      : { reservedToolNames: [skillsWiring.tool.name] as readonly string[] }),
  });

  // L0 state 目录与会话 store（W9 切片0 决策：子/副会话转录进**第二个**独立实例
  // loom-sessions.jsonl——JsonlSessionStore 单文件天然多 sid（LogRecord 带 sid），
  // 同 sid 单写者由调用序保证（子 = 逐派发新 ses_ id，副 = 逐 run 账本 session_id）；
  // 主会话原实例与 loom-main.jsonl 一律不动，现网历史面冻结。
  // 块整体上移：tool 装配（childSessionStore 注入）先于引擎/registry 需要 store 句柄。
  const layout = new StateLayout({ root: options.stateRoot });
  layout.ensureDirs();
  // L6 flow 真源：段在场且 enabled=true 才构造（关机 = 零扫描零文件，旧行为逐字节）；
  // 构造即水合 stateRoot/session/{sid}/flow 下的主体文件，坏文件装配期响亮抛。
  const flowEnabled = options.config.flow?.enabled === true;
  const flowLimits: FlowLimits | undefined =
    options.config.flow?.limits === undefined
      ? undefined
      : { ...FLOW_LIMITS, ...options.config.flow.limits };
  const flowObservation = flowEnabled
    ? createFlowObservationSink({ stateRoot: options.stateRoot })
    : undefined;
  const flowStore = flowEnabled
    ? new JsonFlowStore({
        stateRoot: options.stateRoot,
        ...(flowLimits === undefined ? {} : { limits: flowLimits }),
        ...(flowObservation === undefined
          ? {}
          : {
              onUnset: (record): void => {
                flowObservation.observe({
                  type: "flow.unset",
                  session_id: record.session_id,
                  reason: record.reason,
                  turn_idx: record.turn_idx,
                });
              },
            }),
      })
    : undefined;
  const retireConverge = flowEnabled && options.config.flow?.retireConverge === true;
  // 缺口2 修复（用户拍板修代码）：账本写时按 UTC 日轮转分片，在线滚日不再冻结在启动日；
  // 读侧（rows/gaps）跨目录全分片——残账重启无需等"出窗"，对账器全量重扫即见。
  const ledger = new RotatingLedger({ dir: layout.dir("ledger") });
  const sessionStore = new JsonlSessionStore(join(layout.dir("session"), "loom-main.jsonl"));
  const loomSessionsStore = new JsonlSessionStore(join(layout.dir("session"), "loom-sessions.jsonl"));

  // W23-A 发线面持久缓存：state/session/wire/{sid}.json 每会话原子覆盖写（写前脱敏，
  // 密钥不落盘）。与 registry 成员资格无关——侧/子会话跑完重启后 context/full 仍可查。
  // 保存失败 = warn fail-soft（core 回调处另有第二层吞断，持久面缺席不反噬回合）。
  const wireCache = new WireCacheStore({
    dir: join(layout.dir("session"), "wire"),
    warn: (msg, fields) => log("warn", msg, fields),
  });
  const persistWire = (
    sid: string,
    snap: WireRequestSnapshot,
    payload: string | null,
  ): void => wireCache.save(sid, snap, payload);

  // W23-B 会话 meta sidecar（标题/归档/置顶跨重启面）：load-on-boot，坏文件=空表 fail-soft。
  const sessionMeta = new SessionMetaStore({
    file: join(layout.dir("session"), "meta.json"),
    warn: (msg, fields) => log("warn", msg, fields),
  });
  // W23-B createdAt 快照（重水化域=主 store）：转录首条 message 时间戳；读炸/无时间戳
  // 的 sid 不入表（registry #ensure 自然回落 now，诚实而非造 0）。
  const bootCreatedAt = new Map<string, number>();
  for (const sid of sessionStore.sessionIds()) {
    const ts = await sessionStore.earliestEntryTs(sid);
    if (ts !== null) bootCreatedAt.set(sid, ts);
  }

  // W11a 工具事件流（P0 输出实时流 + P1 三段跃迁 + P2 file.edited，见 events/tool-stream.ts）。
  // 双惰性（决策）：stream 造在 wiring 之后（file.edited 需要 workspaceReal）、resolveHub 指
  // registry（更后）；而 wiring 要 onOutput（更早）——用 let + 运行期箭头缝合，
  // onToolOutput 首次调用在任意 bash 执行时，两个 const 均已初始化，无 TDZ。
  let toolStream!: ToolOutputStream;
  const onToolOutput: ToolOutputSink = (site, chunk) => {
    toolStream.onOutput(site, chunk);
  };

  // W11b todowrite 上抛缝（决策）：注册表按 sid resolve hub 后 publish("todo.updated")；
  // properties = { sessionID(通道自动注入), todos }。未注册会话（task 派发子）hubOf
  // 缺席 = 事件不发但存储/返回照常（todo 权威面是会话状态，SSE 只是投影）。
  // 双惰性同 toolStream：sink 要 registry（更后构造），运行期首调必在装配完成后，无 TDZ。
  const onTodoUpdated: TodoUpdatedSink = (sessionID, todos) => {
    registry.hubOf(sessionID)?.publish("todo.updated", sessionID, { todos });
  };

  // trace 观测面收尾（T21 生产调用方）：run 开跑/催办/盖棺三类行 + 死信分片落盘。
  // W9 切片 2 上移（决策）：SpawnKernel 先于 toolWiring 构造（task 门面装配期要挂在飞册
  // 视图），三缝依赖（runTrace/deadLetters）随之提前——两者只依赖 stateRoot/log，无 wiring 依赖。
  const runTrace = createServeRunTrace({ stateRoot: options.stateRoot, log });
  const deadLetters = createDeadLetterSink({ stateRoot: options.stateRoot, log });

  // W12 副会话终态提醒（决策：复用 run-trace 的 onTerminal 缝做发射点）。
  // 双惰性同 toolStream：router 要 registry（更后），engine.onRunTerminal 要 router（更早）——
  // let + 运行期箭头缝合；onRunTerminal 首次调用在任何 HTTP dispatch 之后，必已初始化，无 TDZ。
  let runReminders!: RunReminderRouter;

  // 工具面单缝（同一数组进主/副会话；边界=workspace realpath，bash=D7 单缝 default-deny；
  // task 派发工具同缝接线——子会话模型/凭据经 model/llmOptions 注入，见 tool-wiring.ts；
  // W5 skill/mcp 工具与 catalog hooks 经 extraTools/extraHooks 进同一缝、同批包痕）。
  // W9 切片 1+2 装配序：kernel 先于两门面（RunEngine/toolWiring 都吃内核面）——
  // 在飞册 asFanout 须在 wiring 装配期注入；内核执行口却要 wiring.tools（更晚）→
  // let sideSessionPort + 运行期箭头缝合（toolStream 同款双惰性，首调必在装配完成后）。
  const board = new PauseSwitchBoard();
  let sideSessionPort!: RunSessionPort;
  const kernelOpts = {
    ledger,
    sessionPort: { run: (ctx: RunLaunchContext) => sideSessionPort.run(ctx) },
    admission: new PauseAdmission({ switches: () => board.read(), audit: new MemoryPauseAudit() }),
    deadLetterSink: deadLetters,
    onRunStarted: (row: RunRow) => runTrace.beginRun(row),
    onRunTerminal: (rec: RunRecord) => {
      runTrace.finishRun(rec);
      // W12：盖棺缝二消费——副会话终态提醒投主会话（router 内部 fail-soft，不反噬引擎）。
      runReminders.onTerminal(rec);
    },
    log,
  } satisfies RunEngineOptions;
  const kernel = new SpawnKernel(kernelOpts);

  // W37 单缝决策：/tasks HTTP 面（routes.ts tasksSrc：list/get/cancel）与 task_cancel 工具面
  // （tool-wiring opts.taskCancel）**共用同一适配器实例**——取消语义唯一真源 =
  // kernel.cancelSub（kernel.ts:409-419），本处是它的仓内唯一投影点（切片 3 的旧内联对象
  // 上移为命名 const，闭包体逐字节不变）。第二投影点 = 第二口径，禁。
  const taskSurface: TaskSurfaceSource = {
    list: () => kernel.listSubRuns(),
    get: (taskId) => kernel.getSub(taskId),
    cancel: (taskId, reason) => kernel.cancelSub(taskId, reason),
  };

  // pty 退出通知出口：wiring 早于 registry 构造（双惰性同 runReminders）——运行期首调
  // 必然发生在任意 HTTP 派发之后，届时 sink 已绑定；绑定前 no-op 安全。
  const ptyNotifySink: { deliver?: (ownerSessionId: string, line: string) => void } = {};

  // 自动唤醒出口：registry.onAutoWake 运行期才绑定 scheduler（双惰性同 ptyNotifySink）。
  const wakeSink: { arm?: (sessionID: string, at: number | null) => void } = {};

  // T11a 调度引擎（opt-in）：段缺席或两模式全 off = 下方旧 WakeScheduler/legacy plan 工具
  // 路径逐字节不变。live 计划唤醒只进持久队列，绝不旁路投递。
  const scheduling = options.config.scheduling;
  const wakeMode = scheduling?.wakeQueue ?? "off";
  const planMode = scheduling?.planScheduler ?? "off";
  const schedulingActive = wakeMode !== "off" || planMode !== "off";
  const schedulingTimezone = scheduling?.timezone ?? "Asia/Shanghai";
  const schedulingPlanRoot = planMode === "off" ? undefined : planRootResolution.planRoot;
  if (schedulingActive && planMode === "live" && wakeMode !== "live") {
    throw new Error(
      "scheduling.planScheduler=live 需要 scheduling.wakeQueue=live：计划唤醒必须进持久唤醒队列，绝不旁路投递",
    );
  }
  if (schedulingActive && planMode !== "off" && schedulingPlanRoot === undefined) {
    throw new Error(
      "scheduling.planScheduler 已启用但 planRoot 缺失：请配置 plan.root 或 LOOM_PLAN_ROOT（绝不猜 ai/data）",
    );
  }
  const configuredSchedulingSession = scheduling?.sessionId?.trim();
  // T2：主会话先于调度选主解析并落标记；后续 registry/调度回落共用同一 id。
  const mainSession = resolveMainSession({
    stateRoot: options.stateRoot,
    configMainSessionID: options.config.server.mainSessionId,
    schedulingSessionID: scheduling?.sessionId,
    sessionIDs: () => sessionStore.sessionIds(),
    log,
  });
  if (
    schedulingActive &&
    (configuredSchedulingSession === undefined || configuredSchedulingSession === "")
  ) {
    log("warn", "loom scheduling session fallback to main session", {
      sessionID: mainSession.sessionID,
      source: mainSession.source,
    });
  }
  const schedulingMainSessionID: string | undefined = schedulingActive
    ? configuredSchedulingSession !== undefined && configuredSchedulingSession !== ""
      ? configuredSchedulingSession
      : mainSession.sessionID
    : undefined;
  let wakeQueue: WakeQueue | undefined;
  let planScheduler: PlanScheduler | undefined;
  let planMasterStore: JsonMasterPlanStore | undefined;
  let planOverlayStore: JsonPlanOverlayStore | undefined;
  let schedulingLedger: PlanLedger | undefined;
  let overlayPlanTool: HarnessTool | undefined;
  let queueWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  let schedulingDegraded = false;
  let schedulingClosed = false;

  if (schedulingActive && schedulingMainSessionID !== undefined && wakeMode === "live") {
    const queueSessionID = schedulingMainSessionID;
    wakeQueue = new WakeQueue({
      stateRoot: options.stateRoot,
      sessionID: queueSessionID,
      now: () => Date.now(),
      render: (entry): string | null =>
        renderQueueWakeEntry(
          entry,
          schedulingTimezone,
          (at): string | null => registry.flowWakeLine(queueSessionID, at),
          (message, failed) => {
            log("warn", "loom wake render warning", { id: failed.id, message });
          },
        ),
      deliver: (sessionID, line, entry) => {
        registry.deliverWake(sessionID, line, wakeNotifyProps(entry));
      },
      hasSession: (sessionID) => registry.has(sessionID),
      observe: (event): void => {
        if (event.kind === "error" || event.kind === "corrupt") {
          schedulingDegraded = true;
          log("warn", "loom wake queue degraded", {
            kind: event.kind,
            ...(event.kind === "error" ? { operation: event.operation } : {}),
            ...(event.kind === "error" ? { message: event.message } : {}),
            ...(event.kind === "corrupt" ? { path: event.path } : {}),
          });
        }
      },
    });
  }

  if (
    schedulingActive &&
    schedulingMainSessionID !== undefined &&
    schedulingPlanRoot !== undefined &&
    planMode !== "off"
  ) {
    planMasterStore = new JsonMasterPlanStore({ planRoot: schedulingPlanRoot });
    const overlayStore = new JsonPlanOverlayStore({
      planRoot: schedulingPlanRoot,
      master: planMasterStore,
    });
    planOverlayStore = overlayStore;
    const planLedger = new PlanLedger({ planRoot: schedulingPlanRoot });
    schedulingLedger = planLedger;
    const coverageVerifier = createCoverageVerifier({
      pythonBin: env["LOOM_PYTHON"]?.trim() || "python3",
      scriptPath: join(schedulingPlanRoot, "..", "analysis", "check_coverage.py"),
    });
    planScheduler = new PlanScheduler({
      masterStore: planMasterStore,
      overlayStore,
      ...(wakeQueue === undefined ? {} : { queue: wakeQueue }),
      mainSessionId: schedulingMainSessionID,
      timezone: schedulingTimezone,
      ...(scheduling?.watchdogMs === undefined ? {} : { watchdogMs: scheduling.watchdogMs }),
      ...(scheduling?.horizonHours === undefined
        ? {}
        : { horizonHours: scheduling.horizonHours }),
      ...(scheduling?.catchupMaxAgeHours === undefined
        ? {}
        : { catchupMaxAgeHours: scheduling.catchupMaxAgeHours }),
      ...(scheduling?.debtAfterHours === undefined
        ? {}
        : { debtAfterHours: scheduling.debtAfterHours }),
      shadow: planMode === "shadow",
      stateRoot: options.stateRoot,
      observe: (event): void => {
        if (
          event.kind === "error" ||
          event.kind === "master_error" ||
          event.kind === "queue_error" ||
          event.kind === "overlay_error"
        ) {
          schedulingDegraded = true;
          log("warn", "loom plan scheduler degraded", {
            kind: event.kind,
            ...(event.kind === "error" ? { operation: event.operation } : {}),
            ...(event.kind === "error" ? { message: event.message } : {}),
          });
        }
      },
    });
    if (planMode === "live") {
      overlayPlanTool = createPlanOverlayTool({
        overlayStore,
        master: planMasterStore,
        ledger: planLedger,
        verifier: coverageVerifier,
      });
    }
  }

  if (schedulingActive && schedulingMainSessionID !== undefined && wakeMode === "live") {
    const queueSessionID = schedulingMainSessionID;
    let convergeTail: Promise<void> = Promise.resolve();
    wakeSink.arm = (sessionID, at): void => {
      if (sessionID !== queueSessionID) {
        log("warn", "loom converge wake target mismatch (queue is main-session only)", {
          sessionID,
        });
        return;
      }
      const queue = wakeQueue;
      if (queue === undefined) return;
      convergeTail = convergeTail
        .then(async () => {
          const existing = (await queue.snapshot()).entries.filter(
            (entry) => entry.source === "special",
          );
          if (at === null) {
            for (const entry of existing) await queue.cancel(entry.id);
            return;
          }
          const keepID = `special:converge:${String(at)}`;
          for (const entry of existing) {
            if (entry.id !== keepID) await queue.cancel(entry.id);
          }
          if (existing.some((entry) => entry.id === keepID)) return;
          await queue.enqueue({
            id: keepID,
            source: "special",
            action: "special.continue",
            at,
            payload: { title: "自动唤醒", at },
          });
        })
        .catch((error: unknown) => {
          schedulingDegraded = true;
          log("warn", "loom converge wake enqueue failed", { error: errorText(error) });
        });
    };
  }

  let compactSessionResolver: ((sessionID: string) => import("@axeuh/loom-core").AgentSession | undefined) =
    () => undefined;
  const compactContextTool = createCompactContextTool({
    resolveSession: (sessionID) => compactSessionResolver(sessionID),
  });

  const toolWiring = await createServeToolWiring({
    workspaceRoot: options.config.workspace,
    stateRoot: options.stateRoot,
    model: model.model,
    llmOptions: model.llmOptions,
    // W53 T3 per-agent 路由：agent 声明 model: 时按 config id 取句柄；未知 id 抛
    // UnknownAgentModelError（派发期响亮拒绝，绝不静默回落主模型）。未声明 model 的
    // agent 不进入本回调，仍走 childSessionFactory 的旧继承路径（opts.model）。
    modelByAgent: (def) => {
      const modelId = def.model;
      if (modelId === undefined) return undefined;
      const handle = models.byId.get(modelId);
      if (handle === undefined) {
        throw new UnknownAgentModelError(def.type, modelId, [...models.byId.keys()]);
      }
      return { model: handle.model, llmOptions: handle.llmOptions };
    },
    knownModelIds: [...models.byId.keys()],
    log,
    // W11a P0：bash 执行期输出 chunk 上抛事件面（tee 旁路，vendor 口径不动）。
    onToolOutput,
    // W9 切片0：子会话转录落盘恒挂（同步/后台同一工厂，见 tool-wiring childSessionFactory）。
    childSessionStore: loomSessionsStore,
    // W11a3：task_fetch 取件面（读侧速行版）——与 childSessionStore 同一实例，写读成对；
    // 主/副/子会话共用同一只读取件口（trace.wrapAll 自动包痕，见 tool-wiring.ts）。
    taskFetchStore: loomSessionsStore,
    // W11b：todowrite 计划面（整表替换 + todo.updated 事件，见 todo-tool.ts 文件头决策）。
    onTodoUpdated,
    // pty 退出通知：双惰性箭头指 registry.deliverWake（registry 构造在下方；
    // 绑定前 no-op 安全）。durable 队列路径：空闲 → 立即起轮；忙 → 当前轮收尾后起新轮。
    onPtyExit: (ownerSessionId, line) => ptyNotifySink.deliver?.(ownerSessionId, line),
    // pty 段透传（同 sandbox 条件展开纪律：键缺席不物化 = tool-wiring 按缺省启用）。
    ...(options.config.pty === undefined ? {} : { pty: options.config.pty }),
    // GAP-3/GAP-4：显式 planRoot 才挂 plan/long_task（LOOM_PLAN_ROOT > plan.root；
    // 缺省不传 = 两工具不挂面，boot 已在函数头 info 行说明 disabled 原因）。
    ...(planRootResolution.planRoot === undefined
      ? {}
      : { planRoot: planRootResolution.planRoot }),
    // T11a：planScheduler=live 时用 T07 覆盖层工具顶替 legacy plan 工具（long_task 不动）。
    ...(overlayPlanTool === undefined ? {} : { planTool: overlayPlanTool }),
    // W9 切片 2：task 横闸在飞册=内核视图（主/副/子跨门面共享一池；内核入口=kernel 单例）。
    fanout: kernel.asFanout(),
    // W9 切片 3：后台派发口与 task_fetch 双索引都从内核切（进程单例，kernelOpts 装配序见上）。
    kernel,
    // W37：task_cancel 取消口 = /tasks HTTP 路由同一 taskSurface 实例（单缝见 const 处注释）。
    taskCancel: taskSurface,
    // W23-A 子会话发线面持久（同步/后台同一工厂恒挂，见 tool-wiring childSessionFactory）。
    onWireSnapshot: persistWire,
    // W4：bash.shell 直投 D7 缝（未配置 = 平台默认 /bin/bash，行为差异见 seam-process 文件头公告）。
    ...(options.config.bash?.shell === undefined ? {} : { bashShell: options.config.bash.shell }),
    // W36：sandbox 段透传工具面（档案 net/deny + 文件工具 containment）。条件展开 =
    // exactOptionalPropertyTypes 纪律（键缺席不物化；缺省收敛在 tool-wiring 与下方日志面）。
    ...(options.config.sandbox === undefined ? {} : { sandbox: options.config.sandbox }),
    // W40：后台 deadline 秒值透传（声明才给；键缺席 = 不物化，core 15min 现读缺省面
    // 逐字节不变——同款条件展开纪律，写进 tool-wiring 的可变 limits 对象即派发时刻生效）。
    ...(options.config.subagent?.backgroundDeadlineSeconds === undefined
      ? {}
      : { subagentBackgroundDeadlineSeconds: options.config.subagent.backgroundDeadlineSeconds }),
    // W42c 派发闸三键透传（同 W40 逐键条件展开纪律：声明才给，缺席 = 不物化 =
    // tool-wiring 不覆写 = task 工具可变 limits 对象保冻结值 8/2/不写 现读兜 16）。
    ...(options.config.subagent?.maxFanout === undefined
      ? {}
      : { subagentMaxFanout: options.config.subagent.maxFanout }),
    ...(options.config.subagent?.maxDepth === undefined
      ? {}
      : { subagentMaxDepth: options.config.subagent.maxDepth }),
    ...(options.config.subagent?.maxInflightTotal === undefined
      ? {}
      : { subagentMaxInflightTotal: options.config.subagent.maxInflightTotal }),
    // W59 子会话轮数闸透传（同 W40/W42c 逐键条件展开纪律：声明才给，缺席 = 不物化 =
    // tool-wiring 回落 SERVE_SUB_MAX_TURNS=50）。构造期一次定值，改配置须重启。
    ...(options.config.subagent?.maxTurns === undefined
      ? {}
      : { subagentMaxTurns: options.config.subagent.maxTurns }),
    extraTools: [
      compactContextTool,
      ...(skillsWiring === undefined ? [] : [skillsWiring.tool]),
      ...mcpWiring.tools,
    ],
    ...(skillsWiring === undefined ? {} : { extraHooks: [skillsWiring.hook] }),
  });
  toolStream = createToolOutputStream({
    resolveHub: (sessionId) => registry.hubOf(sessionId),
    workspaceRoot: toolWiring.workspaceReal,
  });

  // W36 沙箱策略留痕（与 roster/contract 同族 info 行）：`?? 缺省` 是**全仓唯一**的缺省
  // 材料化点，且只供本日志面观测——schema/tool-wiring 保持 undefined-honest（W35 纪律镜像）。
  // 缺省 = {containment:"strict"（文件工具围栏在）, net:"allow"（缝不拦网络）, denies:0（引擎空转）}。
  log("info", "loom sandbox policy", {
    containment: options.config.sandbox?.containment ?? "strict",
    net: options.config.sandbox?.net ?? "allow",
    denies: options.config.sandbox?.deny?.length ?? 0,
  });

  // 主会话 T18 装配 plan：段1 = 注入清单（缺省语义 2，W34 声明转正：kind:main frontmatter
  // `memory:` 声明非空即用（声明序走 gatherSources 单链）；未声明 = MAIN_SESSION_GLOBS
  // 兜底仅 AGENTS.md 单件（W33 用户决策 2026-10-12 形态，W14 月度 fact 出走前缀的历史口径
  // 见 memory-declaration 常量注释）。
  // boot 期展开一次，清单=声明序分组 ⇒ 前缀字节跨轮/跨会话恒定）。
  // reader 历史面传 null：主会话转录走 JsonlSessionStore（非 SessionShards 布局），增量行数
  // 由 increment 段的 prompt/reminder 呈现，装配 span 的记忆注入证明取 memory 段（见 smoke/测试）。
  //
  // W17-E 主次声明绑定：workspace 角色文件 frontmatter kind:main = 主智能体人格声明极。
  // 身份框 = 按清单序（toolWiring 一次扫描序）取**首个** main 文件的正文（去 frontmatter，
  // 方法 = AgentTypeDef.loadSystemPrompt 唯一口径：重读盘 → parseMdFrontmatter.body）。
  // 多 main → 取首 + warn 留痕；无 main → 占位文案逐字不变（现状保真，旧工作树字节全等）。
  // 前缀字节跨 boot 位移是声明引入的**预期**变更（W16-B 口径）；单 boot 内 plan 静态，
  // W15-B 跨轮恒定不受影响。渲染链不动：mainPlan.systemPrompt → renderAssemblyPrefix 段0 自动换血。
  const personaDefs = toolWiring.agentTypeDefs.filter((d) => d.kind === "main");
  if (personaDefs.length > 1) {
    log("warn", "loom multiple main persona declarations (first wins)", {
      files: personaDefs.map((d) => d.file ?? d.type),
    });
  }
  const personaDef = personaDefs[0];
  const personaBody = personaDef === undefined ? undefined : await personaDef.loadSystemPrompt();
  if (personaDef !== undefined) {
    log("info", "loom main persona bound", { file: personaDef.file ?? "", type: personaDef.type });
  }
  // W34：kind:main 的 memory 声明喂主会话清单（undefined/空 = 兜底，见 side-binding）。
  const declaredMainGlobs = personaDef?.memoryGlobs ?? [];
  const mainPlan: AssemblyPlan = {
    systemPrompt: personaBody ?? "你是 loom 主会话。",
    memorySources: bindings.mainSessionMemorySources(declaredMainGlobs),
    workflows: [],
  };
  // systemPrompt/memory 重读：session-start 与 compaction 时重读 persona + 注入源；
  // 无 kind:main 声明 = 冻结 boot plan.systemPrompt（loadPersona 缺省），memory 仍重读。
  //
  // 取数走 boot roster 的**精确路径**而非再次 `mainSessionMemorySources(globs)`：
  // expandMemoryGlobs 对每条 glob 都全工作区 walk（ai/ 实测量级 4s/次），而 resync
  // 需双快照，2000ms 预算内必然超时；roster 本身已是 boot 期 glob 展开的声明序结果，
  // 这里只重读同样 6 个路径并复用同一 sourceContract 校验。声明变更/新 glob 命中
  // 不在本重读范围（与 persona memory 声明不重扫的既定边界一致）。
  const sourceContract = options.config.server.sourceContract;
  const memoryRosterPaths = mainPlan.memorySources.map((source) => source.source);
  const systemPromptResync = createSystemPromptResync({
    workspaceRoot: toolWiring.workspaceReal,
    plan: mainPlan,
    ...(personaDef?.file === undefined ? {} : { personaFile: personaDef.file }),
    ...(personaDef === undefined ? {} : { loadPersona: () => personaDef.loadSystemPrompt() }),
    loadMemorySources: () => {
      const reader = createFsAssemblyReader({
        workspaceRoot: toolWiring.workspaceReal,
        shards: null,
      });
      return sourceContract === "off"
        ? resolveMemorySources(reader, memoryRosterPaths, memorySourceContractRelaxed).sources
        : resolveMemorySources(reader, memoryRosterPaths).sources;
    },
    log,
  });
  // roster 留痕（与 "loom main persona bound" 同族 info 行）：来源 = 声明/兜底、件数、
  // 实载字节（degrade 占位件不计——与 contextSeedFiles 的 bootHash 只认真载同口径）。
  log("info", "loom main memory roster", {
    count: mainPlan.memorySources.length,
    bytes: mainPlan.memorySources.reduce(
      (n, s) => n + (s.degrade === null ? Buffer.byteLength(s.content, "utf8") : 0),
      0,
    ),
    source: declaredMainGlobs.length > 0 ? "declared" : "fallback",
  });
  log("info", "loom system prompt resync wired", {
    source: personaDef === undefined ? "fallback" : "declared",
  });
  // W35 字节契约口径留痕（与 roster 同族 info 行）：`?? "strict"` 是**全仓唯一**的缺省
  // 材料化点，且只供本日志面观测——resolver/core 保持 undefined-honest、schema 不造假值
  // （W26 convergenceEnforced 纪律镜像，用户 2026-10-14 决策）。off 仅豁免易变时间戳条款，
  // NUL/二进制闸两模式恒在。
  log("info", "loom memory source contract", {
    mode: options.config.server.sourceContract ?? "strict",
  });
  // W40 后台子智能体 deadline 留痕（与 contract/sandbox 同族 info 行，W35 放置风格镜像）：
  // `?? 900` 只是**本日志面**的缺省重述（= core DEFAULT_BACKGROUND_DEADLINE_MS=15*60*1000ms
  // 逐字节等价）——schema/boot 透传/tool-wiring 写字段全链保持 undefined-honest：键缺席
  // 不写 limits 字段，task-tool 派发时刻 `??` 兜常量（现读机制 core 侧，不在此处物化）。
  // 生效=改配置+重启（与 sourceContract/sandbox/convergenceEnforced 同纪律，无热重载通道）。
  log("info", "loom subagent deadline", {
    seconds: options.config.subagent?.backgroundDeadlineSeconds ?? 900,
    source:
      options.config.subagent?.backgroundDeadlineSeconds === undefined ? "default" : "declared",
  });
  // W42c 派发闸三键 + W59 轮数闸留痕（与 deadline 同族；`?? 8/2/16/50` 只是**本日志面**的
  // 缺省重述 = DEFAULT_SUBAGENT_LIMITS.maxFanout/maxDepth 与 DEFAULT_MAX_INFLIGHT_TOTAL 及
  // SERVE_SUB_MAX_TURNS 逐字节等价）——schema/boot/tool-wiring 全链 undefined-honest：键缺席
  // 不覆写/不写字段，现读兜常量在 core 派发时刻（不在此处物化）。source 只看本行三键
  // （deadline/maxTurns 键各自独立判源——生产 subagent 段只声明 deadline 时本行
  // 应现 source:default，即工单取证口径）。turns/turnsSource 是轮数闸唯一解析观测点
  // （turns = 声明值或 SERVE_SUB_MAX_TURNS 缺省；构造期定值，生效=改配置+重启）。
  const sub = options.config.subagent;
  log("info", "loom subagent limits", {
    fanout: sub?.maxFanout ?? 8,
    depth: sub?.maxDepth ?? 2,
    inflight: sub?.maxInflightTotal ?? 16,
    turns: sub?.maxTurns ?? SERVE_SUB_MAX_TURNS,
    turnsSource: sub?.maxTurns === undefined ? "default" : "declared",
    source:
      sub?.maxFanout === undefined &&
      sub?.maxDepth === undefined &&
      sub?.maxInflightTotal === undefined
        ? "default"
        : "declared",
  });
  // W42c 收束闸四值留痕（缺省材料化唯一日志面，W35/W40 同款放置）：`?? DEFAULT_LIMITS.X`
  // 是 core 冻结值 5/3/60/2 的本面重述；键缺席 = 下方 convergenceLimits 不物化 =
  // loop/gate 构造时刻 ?? 兜 DEFAULT_LIMITS（undefined-honest，行为逐字节 = 现网旧面）。
  // W26 语义铁律不经本键改动：主会话自然停/强制分支由 server.convergenceEnforced 定，
  // 本段只改数值不改分支。生效=改配置+重启（无热重载通道，与 deadline 同纪律）。
  const conv = options.config.convergence;
  log("info", "loom convergence", {
    nudgeLimit: conv?.nudgeLimit ?? DEFAULT_LIMITS.nudgeLimit,
    escalateSameError: conv?.escalateSameError ?? DEFAULT_LIMITS.escalateSameError,
    turnHardCap: conv?.turnHardCap ?? DEFAULT_LIMITS.turnHardCap,
    autoContinuations: conv?.autoContinuations ?? DEFAULT_LIMITS.autoContinuations,
    source: conv === undefined ? "default" : "declared",
  });
  // W42c 瞬时 provider 错误重试留痕：`?? 2` = core DEFAULT_LLM_ERROR_RETRIES（session.ts
  // 私有常量 2 的本日志面重述，非物化）。键缺席 = 不向 MainSessionLoop 注入 llmErrorRetries
  // （W42a 条件展开链 undefined-honest，主会话内核构造时刻 `??` 兜 2）；0 = 显式禁用重试。
  // T4 起本行同时留痕退避基数（`?? 1000` = core DEFAULT_LLM_ERROR_RETRY_BACKOFF_MS 重述）。
  // 缝位声明：side/sub 会话内核无本键透传面（W42a 未开），其重试恒 core 缺省 2——报告留痕。
  log("info", "loom llm error retries", {
    count: options.config.llm?.errorRetries ?? 2,
    source: options.config.llm?.errorRetries === undefined ? "default" : "declared",
    backoffMs: options.config.llm?.errorRetryBackoffMs ?? 1000,
    backoffSource:
      options.config.llm?.errorRetryBackoffMs === undefined ? "default" : "declared",
  });
  // T5 失败回合重放留痕：retries=0（含整段/key 缺席）= 禁用，队列与收尾行为逐字节旧面；
  // 两键任一声明即 source:"declared"（逐键判源与上一条同风格）。
  log("info", "loom llm failed-turn replay", {
    retries: options.config.llm?.failedTurnReplayRetries ?? 0,
    backoffMs: options.config.llm?.failedTurnReplayBackoffMs ?? 0,
    source:
      options.config.llm?.failedTurnReplayRetries === undefined &&
      options.config.llm?.failedTurnReplayBackoffMs === undefined
        ? "default"
        : "declared",
  });
  // W49-C 压缩链留痕（与 convergence/llm 同族 info 行，W35/W40 放置风格）：`?? 兜值` 只是
  // **本日志面**的缺省重述（triggerRatio 0.8 / keepRecent 6 = auto-compaction.ts:265-269 构造
  // 时刻 ?? 兜常量；resummarizeEvery 缺席=兜 keepRecent 同链；summaryTimeoutMs/boundary 的
  // 物化在下一波 wiring，缺席=不挂）——schema/接线全链 undefined-honest：段缺席 = 零 hook
  // 注册 = G6 逐字节旧行为面，本行 source:default 如实留痕。microcompact/boundary 字段按
  // "链真会挂什么"口径取 enabled&&在场 门（禁用态整链 off 是事实，不是字段缺省）。
  // T2 WARN：enabled 且未显式 maxContextTokens 时走窗口路径（阈值≈contextWindow−min(maxTokens,
  // 4096)，auto-compaction.ts:304-315）；生产 1M 申报窗阈值 995,904 实操不可达——申报窗
  // ≥200K 即点名提醒补显式预算（200K 下界为"窗口路径阈值罕见可达"启发式，fake 台架 200K 窗
  // 同值确定性可测）。生效=改配置+重启（无热重载通道，同段纪律）。
  const comp = options.config.compaction;
  const compactionEnabled = comp?.enabled === true;
  const microcompactActive =
    compactionEnabled && comp.microcompact !== undefined && comp.microcompact.enabled !== false;
  log("info", "loom compaction", {
    enabled: compactionEnabled,
    maxContextTokens: comp?.maxContextTokens ?? null,
    triggerRatio: comp?.triggerRatio ?? 0.8,
    fallbackTokens: comp?.fallbackTokens ?? null,
    requestTimeoutMs: comp?.requestTimeoutMs ?? 300_000,
    retryCount: comp?.retryCount ?? 10,
    keepRecent: comp?.keepRecent ?? 6,
    resummarizeEvery: comp?.resummarizeEvery ?? comp?.keepRecent ?? 6,
    boundary: compactionEnabled && comp.boundary === true,
    microcompact: microcompactActive,
    summaryMode: comp?.summaryMode ?? null,
    summaryReasoningEffort: comp?.summaryReasoningEffort ?? null,
    summaryBudget: comp?.singleCallBudgetTokens ?? null,
    summaryTemplate: comp?.fallbackTokens === undefined ? "legacy-9" : "compact-6",
    summaryPerspectives:
      comp === undefined || !comp.enabled || comp.fallbackTokens === undefined
        ? null
        : resolveSummaryPerspectives(comp).join("+"),
    summaryProjection:
      microcompactActive && (comp?.microcompact?.compactableTools?.length ?? 0) > 0,
    source: comp === undefined ? "default" : "declared",
  });
  if (
    compactionEnabled &&
    comp.fallbackTokens === undefined &&
    comp.maxContextTokens === undefined &&
    model.model.contextWindow >= 200_000
  ) {
    log("warn", "loom compaction trigger likely unreachable at contextWindow", {
      contextWindow: model.model.contextWindow,
    });
  }
  // W56 忙时发送抢占留痕（与 convergence/llm/compaction 同族 info 行）：键缺席 = undefined
  // = 缺省 OFF（busy 发送旧 FIFO/steer 逐字节）；source 只判本键（undefined=default，
  // false/true 均 declared）。生效=改配置+重启（无热重载通道）；仅主会话 send 路径消费。
  const interruptOnSend = options.config.server.interruptOnSend === true;
  log("info", "loom send interrupt", {
    enabled: interruptOnSend,
    source: options.config.server.interruptOnSend === undefined ? "default" : "declared",
  });
  // W49-C 压缩链 per-session 工厂（T4 破法：boot 进 SessionRegistry 的静态 hooks 数组被
  // #ensure spread 进每个 loop 跨会话共享，而 autoCompaction/compactionBoundary 闭包假设
  // 一实例一 session（auto-compaction.ts:256-258）→ 有状态钩子走 hooksFor 工厂逐会话新造，
  // 追加在 extraHooks 尾部（W47 gate 先序由拼接位置构造性保证）。段缺席/在场禁用 = 键不
  // 出现 = 零注册（G6 逐字节旧面）。summarize=defaultSummarize×completeText 吃主会话同一
  // model/llmOptions 句柄（同 provider、零新增凭据路径）。side/子会话零触碰（sidePort
  // hooks 数组与 childSessionFactory 本波 git diff 零行）。生效=改配置+重启（无热重载）。
  const compactionHooksFor =
    comp === undefined || !compactionEnabled
      ? undefined
      : buildCompactionHooks({ model, cfg: comp });
  const sessionCompaction =
    comp === undefined
      ? undefined
      : buildSessionCompactionOptions({
          model,
          cfg: comp,
          stateRoot: options.stateRoot,
        });
  // W42c convergence 四值唯一物化点（段在场才造对象；缺席 = undefined = 两消费缝
  // 逐字节旧行为——registry 不给 limits 键 → loop.ts `opts.limits ?? {...DEFAULT_LIMITS}`，
  // sidePort 不给 → buildConvergeSession 键缺席 → gate 构造 `?? DEFAULT_LIMITS`）。
  // 在场时单对象同喂主会话（registry→MainSessionLoop→gate）与副会话（sidePort→
  // buildConvergeSession→gate）：两 gate 事件时刻现读同一引用（D26 热载形状，本 boot
  // 写一次定值——生效=改配置+重启，无运行期热改通道）。键级缺席字段取 DEFAULT 值，
  // 与"缺席=现读兜常量"行为全等（数值同、仅对象引用经本缝注入——无行为差）。
  const convergenceLimits: Limits | undefined =
    conv === undefined
      ? undefined
      : {
          nudgeLimit: conv.nudgeLimit ?? DEFAULT_LIMITS.nudgeLimit,
          escalateSameError: conv.escalateSameError ?? DEFAULT_LIMITS.escalateSameError,
          turnHardCap: conv.turnHardCap ?? DEFAULT_LIMITS.turnHardCap,
          autoContinuations: conv.autoContinuations ?? DEFAULT_LIMITS.autoContinuations,
        };

  // W16 上下文变更嗅探种子（docs/01 D16 = mtime+size 轮询水位，禁 fs.watch）：
  // bootHash = boot 实载清单件（W34 起 = 声明 roster，兜底时仍 AGENTS.md 单件）内容的 sha256（degrade 件 = null ⇒ 不进水位，后续出现按
  // "首见 set"，与 dsh agent-instructions 口径一致）；stat 紧随 plan 构造（与实载字节
  // 同刻，变更窗口最小化）。stat 失败按 null fail-soft——该件退化为"首见 set"语义。
  // W20：content = 实载全文（内存已在手，零新增 IO）——水位 diff 基线的种子；degrade 件
  // 传 ""（反正不进水位）。
  const contextSeedFiles: readonly ContextFileSeed[] = mainPlan.memorySources.map((s) => {
    const st = statForSeed(join(toolWiring.workspaceReal, ...s.source.split("/")));
    return {
      relPath: s.source,
      bootHash:
        s.degrade === null
          ? `sha256:${createHash("sha256").update(s.content, "utf8").digest("hex")}`
          : null,
      mtimeMs: st?.mtimeMs ?? null,
      size: st?.size ?? null,
      content: s.degrade === null ? s.content : "",
    };
  });

  // W25 skills catalog 合成嗅探源种子（与 skillsSniff 缝同批接线）：基线 = boot 实载
  // catalog 块文本（仅 name+description 行，正文绝不入）；mtimeMs 槽 = loader 重载代号。
  // 无 skills 段 = 零合成源（嗅探仅记忆清单件（W34 = roster 实载件），兜底形态逐字节 W33 旧行为）。
  const skillsCatalogSeed = (): readonly ContextFileSeed[] => {
    if (skillsWiring === undefined) return [];
    const text = skillsWiring.loader.catalogText();
    return [
      {
        relPath: SKILLS_CATALOG_REL_PATH,
        bootHash: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
        mtimeMs: skillsWiring.loader.generation(),
        size: Buffer.byteLength(text, "utf8"),
        content: text,
      },
    ];
  };

  // W17-B 引用清单装配（W25 起为**工厂现算面**：skillEntries/skillDegrades 每次取 loader
  // 目录视图现值 ⇒ POST /skills/reload 后 /context/full 的 manifest 即刻如实新 catalog。
  // 其余段（memory/mcp/角色/模型）仍 boot 定值，零新增 IO）。apiKey 只在此过
  // maskApiKey（首3+***+末4；缺席=""）——明文永不入任何出口字段。
  const buildContextManifest = (): ContextManifest => assembleContextManifest({
    memorySources: mainPlan.memorySources,
    memorySeeds: contextSeedFiles,
    skillEntries: skillsWiring?.loader.entries ?? [],
    skillDegrades: skillsWiring?.loader.degraded ?? [],
    mcpServers: options.config.mcp?.servers ?? [],
    mcpStatuses: mcpWiring.statuses,
    agentRoleFiles: toolWiring.agentRoleFiles,
    model: {
      id: model.model.id,
      api: model.model.api,
      baseUrl: model.model.baseUrl,
    },
    apiKeyRaw: model.llmOptions.apiKey,
    configPath: options.configPath ?? "",
    workspaceRoot: toolWiring.workspaceReal,
  });

  // W9 切片 1：RunEngine=parse+委托门面；kernel 已先于 wiring 构造（kernelOpts 装配序
  // 见上）。切片 2 补齐执行口真身（wiring.tools 此刻在场），门面与内核同源挂同一实例。
  sideSessionPort = createSideSessionPort({
    model: model.model,
    llmOptions: model.llmOptions,
    tools: toolWiring.tools,
    // W9 切片0：副会话转录落盘（sid=账本 session_id，逐 run 全新，与子会话同文件同实例）。
    store: loomSessionsStore,
    // W23-A 副会话发线面持久（逐 run 绑账本 sid，见 side-session-port options）。
    onWireSnapshot: persistWire,
    // W42c：副会话 gate 阈值同引用注入（缺席 = 不给键 = buildConvergeSession 键缺席
    // → gate 构造 `?? DEFAULT_LIMITS`，逐字节旧行为；00点班 turnHardCap 实际咬合面在此）。
    ...(convergenceLimits === undefined ? {} : { limits: convergenceLimits }),
    ...(skillsWiring === undefined ? {} : { hooks: [skillsWiring.hook] }),
    resolveBinding: (ctx: RunLaunchContext) =>
      // 组合点：账本 run 身份登记 + assembly span 落 trace（观测面，attrs.injectedLines
      // = 注入清单非空行合计），内层再走 workspace 角色绑定解析。
      toolWiring.trace.sideAssemblySpan(ctx, () => bindings.resolve(ctx)),
    onNudge: (ev: NudgeObservation) => runTrace.noteNudge(ev),
  });
  const engine = new RunEngine({ ...kernelOpts, kernel });
  const plane = new ControlPlane({ engine, audit: new MemoryControlAudit() });

  const autoWakeEnabled = options.config.server.autoWakeEnabled !== false;
  const wakeQueueForFlow: WakeQueue | undefined = wakeQueue;
  const wakeQueueSessionID = schedulingMainSessionID;
  const registry: SessionRegistry = new SessionRegistry({
    model: model.model,
    store: sessionStore,
    mainSessionID: mainSession.sessionID,
    // W9 切片0 读侧兜底：history 查不到主 store 归属时转查子/副转录文件（只读，不写回）。
    historyStores: [loomSessionsStore],
    stateRoot: options.stateRoot,
    runEngine: engine,
    tools: toolWiring.tools,
    // W11a：tool-stream hook 常驻主会话面（pending/running/output/file.edited 唯一挂点；
    // 子/副会话不挂——帧归属只认主会话 hub）。workspaceRoot/version 供 session.created。
    hooks: [
      ...(skillsWiring === undefined ? [] : [skillsWiring.hook]),
      toolStream.hook,
    ],
    // W49-C：压缩链 per-session 工厂（键缺席 = 不出现 = extraHooks 逐字节旧形状；在场时
    // #ensure 逐会话新造追加在 recorded/hooks 之后——见 registry.ts 拼接行与 types.ts 字段注）。
    ...(compactionHooksFor === undefined ? {} : { hooksFor: compactionHooksFor }),
    workspaceRoot: toolWiring.workspaceReal,
    version: options.version,
    assembly: { plan: mainPlan, reader: null },
    refreshAssemblyPlanFor: (sessionID) => systemPromptResync(sessionID),
    // W16 嗅探接线：主会话受理时刻按此水位检出注入源变更（side/子会话零影响）。
    // W25：清单尾追加 skills/catalog 合成源种子（registry 磁盘循环跳过保留路径）。
    contextChange: {
      workspaceRoot: toolWiring.workspaceReal,
      files: [...contextSeedFiles, ...skillsCatalogSeed()],
    },
    // W25 skills 热重载嗅探缝：准入时刻同步重扫 loader（fail-soft，warn 落日志、旧
    // catalog 照服务）+ 现读 catalog 视图供水位判变。无 skills 段 = 键缺席（旧行为）。
    ...(skillsWiring === undefined
      ? {}
      : {
          skillsSniff: {
            rescan(): void {
              const r = skillsWiring.loader.reload();
              if (!r.ok) {
                log("warn", "loom skills reload failed at admission sniff (old catalog kept)", {
                  reason: r.reason ?? "",
                });
              }
            },
            snapshot: () => ({
              text: skillsWiring.loader.catalogText(),
              generation: skillsWiring.loader.generation(),
            }),
          },
        }),
    llmOptions: model.llmOptions,
    ...(sessionCompaction === undefined ? {} : { compaction: sessionCompaction }),
    assemblyTrace: createAssemblyTraceWriter({ stateRoot: options.stateRoot, log }),
    // W26 主会话收束强制开关（loom.yaml `server.convergenceEnforced` → registry →
    // MainSessionLoop）。键缺席 = 条件展开跳过 = core 缺省强制（现状逐字节）。
    // 生效方式（W27 实例化部署模型）：值住 <实例根>/.loom/config.yaml 的 server 段，
    // 切换 = 改配置 + 重启，**无运行期热切换**（loop 接线 boot 定死；HotConfigStore
    // apply 只动 /config 观测面——与本键无关，绝不误导成可热改）。
    // side/子会话纪律不随此项松动：它们经 createSideSessionPort / kernel
    // buildConvergeSession 自建 gate，从不读本配置键（仅限主会话是用户冻结约束）。
    ...(options.config.server.convergenceEnforced === undefined
      ? {}
      : { convergenceEnforced: options.config.server.convergenceEnforced }),
    // W56：忙时发送抢占（server.interruptOnSend=true 才物化；缺席/false = 键不出现 =
    // registry 走旧 FIFO/steer 语义，逐字节不变）。仅主会话 send 路径消费。
    ...(interruptOnSend ? { interruptOnSend: true } : {}),
    // L6/L8：flowStore 在场才给 flow 键（缺席 = registry/loop 无 flow 面，旧行为逐字节）；
    // retireConverge 只摘主会话 converge 工具/hook，side/子会话纪律不松动。
    ...(flowStore === undefined ? {} : { flow: { store: flowStore } }),
    ...(flowObservation === undefined ? {} : { flowObservation }),
    ...(retireConverge ? { converge: "disabled" as const } : {}),
    // T11a：flow 只替换 flow 来源；plan/special 条目原样保留（T10 回调语义）。
    ...(wakeQueueForFlow === undefined || wakeQueueSessionID === undefined
      ? {}
      : {
          onWakeReconcileSource: (
            sessionID: string,
            source: "flow",
            entries: readonly WakeQueueEntryLike[],
          ): void => {
            if (sessionID !== wakeQueueSessionID) return;
            void wakeQueueForFlow.reconcileSource(source, entries).catch((error: unknown) => {
              schedulingDegraded = true;
              log("warn", "loom flow wake enqueue failed", {
                sessionID,
                error: errorText(error),
              });
            });
          },
        }),
    // 自动唤醒（server.autoWakeEnabled !== false 才物化：true 携 onAutoWake 武装回调，
    // false 原样下发让 converge schema 摘除 wake 键）。仅主会话收束路读取。
    // shadow/无队列档位不接 onAutoWake（观察期不得产生投递副作用）。
    ...(autoWakeEnabled
      ? {
          autoWakeEnabled: true,
          ...(schedulingActive && wakeQueue === undefined
            ? {}
            : { onAutoWake: (sid: string, at: number | null) => wakeSink.arm?.(sid, at) }),
        }
      : { autoWakeEnabled: false }),
    // W42c：主会话 gate 阈值（既有缝 registry.limits→MainSessionLoop.create，registry
    // 本体零改动）——与副会话同一 Limits 引用，两 gate 事件时刻现读。键缺席（整段缺省）
    // = 不给 limits 键 = loop.ts `opts.limits ?? {...DEFAULT_LIMITS}` 逐字节旧行为。
    ...(convergenceLimits === undefined ? {} : { limits: convergenceLimits }),
    // W42c：W42a llmErrorRetries 透传终点接线（registry 既有缝缺此键，types.ts/registry.ts
    // 各 +1 行最小透传面——主会话是 W42a 命名消费点 MainSessionLoop 的唯一生产构造处）。
    // 键缺席 = 不物化 = MainSessionLoop.create 条件展开跳过 = AgentSession `?? 2` 旧行为。
    ...(options.config.llm?.errorRetries === undefined
      ? {}
      : { llmErrorRetries: options.config.llm.errorRetries }),
    // T4：同链透传重试退避基数（键缺席 = 不物化 = AgentSession `?? 1000` 旧行为）。
    ...(options.config.llm?.errorRetryBackoffMs === undefined
      ? {}
      : { llmErrorRetryBackoffMs: options.config.llm.errorRetryBackoffMs }),
    // T5：失败回合重放两键（键缺席 = 不物化 = registry 缺省 0 = 禁用，旧队列行为逐字节）。
    ...(options.config.llm?.failedTurnReplayRetries === undefined
      ? {}
      : { failedTurnReplayRetries: options.config.llm.failedTurnReplayRetries }),
    ...(options.config.llm?.failedTurnReplayBackoffMs === undefined
      ? {}
      : { failedTurnReplayBackoffMs: options.config.llm.failedTurnReplayBackoffMs }),
    // W23-A 主会话发线面持久（逐会话包 sid，见 registry #ensure 接线）。
    onWireSnapshot: persistWire,
    // W23-B 列表域三件套：meta sidecar（跨重启标题/归档）+ 重水化 sid 的诞生时刻快照。
    meta: sessionMeta,
    createdAtOf: (sid) => bootCreatedAt.get(sid) ?? null,
    // W42b send 队列 sidecar/恢复/加固链的 journal 出口（ServeLog 同形；未接 = 静默）。
    logSink: (level, msg, fields) => log(level, msg, fields),
  });
  compactSessionResolver = (sessionID) => registry.loopOf(sessionID)?.session;
  // pty 退出通知绑定（双惰性闭环）：PTY 退出走 durable 队列路径（空闲 → 立即起轮；
  // 忙 → 当前轮收尾后起新轮），不走 transient 边界提醒（收束前会滞留）。
  ptyNotifySink.deliver = (ownerSessionId, line) =>
    registry.deliverWake(ownerSessionId, line);
  const wakeScheduler = !schedulingActive && autoWakeEnabled
    ? new WakeScheduler({
        stateRoot: options.stateRoot,
        now: () => Date.now(),
        deliver: (sessionID, line, props) => registry.deliverWake(sessionID, line, props),
        // flow 接线后到点行由 FlowStore 现算；null = 主体已不再 due，跳过投递并删 sidecar。
        ...(flowStore === undefined
          ? {}
          : { render: (sessionID: string, at: number) => registry.flowWakeLine(sessionID, at) }),
        ...(flowObservation === undefined
          ? {}
          : {
              observe: (event: WakeObservationInput): void => flowObservation.observe(event),
              subjectAt: (sessionID: string, at: number): number | null =>
                registry.flowWakeSubjectAt(sessionID, at),
            }),
        hasSession: (sessionID) => registry.has(sessionID),
        log: (level, msg, fields) => log(level, msg, fields),
      })
    : null;
  if (wakeScheduler !== null) {
    wakeSink.arm = (sessionID, at) => wakeScheduler.arm(sessionID, at);
  }
  if (!schedulingActive) {
    log("info", "loom auto wake", {
      enabled: autoWakeEnabled,
      source: options.config.server.autoWakeEnabled === undefined ? "default" : "declared",
    });
  }
  // 段缺席 = 零新增日志行（默认关闭面与旧 boot 逐字节同形）。
  if (options.config.flow !== undefined) {
    log("info", "loom flow", {
      enabled: flowEnabled,
      retireConverge,
      source: "declared",
    });
  }
  // W15 重启重水化（修「restart 清空会话列表」）：registry.#records 是纯内存 Map，
  // 此前 boot 后零登记 → GET /sessions 空 → 网页面板 loadSessions 拿不到任何会话，
  // 转手 POST /sessions 造全新 sid，旧转录在盘上成孤儿（文件本身没丢：
  // JsonlSessionStore 构造即回放 jsonl，历史面读的是 store）。修复 = 把**主 store**
  //（loom-main.jsonl）已落盘的 sid 逐个 registry.ensure 重登记（loop/hub 即时建、闲置
  // 成本可忽略；历史页/上下文面本就走 store/trace，不依赖 loop 内存）。
  // W16-E 域收拢（live 实测 160 条病态列表 ⇒ 副/子 store 一路删除）：
  // ① history 路由本就不依赖 registry 记录——registry.history 按归属查 historyStores
  //   直读 store（boot.ts:292 接线，W9 切片0 读侧兜底原样成立），子/副转录照旧 200 可达；
  // ② 副/子会话可见性走 session.children SSE + task_metadata 反解（面板子会话 tab），
  //   绝不进主列表——现网 loom-sessions.jsonl 154 sid 入列会淹没侧栏，且 hm LoomEventHub
  //   经 GET /sessions 发现会话后**逐会话建 SSE**，每个重连开 150+ 僵尸流；
  // ③ 子/副 sid 的 statusView/contextFull 是无 loop 语义的 404 面，入列 = 假可用性。
  // T2 起缺省主会话由 boot 解析结果接管，不再依赖首注册顺序；副/子仍不入列。
  for (const sid of sessionStore.sessionIds()) registry.ensure(sid);
  // T2：解析出的主会话必须在任何 /sessions/* 请求之前存在（空库首启也有稳定靶）。
  registry.ensure(mainSession.sessionID);
  log("info", "loom main session", {
    sessionID: mainSession.sessionID,
    source: mainSession.source,
    ensured: true,
  });
  // 调度引擎绑定主会话：显式 scheduling.sessionId 优先（逐字节旧面），缺席 = 已解析主会话。
  if (schedulingMainSessionID !== undefined && !registry.has(schedulingMainSessionID)) {
    registry.ensure(schedulingMainSessionID);
  }
  const runSchedulingBoot = async (): Promise<void> => {
    log("debug", "loom scheduling boot step", { step: "recover" });
    let restored = 0;
    if (wakeQueue !== undefined) {
      try {
        restored = (await wakeQueue.restore()).restored;
      } catch (error) {
        schedulingDegraded = true;
        log("warn", "loom wake queue restore failed", { error: errorText(error) });
      }
      log("debug", "loom scheduling boot step", { step: "queue.restore", restored });
    }
    let reconciled: ReconcileResult | null = null;
    if (planScheduler !== undefined) {
      try {
        reconciled = await planScheduler.reconcile({ reason: "boot" });
        if (reconciled.status === "degraded") schedulingDegraded = true;
      } catch (error) {
        schedulingDegraded = true;
        log("warn", "loom plan scheduler boot reconcile failed", {
          error: errorText(error),
        });
      }
      log("debug", "loom scheduling boot step", {
        step: "plan.reconcile",
        entries: reconciled?.entries.length ?? 0,
      });
    }
    if (flowStore !== undefined) {
      try {
        await registry.reconcileFlowWakes();
      } catch (error) {
        log("warn", "loom flow wake reconcile threw", { error: errorText(error) });
      }
      log("debug", "loom scheduling boot step", { step: "flow.reconcile" });
    }
    if (!schedulingClosed) {
      planScheduler?.start();
      if (wakeQueue !== undefined) {
        const handle = setInterval(() => {
          void wakeQueue?.watchdogTick().catch((error: unknown) => {
            log("warn", "loom wake queue watchdog failed", { error: errorText(error) });
          });
        }, scheduling?.watchdogMs ?? 60_000);
        const candidate: { unref?: () => void } = handle;
        candidate.unref?.();
        queueWatchdogTimer = handle;
      }
    }
    log("debug", "loom scheduling boot step", { step: "start" });

    let masterVersion: number | null = null;
    if (planMasterStore !== undefined) {
      try {
        masterVersion = (await planMasterStore.read()).version;
      } catch {
        masterVersion = null;
      }
    }
    let entries = reconciled?.entries.length ?? restored;
    if (wakeQueue !== undefined) {
      try {
        entries = await wakeQueue.pendingCount();
      } catch {
        // 保留 restore/reconcile 读数；队列计数失败不阻断汇总行。
      }
    }
    log("info", "loom scheduling", {
      engine: `wakeQueue=${wakeMode},planScheduler=${planMode}`,
      master_version: masterVersion,
      entries,
      degraded: schedulingDegraded,
    });
  };
  // W42b 队列耐重启：崩溃前 busy 排队的受理项从 sidecar（session/queue/{sid}.json）重灌
  // 并入队执行；journal（recovered/unreadable）在 registry 内部经 logSink 落此 log。
  void registry
    .recoverSendQueues()
    .catch((err: unknown) => {
      log("warn", "loom send queue recovery threw (no queue recovered this boot)", {
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      if (schedulingActive) {
        void runSchedulingBoot().catch((error: unknown) => {
          log("warn", "loom scheduling boot failed", { error: errorText(error) });
        });
        return;
      }
      wakeScheduler?.restore();
      // L6 boot 恢复：队列恢复 + 调度器 restore 之后按 flow 真源重建唤醒计划
      //（overdue 用 now+5s 宽限；closed/无 pending 清 sidecar——见 registry.reconcileFlowWakes）。
      if (flowStore !== undefined) {
        void registry.reconcileFlowWakes().catch((err: unknown) => {
          log("warn", "loom flow wake reconcile threw", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    });
  // W12 提醒路由（engine.onRunTerminal 的运行期出口；见上方双惰性注释）。
  runReminders = createRunReminderRouter({ registry, log });

  const router = new Router({ tokens: options.tokens });
  registerOpsRoutes(router, {
    getConfig: () => options.store.get(),
    hotStore: options.store,
    startedAt: Date.now(),
    version: options.version,
    audit: () => readConfigAudit(options.stateRoot),
  });
  registerSessionRoutes(router, {
    registry,
    // T3：列表默认关闭（配置键缺席 = disabled）；主会话单端点恒可用。
    sessionList: options.config.server.sessionList === true,
    mainSessionId: mainSession.sessionID,
    // W25：传工厂 = /context/full v2 的 manifest 块每次现算（热重载后 skillFiles 即刻如实）。
    manifest: buildContextManifest,
    // W23-A：/context/full 三段回落的缓存读口 + 纯缓存面的 contextWindow 数据源。
    wireCache,
    contextWindow: typeof model.model.contextWindow === "number" ? model.model.contextWindow : null,
  });
  // W25 手动热重载端点（运维面；鉴权继承 Router 前置，无豁免）。重扫 allowlist 并原子
  // 换入目录视图：成功 = 下一请求的 system prompt 即携新 catalog（主/副/子会话同一
  // hook 现读面）+ 既有主会话下一轮准入收到 skills/catalog 的行级 diff notice；
  // 失败（目录不可读/零有效 skill）= fail-soft 保留旧 catalog，恒 200
  // {ok:false, reason}——绝不 500、绝不空化（用户口径：热重载不许把现网打瘸）。
  router.add("POST", "/skills/reload", (_req, res) => {
    if (skillsWiring === undefined) {
      sendJson(res, 200, { ok: false, reason: "skills not wired（loom.yaml 无 skills 段）" });
      return;
    }
    const r = skillsWiring.loader.reload();
    if (r.ok) {
      log("info", "loom skills reload ok", {
        generation: r.generation,
        entries: r.entries.length,
        degraded: r.degraded.length,
      });
      sendJson(res, 200, {
        ok: true,
        generation: r.generation,
        entries: r.entries.length,
        degraded: r.degraded.length,
      });
      return;
    }
    log("warn", "loom skills reload failed (old catalog kept)", { reason: r.reason ?? "" });
    sendJson(res, 200, { ok: false, reason: r.reason ?? "skills reload failed" });
  });
  registerTaskRoutes(router, {
    engine,
    plane,
    pauseSwitches: () => board.read(),
    ledgerRows: () => ledger.rows(),
    trace: { stateRoot: options.stateRoot },
    // W12 归属旁路：POST /runs 可选 parentSessionId → 派发时刻登记（不进账本行形状），
    // 终态时刻由 router 消费（parent 在册 = 主会话 sid 则投它，否则缺省主会话）。
    noteRunParent: (runId, parentSessionId) => runReminders.noteParent(runId, parentSessionId),
    // W9 切片 3：/tasks 三面 = 内核后台账本视图（list/get/cancel 直投，无第二登记面）。
    // W37：内联适配器上移为 taskSurface const（kernel 后首行）——与 task_cancel 工具面
    // 共用同一实例（取消真源仍 kernel.cancelSub，本处仅命名抽取，闭包体逐字节不变）。
    tasks: taskSurface,
  });

  const reconcileReasons: readonly ReconcileReason[] = [
    "boot",
    "anchor-0500",
    "anchor-0730",
    "watchdog",
    "manual",
  ];
  if (planScheduler !== undefined) {
    const scheduler = planScheduler;
    router.add("POST", "/plan/reconcile", async (req, res) => {
      const raw = await readJsonBody(req);
      if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
        throw new HttpError(400, "bad_request", "body 必须是 JSON 对象");
      }
      const body: object = raw ?? {};
      const anchor = Reflect.get(body, "anchor");
      let reason: ReconcileReason | undefined;
      if (anchor !== undefined) {
        if (anchor !== "05:00" && anchor !== "07:30") {
          throw new HttpError(400, "bad_request", 'anchor 必须是 "05:00" 或 "07:30"');
        }
        reason = anchor === "05:00" ? "anchor-0500" : "anchor-0730";
      } else {
        const rawReason = Reflect.get(body, "reason");
        if (rawReason !== undefined) {
          reason = reconcileReasons.find((candidate) => candidate === rawReason);
          if (reason === undefined) {
            throw new HttpError(400, "bad_request", "reason 非法");
          }
        }
      }
      const result = await scheduler.reconcile({ reason: reason ?? "manual" });
      sendJson(res, 202, {
        ok: true,
        reconciled_at: Date.now(),
        status: result.status,
        date: result.date,
        entries: result.entries.length,
        enqueued: result.queue?.added ?? 0,
        cancelled: result.queue?.cancelled ?? 0,
        degraded: result.status === "degraded" || schedulingDegraded,
      });
    });
  }
  if (schedulingActive) {
    router.add("GET", "/plan/state", async (_req, res, ctx) => {
      const requestedSession = ctx.url.searchParams.get("sessionId");
      if (requestedSession !== null && requestedSession !== schedulingMainSessionID) {
        throw new HttpError(404, "session_not_found", `no scheduled session ${requestedSession}`);
      }
      const rawDate = ctx.url.searchParams.get("date");
      const date = rawDate ?? zonedDateKey(Date.now(), schedulingTimezone);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new HttpError(400, "bad_request", "date 必须是 YYYY-MM-DD");
      }
      let degraded = schedulingDegraded;
      let masterVersion: number | null = null;
      if (planMasterStore !== undefined) {
        try {
          masterVersion = (await planMasterStore.read()).version;
        } catch {
          degraded = true;
        }
      }
      let overlayVersion: number | null = null;
      if (planOverlayStore !== undefined) {
        try {
          overlayVersion = (await planOverlayStore.read(date)).version;
        } catch {
          overlayVersion = null;
        }
      }
      let pending = 0;
      let deliveredTail: readonly unknown[] = [];
      if (wakeQueue !== undefined) {
        try {
          const snapshot = await wakeQueue.snapshot();
          pending = snapshot.entries.length;
          deliveredTail = snapshot.delivered.slice(-10);
        } catch {
          degraded = true;
        }
      }
      let ledgerTail: readonly unknown[] = [];
      if (schedulingLedger !== undefined) {
        try {
          ledgerTail = (await schedulingLedger.read(date)).slice(-20);
        } catch {
          degraded = true;
        }
      }
      sendJson(res, 200, {
        sessionID: schedulingMainSessionID ?? null,
        date,
        master_version: masterVersion,
        overlay_version: overlayVersion,
        queue: { pending, delivered_tail: deliveredTail },
        ledger_tail: ledgerTail,
        degraded,
      });
    });
  }

  // 事件域（D33 修正一）：全局 /events/stream（?sessionId=）+ 会话侧同形路径。
  // sseStreamHandler 读 ctx.params["sessionId"]（T27/T29 测试接线冻结的参数名）。
  const resolveHub = (sessionId: string | undefined) => {
    if (sessionId === undefined) {
      throw new HttpError(400, "missing_session_id", "SSE 订阅需带 sessionId（查询参数）");
    }
    const hub = registry.hubOf(sessionId);
    if (hub === undefined) {
      throw new HttpError(404, "session_not_found", `no session ${sessionId}`);
    }
    return hub;
  };
  router.add("GET", "/events/stream", sseStreamHandler(resolveHub));
  router.add("GET", "/sessions/:sessionId/events", sseStreamHandler(resolveHub));

  // 静态门面页（GET / 与 /ui）在 Router 鉴权之前应答：页面本身零 token（单文件内嵌
  // CSS/JS 的本地运维面板），API 调用仍照旧走 X-Loom-Token；Router 本体
  // 「鉴权先于路由匹配」的口径不动（门面页是唯一豁免面，见 harness-ui.ts 文件头）。
  const routerHandler = router.toRequestHandler();
  const server = createServer((req, res) => {
    if (handleHarnessUiRequest(req, res)) return;
    routerHandler(req, res);
  });
  return {
    server,
    registry,
    model,
    models,
    ledger,
    engine,
    kernel,
    tools: toolWiring.tools,
    skillsWiring,
    mcpWiring,
    // W25 现算面：每次读取重建清单（skillFiles 段随热重载即刻反映；其余段定值纯函数重算）。
    get contextManifest() {
      return buildContextManifest();
    },
    flowStore,
    closeExtras: async () => {
      // flow 面才接管调度器收尾；默认关闭面保持旧 closeExtras 语义。
      schedulingClosed = true;
      if (flowStore !== undefined) wakeScheduler?.dispose();
      if (queueWatchdogTimer !== null) {
        clearInterval(queueWatchdogTimer);
        queueWatchdogTimer = null;
      }
      wakeQueue?.dispose();
      planScheduler?.dispose();
      await mcpWiring.closeAll();
    },
  };
}

/** serveLoom 输入（在 LoomAppOptions 之上补监听参数）。 */
export interface ServeOptions extends LoomAppOptions {
  readonly port: number;
  readonly hostname: string;
}

/** 运行中的服务句柄：closed 在停机流程全部完成后 resolve。 */
export interface ServeHandle {
  readonly port: number;
  readonly hostname: string;
  readonly closed: Promise<void>;
  /** 幂等：信号/调用方重复触发只跑一次停机流程。 */
  shutdown(reason: string): void;
}

function endAllHubs(app: LoomApp): void {
  // W23-B：停机拆 hub 走 "all" 面（归档会话的订阅流同样要优雅 end，默认列表已排除归档）。
  for (const view of app.registry.list({ archived: "all" })) {
    app.registry.hubOf(view.sessionID)?.close();
  }
}

/**
 * 起服务并接管生命周期：listen 成功 → 注册 SIGTERM/SIGINT → 停机排水。
 * listen 失败（EADDRINUSE 等）直接 reject，不留悬挂信号处理器。
 */
export async function serveLoom(options: ServeOptions): Promise<ServeHandle> {
  const log = options.log ?? (() => {});
  const app = await createLoomApp(options);
  const { server } = app;

  let draining = false;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const onSigterm = (): void => shutdown("SIGTERM");
  const onSigint = (): void => shutdown("SIGINT");

  function shutdown(reason: string): void {
    if (draining) return;
    draining = true;
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    log("info", "loom shutdown start", { reason });
    // W5-B 外部持有资源先行关停（MCP 子进程 SIGTERM/SIGKILL 收尸，幂等）：
    // 在途 callTool 随排水窗口自然转异常（kernel isError / 账本缺口 = D15 对账输入），
    // 其失败留痕在 closeExtras 内 warn，绝不反噬停机流程（保险丝照旧兜底）。
    void app.closeExtras().catch((err: unknown) => {
      log("warn", "loom shutdown close extras failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    let finished = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    function finish(): void {
      if (finished) return;
      finished = true;
      if (deadline !== undefined) clearTimeout(deadline);
      // 兜底断连：排水窗口到点仍未自然收净的（半开 socket / 赖着的 keep-alive）强制拆除。
      server.closeAllConnections();
      // W53 T3：统一注销全部模型句柄（teardownAll 幂等且覆盖 main）；app.model 兼容面不变。
      app.models.teardownAll();
      log("info", "loom shutdown done", { reason });
      resolveClosed();
    }

    // 0) 保险丝先行：任一环节卡死也在 5s 硬上限处强制退出（宁可截流，不可挂死）。
    deadline = setTimeout(() => {
      log("warn", "loom shutdown deadline hit", { timeoutMs: SHUTDOWN_TIMEOUT_MS });
      finish();
    }, SHUTDOWN_TIMEOUT_MS);

    // 1) 停止 accept + 排空回执：close 回调在全部连接自然结束后触发 → finish。
    server.close(() => finish());
    // 2) 订阅连接优雅 end（SSE 帧流终止；这是让 1) 的连接真正排空的前提）。
    endAllHubs(app);
    // 3) 在途 run 如实 abort（execution port 的 signal 契约；不强等终局——
    //    账本留 expected-without-actual 缺口 = D15 对账输入，重启后 T13 补）。
    for (const rec of app.engine.listRuns()) {
      if (rec.state === "running") app.engine.cancel(rec.row.run_id, "shutdown");
    }
    // W9 切片 3（D24 收口方）：后台 sub 不吃父 turn abort，但吃停机排水——同形状
    // cancel（session 协作式收尾；排水窗内未竟者留账本缺口，同 run 面对账口径）。
    for (const sub of app.kernel.listSubRuns()) {
      if (sub.state === "running") app.kernel.cancelSub(sub.row.run_id, "shutdown");
    }
    // 4) L0 检查点：Journal 写侧 append 即同步落盘（Ledger 逐行 fsync，无内存缓冲
    //    可丢），"flush"在此是**核验留痕**：打印缺口数，随后放行退出。
    log("info", "loom shutdown l0 checkpoint", {
      ledger: app.ledger.filePath,
      gaps: app.engine.gaps(),
    });
  }

  return new Promise<ServeHandle>((resolve, reject) => {
    server.once("error", (err) => {
      reject(err);
    });
    server.listen(options.port, options.hostname, () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr !== null ? addr.port : options.port;
      process.on("SIGTERM", onSigterm);
      process.on("SIGINT", onSigint);
      log("info", "loom serving", { port: boundPort, hostname: options.hostname });
      resolve({ port: boundPort, hostname: options.hostname, closed, shutdown });
    });
  });
}
