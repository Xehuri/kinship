/**
 * T27 会话域 API —— 类型契约（docs/01 §10.1 五域之首；docs/02 §T27；D23/D29）。
 *
 * 会话域 = 主会话（唯一与用户交互的长生命周期体，D5）的命令面：
 *   发送消息（含语音「先中止再发送」）/ 历史分页（游标 x-next-cursor）/
 *   中止当前轮 / 会话状态。
 *
 * 前端硬口径（docs/02 验收表，开发期必须满足形状，切换日只改名）：
 *   - JSON 字段用 `sessionID` 驼峰（见 SessionStatusView / SessionErrorBody）；
 *   - id 字符集 `[a-zA-Z0-9_]`，连字符永久禁用（sessionID 造号复用 core/subagent/ids.ts）；
 *   - 事件帧信封 `{payload:{type,properties}}` 由 T29 事件域负责，本模块只把事件灌进
 *     EventHub（T31 装配时接线），不自己造帧形状。
 */

import type { MainAssemblyOptions, MainSessionLoop, MainSessionLoopOptions } from "@axeuh/loom-core/main-loop";
import type { ContextFileSeed, SessionContextWatcher } from "@axeuh/loom-core/assembly";
import type { RunEngine } from "@axeuh/loom-core/run-engine";
import type { EventHub } from "../events/index.js";
import type { CompactionEvent } from "./compaction-events.js";
import type { ContextManifest } from "./context-manifest.js";
import type { ContextView } from "./context.js";
import type { SessionRegistry } from "./registry.js";
import type { FlowStore, LlmOptions, LogLevel, Model, Api, HarnessTool, Hook, Limits, SessionStore, SteerHandle, WireRequestSnapshot, CompactionCheckpointPayload, Message, SessionCompactionOptions } from "@axeuh/loom-core";
import type { FlowObservationSink } from "../flow/flow-observation.js";
import type { FlowDraft } from "../events/mapping.js";
import type { WireCacheRecord } from "../serve/wire-cache.js";
import type { SessionMetaStore } from "../session-meta.js";

/** 会话状态（前端 `parseSessionStatus` 词表：busy / idle / error）。 */
export type SessionStatus = "idle" | "busy" | "error";

/** GET /sessions/:sessionID/status 响应体（sessionID 驼峰硬口径）。 */
export interface SessionStatusView {
  readonly sessionID: string;
  readonly status: SessionStatus;
  /** 最近一次错误的可读消息；无错 = null（不省略，前端可判 null）。 */
  readonly lastError: string | null;
  /** 副会话在途 run 数（run-engine 查询接缝；未注入引擎 = 0）。 */
  readonly activeRuns: number;
  /** 该会话累计发起的主循环 run 次数（含 abort 后再发）。 */
  readonly turns: number;
  /** W42b busy 排队深度（当前在途轮**之外**的待执行项数；溢出判别 = 本值 ≥ queueCapacity）。 */
  readonly queueLength: number;
}

/** POST /sessions 与 GET /sessions 的会话视图。 */
export interface SessionView {
  readonly sessionID: string;
  readonly status: SessionStatus;
  /**
   * W23-B 诞生时刻（epoch ms）：新 sid = 登记时刻 now；重水化 sid = 转录首条 message
   * 时间戳（boot 经 createdAtOf 注入 store 现值）。列表视图倒序的排序键。
   */
  readonly createdAt: number;
  /** W23-B 用户标题（meta sidecar 在场才有；未命名 = 键缺席，展示回落归面板）。 */
  readonly title?: string;
  /** W23-B 归档标（meta 未声明 = false；默认列表排除归档，?archived=1 只列归档）。 */
  readonly archived: boolean;
}

/** 发送消息请求体（宽松解析：多形态入参在此收口）。 */
export interface SendMessageBody {
  readonly text: string;
}

/**
 * W51 GET /sessions/:sessionID/compaction 响应体（live 压缩境界只读面，硬接口合同）。
 *
 * 两态判别：`"active"` = core compactionView 快照在场（coveredCount/summaryText/anchors 透传，
 * tailCount = totalMessages − coveredCount，越界可为 0/负——如实公式，不夹）；
 * `"none"` = 无境界（四压缩键恒 null；tailCount = totalMessages，即全量皆尾巴）。
 * 键名/驼峰口径逐字节冻结，hm 后端逐键拼压缩分隔线。
 */
export type SessionCompactionResponse =
  | {
      readonly sessionID: string;
      readonly status: "active";
      readonly coveredCount: number;
      readonly summaryText: string;
      readonly anchorMessageId: string | null;
      readonly anchorTimestampMs: number | null;
      readonly tailCount: number;
      readonly totalMessages: number;
    }
  | {
      readonly sessionID: string;
      readonly status: "none";
      readonly coveredCount: null;
      readonly summaryText: null;
      readonly anchorMessageId: null;
      readonly anchorTimestampMs: null;
      readonly tailCount: number;
      readonly totalMessages: number;
    };

/** C2 压缩历史事件（与 compaction-events.ts 同一形状；types.ts 出口供路由/消费者引用）。 */
export type { CompactionEvent } from "./compaction-events.js";

/**
 * C2 GET /sessions/:sessionID/compactions 响应体：该会话全部已知压缩摘要，按
 * `(anchorTimestampMs ?? recordedAt), recordedAt` 升序（旧→新），摘要全文 sha256 去重。
 * 未知会话由路由 404；已知会话无压缩史 = `events: []`（合法空面）。
 */
export interface SessionCompactionsResponse {
  readonly sessionID: string;
  events: CompactionEvent[];
}

/**
 * T10 flow 唤醒队列对账条目（结构最小面；真源 = serve/wake-queue 的 WakeQueueEntryInput）。
 * id 携带 subject_id 与 at，保证同一主体改期后成为新条目、已投递时间点不被归档抑制。
 */
export interface WakeQueueEntryLike {
  readonly id: string;
  readonly source: "flow";
  readonly action: "flow.check";
  readonly at: number;
  readonly payload: { readonly subject_id: string; readonly at: number };
  readonly created_at: number;
  readonly attempts: number;
}

/**
 * 会话注册表装配依赖（T31 serve CLI 组装时接真实实例；测试注入 fake）。
 *
 * - model：主会话模型（测试用 server/src/fake-model 的 createFakeModelFromConfig 离线跑）。
 * - store：会话持久化（HWM + 历史分页真源）。
 * - tools / systemPrompt / limits：透传给 MainSessionLoop。
 * - newSessionID：无连字符 id 生成；缺省复用 core/subagent/ids.ts 的 newSubagentSessionId。
 * - stateRoot：EventHub trace 补发根（缺省 process.env.LOOM_STATE ?? "state"）。
 * - runEngine：副会话状态查询接缝（GET status 的 activeRuns）。
 * - now：时钟注入（测试确定性）。
 */
export interface SessionRegistryOptions {
  readonly model: Model<Api>;
  readonly store: SessionStore;
  readonly tools?: readonly HarnessTool[];
  readonly systemPrompt?: string;
  /** T18 装配接线（主会话记忆注入真源；每会话同一 plan/reader，前缀跨会话恒定）。 */
  readonly assembly?: MainAssemblyOptions;
  /**
   * systemPrompt / memory 重读工厂（session-start 与 compaction 触发）：boot 注入
   * `createSystemPromptResync` 的 per-session provider。**需同时给 `assembly`** 才接线
   * （core 契约：无装配即无 plan 可换）；键缺席 = 旧行为（前缀 boot 期冻结）。
   */
  readonly refreshAssemblyPlanFor?: (
    sessionID: string,
  ) => NonNullable<MainSessionLoopOptions["refreshAssemblyPlan"]>;
  /** 真 provider 透传项（apiKey/timeout；serve 装配唯一来源）。 */
  readonly llmOptions?: LlmOptions;
  /**
   * W57 P2c-2：会话级压缩接线（逐值条件透传给 MainSessionLoop.create）。
   * 键缺席 = core 旧行为。当前 boot 不构造本项；本字段只提供后续 server 装配的
   * 类型接入口，不读配置、不建 stateStore。
   */
  readonly compaction?: SessionCompactionOptions;
  readonly limits?: Limits;
  /**
   * W42c 瞬时 provider 错误重试上限（loom.yaml `llm.errorRetries` 的接线终点，
   * 条件透传给 MainSessionLoop.create——键缺席 = core 缺省 2（W42a 默认），现状逐字节）。
   * 0 = 禁用重试（error-stop 一发即诚实终态化）。缝位如实声明：本片按工单"找不到既有缝
   * 就新增最小透传面"开此 1 字段 + registry #ensure 1 行条件透传（W26 convergenceEnforced
   * 同形状），W42b send 队列/sidecar/持久化逻辑零触碰；side/sub 会话内核无本键透传面
   * （W42a 未开、本片不扩），其重试恒 core 缺省 2。
   */
  readonly llmErrorRetries?: number | undefined;
  /**
   * 重试退避基数毫秒（loom.yaml `llm.errorRetryBackoffMs` 的接线终点，条件透传给
   * MainSessionLoop.create——键缺席 = core 缺省 1000）。仅主会话面生效，side/sub 不接线。
   */
  readonly llmErrorRetryBackoffMs?: number | undefined;
  /**
   * T5 失败回合重放上限（loom.yaml `llm.failedTurnReplayRetries` 的接线终点）。
   * 键缺席/0 = 禁用重放，队列/收尾行为逐字节旧面；>0 = 瞬时 LLM 错误且 prompt 已落盘时，
   * 以 `AgentSession.continue()` 从现有转录续跑，最多 N 次。
   */
  readonly failedTurnReplayRetries?: number | undefined;
  /** T5 重放退避基数毫秒（退避 = base×2ⁿ，n 从 0 起）；缺席/0 = 立即重放。 */
  readonly failedTurnReplayBackoffMs?: number | undefined;
  /**
   * W26 主会话收束强制开关（loom.yaml server.convergenceEnforced 的接线终点，
   * 条件透传给 MainSessionLoop.create——键缺席 = core 缺省 true，现状逐字节）。
   * **仅主会话面生效**：side/子会话各端口自建 gate，不经 registry 选项，纪律不松。
   * 生效方式 = 改实例配置 + 重启（W27 部署模型，无运行期热切换通道）。
   */
  readonly convergenceEnforced?: boolean;
  /**
   * 主会话自动唤醒开关（loom.yaml `server.autoWakeEnabled` 的接线终点）：
   * 缺席/undefined = 启用；显式 false = 关闭主会话自动唤醒（converge schema 省略
   * `wake`，带 wake 的收束按字段缺失拒收）；重启生效；side/子会话永不读取。
   */
  readonly autoWakeEnabled?: boolean;
  /**
   * L6 主会话 flow 接线：给 store 即向每个主会话 MainSessionLoop 预置 flow_commit 工具与
   * FlowGate，并在每次主 run 收尾后同步 flow 唤醒。side/子会话绝不读取本项。
   * 键缺席 = 无 flow 面（旧行为逐字节）。
   */
  readonly flow?: { readonly store: FlowStore };
  /** L9 观察窗（flow 在场才消费）：唤醒/终态/idle 事实旁路落盘，绝不改变 flow 行为。 */
  readonly flowObservation?: FlowObservationSink;
  /**
   * L8 分阶段开关：`"disabled"` = 主会话不挂 converge 工具/钩子，由 flow 接管终止。
   * 键缺席/`"enabled"` = 现状逐字节；side/子会话不读本项。
   */
  readonly converge?: "enabled" | "disabled";
  /**
   * 自动唤醒武装回调：converged 回执携带 `nextWakeAt`（无 flow 时）或 flow 最早
   * `next_decision_at`（有 flow 时）最多各调用一次；`null` = 显式清除；键缺席 = 不调用。
   */
  readonly onAutoWake?: (sessionID: string, at: number | null) => void;
  /**
   * T10 flow 唤醒队列来源对账回调（绑定点 = WakeQueue.reconcileSource）：
   * 在场时按 FlowStore 的 pending 主体逐条重建 flow 条目并整体对账，只替换 flow 来源，
   * 绝不触碰 plan/special；此时旧 `onAutoWake` 单槽不参与 flow 唤醒（新面优先）。
   * 键缺席 = 旧单槽行为逐字节不变。
   */
  readonly onWakeReconcileSource?: (
    sessionID: string,
    source: "flow",
    entries: readonly WakeQueueEntryLike[],
  ) => void;
  /**
   * W56 忙时发送抢占（loom.yaml `server.interruptOnSend` 的接线终点）。
   * 缺省 false（键缺席/显式 false 皆旧 FIFO 排队 + steer 语义，逐字节不变）。
   * true = busy 时到达的新消息插队首 + abort 当前轮；当前轮收尾后该消息成为下一轮
   * prompt，既有排队项保持原序作为 followers 合并进该轮（绝不丢弃/重排），
   * 返回 `{accepted:true, interrupted:true}` 而非 `queued:true`。
   * **仅主会话 POST /sessions/:id/messages 发送路径**；side/子会话与 voiceSend 不受影响。
   * 生效方式 = 改实例配置 + 重启（W27 部署模型，无运行期热切换通道）。
   */
  readonly interruptOnSend?: boolean;
  readonly newSessionID?: () => string;
  /**
   * T2 boot 解析出的主会话 id（配置 > 持久标记 > 调度 > 首存储 > 新造）。
   * 键缺席 = 旧行为（defaultMainSessionId 回落首注册 sid）；在场 = 缺省主会话恒为本值。
   */
  readonly mainSessionID?: string;
  readonly stateRoot?: string;
  readonly runEngine?: Pick<RunEngine, "activeCount">;
  readonly now?: () => number;
  /**
   * W42b 观测日志（boot 注入 ServeLog 同形引用；未接 = 静默）。会话域只在此落
   * **运维事实**：send 队列 sidecar 写读失败、恢复计数、drain 加固回插——绝不静默蒸发。
   */
  readonly logSink?: (level: LogLevel, msg: string, fields: Record<string, unknown>) => void;
  /**
   * 会话级附加 hooks（W5 skills 接线：catalog 进 system prompt 的 transform hook；
   * 与内部 recorded 转发钩并集进 MainSessionLoop.extraHooks）。缺省 = 不挂（旧调用面不变）。
   */
  readonly hooks?: readonly Hook[];
  /**
   * W49-C per-session hook 工厂（主会话压缩链的接线终点）：#ensure 建会话记录时以本
   * 会话 sid 调用，返回钩子**追加在静态 hooks 之后**（extraHooks 尾部——gate/boundary/
   * recorded/skills/tool-stream 全部在前，W47 门先序由拼接位置构造性保证）。
   * 存在理由 = T4（W49.7 实锤）：autoCompaction/compactionBoundary 闭包假设有状态
   * 一实例一 session（auto-compaction.ts:256-258），而 opts.hooks 静态数组被 #ensure
   * spread 进每个 loop（registry.ts:694）跨会话共享——有状态钩子绝不进静态数组。
   * skills/toolStream 无状态保持静态面不动。缺省 = 键缺席 = 零注册（旧调用面逐字节，
   * G6 对照面）。
   */
  readonly hooksFor?: (
    sessionID: string,
  ) => readonly Hook<Message | CompactionCheckpointPayload>[];
  /**
   * 装配 span 落 trace 的端口（serve 装配注入 assembly-trace writer）：
   * 每次 run 收尾消费 loop.events() 的 assembly 事件；未接 = 不落 trace（测试/离线缺省）。
   */
  readonly assemblyTrace?: { write(sessionId: string, events: readonly unknown[]): number };
  /**
   * W9 切片0 决策：history 读面的多 store 兜底清单（只读不回写）。
   * 子/副会话转录存于主会话文件**之外**的独立 store（现网历史面冻结，不许合并文件）；
   * registry.history 先查主 store 归属，查不到再按序查本清单——首个持有该 sid 的 store 为准。
   * 缺省 = 单 store 旧行为（写侧主转录仍只走 store，逐字节不变）。
   */
  readonly historyStores?: readonly SessionStore[];
  /**
   * W11a P2：session.created 帧 info.directory 的数据源（= 工具面 workspace realpath）。
   * 缺省 = 该字段省略（文档允许字段缺失容错）。
   */
  readonly workspaceRoot?: string;
  /** W11a P2：session.created 帧 info.version 的数据源（= serve 版本口径）。缺省 = 省略。 */
  readonly version?: string;
  /**
    * W16 上下文变更嗅探种子（boot 建：主会话装配清单件（W33 起 = AGENTS.md 单件）的 bootHash + 同刻 mtime+size 水位，
    * 清单序 = memorySources 声明序 = notice 组输出序）。缺省 = 嗅探关闭，
    * send/voiceSend 逐字节旧行为（side/子会话绝不受此项影响）。
    * W25：skills 接线时清单尾追加 `skills/catalog` 合成源种子（content=boot catalog 块全文，
    * mtimeMs 槽=重载代号）；registry 对磁盘循环跳过该保留路径。
    */
  readonly contextChange?: {
    readonly workspaceRoot: string;
    readonly files: readonly ContextFileSeed[];
  };
  /**
   * W25 skills 热重载嗅探缝（boot 接 loader 现面；未接 = 嗅探源集无 skills/catalog 合成源）。
   * 接线前提 = contextChange 同批接好（水位模板缺位 ⇒ 嗅探整体关闭，逐字节旧行为）。
   */
  readonly skillsSniff?: SkillsSniff;
  /**
   * W23-A 发线面持久回调（逐会话包 sid 后透传 MainSessionLoop.onWireSnapshot）：
   * 主会话每次 LLM call 解析完成后恰好一次；boot 装配注入 = wire-cache 落盘面。
   * 缺省 = 不挂（旧调用面逐字节不变，side/子会话经各自端口独立接同面）。
   */
  readonly onWireSnapshot?: (
    sessionID: string,
    snapshot: WireRequestSnapshot,
    providerPayload: string | null,
  ) => void;
  /**
   * W23-B 会话 meta sidecar（标题/归档/置顶持久面；boot 装载注入）。缺省 = 无 meta 面
   * （list() 视图 archived 恒 false、title 缺席；title/archive 端点 404 not_wired 语义
   * 由"registry 无此 sid 且无 meta 条目"天然成立）。
   */
  readonly meta?: SessionMetaStore;
  /**
   * W23-B createdAt 数据源（boot 建：主 store 各 sid 转录首时间戳快照）。
   * 返回 null = 不在 boot 快照（新会话 ⇒ 取 now）。注入时刻 = #ensure 建记录时刻。
   */
  readonly createdAtOf?: (sessionID: string) => number | null;
}

/**
 * W25 skills 热重载嗅探缝：主会话准入时刻由 registry 消费（与 W16 记忆嗅探同一缝）。
 * boot 装配把 loader 现面包成本对象；数据级纪律（fail-soft、正文绝不进 text）在 loader 侧保证。
 */
export interface SkillsSniff {
  /** 准入时刻全量重扫 loader（同步、fail-soft、绝不抛：失败=保留旧 catalog，warn 由实现方落）。 */
  rescan(): void;
  /** 现读 catalog 视图：text = 与 hook 追加进 system prompt 的尾块逐字节同源的块文本。 */
  snapshot(): { readonly text: string; readonly generation: number };
}

/**
 * W13 上下文预览提供者（registry 结构上实现：主会话内存快照 / 副会话 trace 反推）。
 * 路由测试可注入 fake provider 断言响应形状。
 */
export interface ContextProvider {
  contextView(sessionID: string): Promise<ContextView | undefined>;
}

/** 路由装配依赖（照 T26 http 骨架的 register* 模式）。 */
export interface SessionApiDeps {
  readonly registry: SessionRegistry;
  /**
   * W13：GET /sessions/:id/context 的取数口；缺省 = 用 registry 自身（其实现
   * contextView）。既有测试只传 { registry } 的调用面逐字节不变。
   */
  readonly context?: ContextProvider;
  /**
   * W17-B：/context/full v2 的 manifest 块（boot 一次装配的只读引用清单）。
   * 缺省/未接线 = 响应挂 manifest:null（面板诚实留空面）；wire 键恒在场（取 core 捕获口）。
   * W25 加性形态：可传工厂函数——skills 热重载后清单的 skillFiles 段须即刻现算新值
   * （boot 传 `() => assembleContextManifest(...)`，观测面 truthfulness 口径"一个字都不准遗漏"）。
   */
  readonly manifest?: ContextManifest | null | (() => ContextManifest);
  /**
   * W23-A：/context/full 的发线面持久缓存读口（wire/{sid}.json）。三段回落：
   * live 槽在场 = source "live"；loop 在而槽空 + 缓存在场 = basis "live" + source "cache"；
   * 无 loop + 缓存在场 = basis "cache" 200（侧/子会话重启后可查）；皆无 = 404 原纪律。
   * 缺省/未接线 = 回落面关闭（逐字节旧行为：无槽 wire:null、无 loop 404）。
   */
  readonly wireCache?: { read(sessionID: string): WireCacheRecord | null };
  /** W23-A：basis:"cache" 重建面的 contextWindow 数据源（boot 模型句柄现值；缺省 null）。 */
  readonly contextWindow?: number | null;
  /**
   * T3 会话列表开关（loom.yaml `server.sessionList` 的接线终点）：仅显式 `true` 开放
   * `GET /sessions`（含 `?archived=1`）；键缺席/false = 404 `session_list_disabled`。
   * `POST /sessions` 与全部逐会话端点不受本门约束。
   */
  readonly sessionList?: boolean;
  /**
   * T3 boot 解析出的主会话 id（serve/boot 注入 T2 `resolveMainSession` 的结果）：
   * `GET /sessions/main` 以此为准；键缺席 = 回落 `registry.defaultMainSessionId()`。
   */
  readonly mainSessionId?: string;
}

/**
 * W42b busy 排队项（纯内存 + sidecar `{text, at}` 两列）：
 * - `text` = 消息正文；`at` = 受理时刻（= steer 注入内核时的 user 消息 timestamp，
 *   settle/recovery 的 `(content,timestamp)` 对账键）。
 * - `consumed` = 该项已被选作某一轮 prompt（idle send 受理即标记；#drainQueue 选中时标记）。
 *   **纯内存，绝不进 sidecar**——重启后一律按"未消费"重灌，由 store 精确对账决定去留。
 *   收尾 settle 以 store 证据摘队；缺席则清标志留队重试。
 * - `drained` = 内核已在 turn 边界把该项 push 进本轮 `_messages`（onDrained 唯一写入点）。
 *   收尾 settle 读 store 确认该 user 消息已落盘后才摘队；缺席则清标志留给下一轮 prompt。
 * - `steerHandle` = 在途轮 steer 取消句柄（**纯内存，绝不进 sidecar**）。收尾仍 park 则
 *   `cancel()` 撤回并清空，该项留给下一轮 prompt 恰消费一次。
 *
 * 受理时刻**不写 store**：消息只随内核 turn 边界 flush 落盘，保证转录顺序 = 实际对话顺序
 * （前序 toolResult 在前，busy 消息在后）。
 */
export interface SendQueueItem {
  readonly text: string;
  readonly at: number;
  consumed?: boolean;
  drained?: boolean;
  /** 显式 `| undefined`：exactOptionalPropertyTypes 下 finally 需直接置 undefined 解绑。 */
  steerHandle?: SteerHandle | undefined;
  /**
   * T5 重放标记：键缺席/"prompt" = 普通队列行；"replay" = 失败回合的重放行——
   * 其 prompt 已在转录中，出队时走 `continueRun()` 而非 `run(text)`，绝不二次注入。
   * 显式 `| undefined`：settle 非持久项与恢复降级需直接置 undefined 清标。
   */
  mode?: "prompt" | "replay" | undefined;
  /** T5 已重放次数（仅 replay 行；上限 = SessionRegistryOptions.failedTurnReplayRetries）。 */
  attempts?: number | undefined;
  /** T5 下次可重放时刻（epoch ms）；未来时刻由 #drainQueue 定时器等待。 */
  nextAt?: number | undefined;
}

/** W55 待发队列的派生态（前端 pending 渲染用；由 SendQueueItem 单一真源派生）。 */
export interface PendingItemView {
  readonly text: string;
  readonly at: number;
  /**
   * - `queued`：尚未被任何轮消费（含已 steer park、等 turn 边界 drain 的项）；
   * - `running`：已被选作当前/下一轮 prompt（consumed）；
   * - `drained`：内核已在 turn 边界消费、等待 settle 落盘证据。
   */
  readonly state: "queued" | "running" | "drained";
}

/** 待发队列读模型（registry.pendingView 返回；未知会话 = undefined）。 */
export interface SessionPendingView {
  readonly sessionID: string;
  readonly pending: readonly PendingItemView[];
}

/** 注册表内部对一课的持有物（loop + 事件枢纽 + 状态机 + busy 排队队列）。 */
export interface SessionRecord {
  readonly sessionID: string;
  readonly loop: MainSessionLoop;
  readonly hub: EventHub;
  /**
   * 本会话的上下文变更侦听器（#ensure 建；未接线上下文嗅探 = null 旧行为）。
   * 主会话 contextCheckEachTurn=false：只在准入 peek + session-start/compaction rebase。
   */
  readonly contextWatcher: SessionContextWatcher | null;
  /** W23-B 诞生时刻（视图排序键；#ensure 建记录时刻定值，后续不变）。 */
  readonly createdAt: number;
  status: SessionStatus;
  lastError: string | null;
  turns: number;
  running: Promise<void> | null;
  /** 本轮最近一次已受理 flow_commit（session.idle 投影；run 起点复位；flow 未接线恒 null）。 */
  flow: FlowDraft | null;
  /** T5 待触发的重放定时器（queue 头部 replay 行的 nextAt 驱动；null = 无在途定时器）。 */
  replayTimer?: ReturnType<typeof setTimeout> | null;
  /**
   * W16-F1 busy 排队（对齐 opencode prompt_async 的排队语义）：在途轮未收尾时
   * 到达的文本消息按 FIFO 滞留于此，上限 `SEND_QUEUE_CAP`（超限回压 409）；
   * 每轮收尾（#start finally，idle/error 皆可）出队一条起新轮。
   * abort 只掐当前轮、**不清队列**；voiceSend 不入队（自带先中止再发送通道）。
   * W42b：项只存内存 + sidecar `{text,at}`；turn 边界随内核 flush 落盘、收尾 settle 摘队。
   * 重启恢复按 `(content,timestamp)` 对账（见 SendQueueItem）。
   */
  queue: SendQueueItem[];
  /**
   * W16-F2 语音后台链：voiceSend 立接立回后，abort→等收尾→起轮挂在此链尾串行
   * （语音消息严格 FIFO、恰起轮一次）；初值 = 已完成 Promise。
   */
  voiceTail: Promise<void>;
}

/**
 * 发送结果（路由据此回码）。W16-F1 三态：
 *   - accepted 直发：空闲即刻起轮；
 *   - accepted+queued：busy 排队受理（202，出队后照常起轮）；
 *   - accepted:false reason:"busy"：队列满回压（路由 409，背压真源）。
 * W42b 拒收态携带背压读数（queueCapacity/queueLength 直出 409 错误体，客户端自知余量）。
 * W56 accepted+interrupted：忙时抢占已受理（202）——当前轮被 abort，新消息成为下一轮
 * prompt；既有排队项原序保留为其 followers（绝不丢弃）。
 */
export type SendOutcome =
  | { readonly accepted: true; readonly sessionID: string }
  | { readonly accepted: true; readonly queued: true; readonly sessionID: string }
  | { readonly accepted: true; readonly interrupted: true; readonly sessionID: string }
  | {
      readonly accepted: false;
      readonly reason: "busy";
      readonly sessionID: string;
      readonly queueCapacity: number;
      readonly queueLength: number;
    };
