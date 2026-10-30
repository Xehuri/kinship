/**
 * T27 会话域 —— 会话注册表（主会话 loop + 事件枢纽 + 状态机）。
 *
 * 一课一会话（backend `local_sessions` 语义的单体）：sessionID（无连字符，复用
 * core/subagent/ids.ts 造号）→ 一个 MainSessionLoop（T10）+ 一个 EventHub（T29）。
 *
 * 状态迁移（前端 `session.status` 词表 busy/idle/error）：
 *   idle --send--> busy --run 完成--> idle
 *                       \--抛错--> error --下一次 send--> busy
 *   busy --send--> 202 排队（W16-F1 FIFO，上限 SEND_QUEUE_CAP，满则 409 回压）；
 *                  idle 终态收尾把整条队列合并进下一次 run（W55），error 终态逐条接力。
 * abort：busy --abort--> （当前 run 以 aborted 收尾）--> idle；只掐当前轮、不清排队。
 * voice（W16-F2）：立接立回 202，abort→收尾→起语音轮走 voiceTail 后台链（不入排队）。
 *
 * SSE 事件：live 轨（text_delta → message.part.delta）由 EventHub 的 pump 自动捕；
 * 会话状态（session.status busy / session.idle 带 id / session.error）由本注册表经
 * `hub.publish()` 域注入 —— 与 T29 声明的「运行状态/投递/告警三族由域层 publish」一致。
 *
 * 不做：不实现 SSE 订阅端点（T29 的 sseStreamHandler，T31 装配）；不造帧形状（T29）。
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { Api, FlowStore, FlowSubject, Hook, LogLevel, Message, Model, RunSpan, SessionStore, StoredEntry, TraceRecord, WireRequestSnapshot } from "@axeuh/loom-core";
import { localDateKey, nextWakeAtOf, readTraceFile } from "@axeuh/loom-core";
import {
  ContextBaselineTemplate,
  seedContextWatermark,
  SessionContextWatcher,
  SKILLS_CATALOG_REL_PATH,
  type ContextChangeOutcome,
  type SessionContextDynamicSource,
  type SessionContextPreview,
  type SessionContextSource,
} from "@axeuh/loom-core/assembly";
import { MainSessionLoop } from "@axeuh/loom-core/main-loop";
import type { LoopEvent, MainLoopResult } from "@axeuh/loom-core/main-loop";
import { newSubagentSessionId } from "@axeuh/loom-core/subagent/ids";
import { EventHub, readFlow, sanitizeId } from "../events/index.js";
import {
  createFlowWakeRenderer,
  type FlowObservationInput,
  type FlowObservationSink,
  type FlowWakeRenderer,
} from "../flow/index.js";
import { pendingSubjects } from "../flow/flow-wake.js";
import type { SessionMetaEntry, SessionMetaStore } from "../session-meta.js";
import { reminderNotifyProps } from "../serve/run-reminder.js";
import { ptyExitNotifyProps } from "./pty-notify.js";
import { buildContextView, buildTraceContextView, type ContextView } from "./context.js";
import { readCompactionCache, writeCompactionCache, type ActiveCompaction } from "./compaction-cache.js";
import { CompactionStreamPublisher } from "./compaction-stream.js";
import {
  appendCompactionEvent,
  compactionEventKey,
  readCompactionEvents,
  type CompactionEvent,
} from "./compaction-events.js";
import {
  boundaryEventsFromStore,
  compactionEventFromSnapshot,
  mergeCompactionEvents,
} from "./compaction-history.js";
import { readHistoryPage, type HistoryPage, type HistoryQuery } from "./history.js";
import type {
  PendingItemView,
  SendOutcome,
  SendQueueItem,
  SessionCompactionsResponse,
  SessionPendingView,
  SessionRecord,
  SessionRegistryOptions,
  SessionStatusView,
  SessionView,
  WakeQueueEntryLike,
} from "./types.js";

/** 前端的会话状态值含 `{type}` 包裹（对齐 T29 事件 + useStreamingMessage.parseSessionStatus）。 */
function statusProps(status: string): { readonly status: { readonly type: string } } {
  return { status: { type: status } };
}

/** W16-F1 busy 排队上限（对齐 opencode prompt_async 的受理面）；满则回压 409，绝不无界滞留。 */
const SEND_QUEUE_CAP = 10;

/** boot 恢复时 overdue flow 唤醒的小宽限：避免重启瞬间全部会话同时起轮（wake 风暴）。 */
const FLOW_WAKE_BOOT_GRACE_MS = 5_000;

export class SessionRegistry {
  readonly #opts: SessionRegistryOptions;
  readonly #records = new Map<string, SessionRecord>();
  /**
   * W12 提醒滞留（纯内存两层）：目标 sid 在册 → 直接进 loop 边界队列（滞留=loop 侧，
   * pendingReminderCount 可见）；未在册 → 此 map 按 sid 滞留，#ensure 建记录时冲刷。
   * 无任何会话时 → #orphanReminders，首个注册会话冲刷（外部代投/cron 场景提醒有着落）。
   */
  readonly #detached = new Map<string, string[]>();
  #orphanReminders: string[] = [];
  /**
   * W13 上下文预览：会话 → 最近一次装配快照（内存，重启清空；不落新文件）。
   * 主会话在每轮收尾从 loop.events() 的最后一个 assembly 记录构造（与 assembly-trace
   * 消费同一事件）；副会话无此内存面，查询时从当日 trace assembly span 反推。
   */
  readonly #contextViews = new Map<string, ContextView>();
  /**
   * W16-D 模板水位 = 跨会话共享的最近已消费状态：boot 种子（memory 实载件同刻
   * stat + content）起算，随每次准入消费/检查同步前进——变更后新建的 sid 注册时从
   * 模板快照种入自己的 SessionContextWatcher ⇒ 不吃已消费 diff 的重播（W16-A §3
   * 口径"新会话吃 boot 冻结前缀、无 notice"）。null = 上下文嗅探整体未接线
   * （逐字节旧行为）。
   */
  readonly #contextTemplate: ContextBaselineTemplate | null;
  /** W23-B 会话 meta sidecar（boot 装载注入；未接 = 视图无 title/archived、命令端点拒绝）。 */
  readonly #meta: SessionMetaStore | undefined;
  /** T5 失败回合重放上限（0 = 禁用，收尾/队列行为逐字节旧面）。 */
  readonly #replayRetries: number;
  /** T5 重放退避基数毫秒（base×2ⁿ；0 = 立即重放）。 */
  readonly #replayBackoffMs: number;
  /** L6 flow 面（未接线 = undefined，旧路径逐字节）。 */
  readonly #flow: { readonly store: FlowStore; readonly wake: FlowWakeRenderer } | undefined;
  /** flow 唤醒计划表：session → (subjectAt → 实际调度时刻)；同 subjectAt 不重复 arm。 */
  readonly #flowWakePlans = new Map<string, Map<number, number>>();
  /** L9 观察窗（未接线 = undefined，旧路径逐字节）。 */
  readonly #flowObservation: FlowObservationSink | undefined;

  constructor(opts: SessionRegistryOptions) {
    this.#opts = opts;
    this.#meta = opts.meta;
    this.#flowObservation = opts.flowObservation;
    this.#replayRetries = opts.failedTurnReplayRetries ?? 0;
    this.#replayBackoffMs = opts.failedTurnReplayBackoffMs ?? 0;
    this.#flow =
      opts.flow === undefined
        ? undefined
        : {
            store: opts.flow.store,
            wake: createFlowWakeRenderer({ store: opts.flow.store }),
          };
    // W25：skillsSniff 单接（无 contextChange）也建模板——合成源水位需要一个可拷贝的模板；
    // 两者皆未接 = null（嗅探整体关闭，逐字节旧行为）。
    this.#contextTemplate =
      opts.contextChange === undefined && opts.skillsSniff === undefined
        ? null
        : new ContextBaselineTemplate(seedContextWatermark(opts.contextChange?.files ?? []));
  }

  /** 新建会话并登记（造无连字符 id）。W11a P2：登记成功即广播 session.created。 */
  create(): SessionRecord {
    const sessionID = (this.#opts.newSessionID ?? newSubagentSessionId)();
    const rec = this.#ensure(sessionID);
    this.#publishCreated(rec);
    return rec;
  }

  /** 取（惰性建）会话记录。 */
  ensure(sessionID: string): SessionRecord {
    return this.#ensure(sessionID);
  }

  /** W23-B 该 sid 的 meta 条目（未接 meta = undefined）。 */
  #metaEntry(sessionID: string): SessionMetaEntry | undefined {
    return this.#meta?.get(sessionID);
  }

  get(sessionID: string): SessionRecord | undefined {
    return this.#records.get(sessionID);
  }

  has(sessionID: string): boolean {
    return this.#records.has(sessionID);
  }

  /**
   * 全部已登记会话视图（W23-B 域三件套面）。
   * 归档过滤：缺省排除归档；"only" = 只列归档；"all" = 不分（停机拆 hub 等全域遍历用）。
   * **视图级倒序**（createdAt 新→旧）；`#records` 插入序**不动**——defaultMainSessionId()
   * 的"首注册=缺省主会话"命门依赖它（W12 提醒靶），此处排序只影响 GET /sessions 呈现。
   */
  list(filter?: { archived?: "exclude" | "only" | "all" }): readonly SessionView[] {
    const mode = filter?.archived ?? "exclude";
    const views: SessionView[] = [];
    for (const rec of this.#records.values()) {
      const view = this.#viewOf(rec);
      if (mode === "exclude" && view.archived) continue;
      if (mode === "only" && !view.archived) continue;
      views.push(view);
    }
    views.sort((a, b) => b.createdAt - a.createdAt); // 稳定排序：同刻并列保持插入序（主会话先）
    return views;
  }

  /** 单个会话视图（与 list 行同形）；未知 sid = undefined。 */
  viewOf(sessionID: string): SessionView | undefined {
    const rec = this.#records.get(sessionID);
    return rec === undefined ? undefined : this.#viewOf(rec);
  }

  #viewOf(rec: SessionRecord): SessionView {
    const meta = this.#metaEntry(rec.sessionID);
    const title = typeof meta?.title === "string" && meta.title.length > 0 ? meta.title : undefined;
    return {
      sessionID: rec.sessionID,
      status: rec.status,
      createdAt: rec.createdAt,
      ...(title === undefined ? {} : { title }),
      archived: meta?.archived === true,
    };
  }

  /**
   * W23-B 设/清标题（trim 由调用方做完；空串=清除声明）。未知 sid（不在册且无 meta
   * 条目）= false → 路由 404。成功 = meta sidecar 落盘（未接 meta = 仅内存不可持久 →
   * 视作未接线 false）。
   */
  setTitle(sessionID: string, title: string | null): boolean {
    if (this.#meta === undefined) return false;
    if (!this.isKnownSession(sessionID)) return false;
    this.#meta.mutate(sessionID, { title: title === null ? undefined : title });
    return true;
  }

  /** W23-B 归档/取消归档（同 setTitle 的未知 sid/未接线纪律）。 */
  setArchived(sessionID: string, archived: boolean): boolean {
    if (this.#meta === undefined) return false;
    if (!this.isKnownSession(sessionID)) return false;
    this.#meta.mutate(sessionID, { archived: archived ? true : undefined });
    return true;
  }

  /** W23-B 未知 sid 判别：在册 或 meta 已有条目（归档面重启后仍在 meta）。 */
  isKnownSession(sessionID: string): boolean {
    return this.#records.has(sessionID) || (this.#meta?.has(sessionID) ?? false);
  }

  /** 会话状态视图（未知会话 = undefined，路由转 404）。 */
  statusView(sessionID: string): SessionStatusView | undefined {
    const rec = this.#records.get(sessionID);
    if (rec === undefined) return undefined;
    return {
      sessionID: rec.sessionID,
      status: rec.status,
      lastError: rec.lastError,
      activeRuns: this.#opts.runEngine?.activeCount() ?? 0,
      turns: rec.turns,
      queueLength: this.#pendingQueueLength(rec),
    };
  }

  /**
   * W55 待发队列读模型：busy 排队项与正在跑的 idle prompt 都从这里可见，且保持 FIFO。
   * 未知会话 = undefined（与 statusView 同 404 口径）；列表为空 = 队列已清。
   */
  pendingView(sessionID: string): SessionPendingView | undefined {
    const rec = this.#records.get(sessionID);
    if (rec === undefined) return undefined;
    return { sessionID: rec.sessionID, pending: pendingItemViews(rec.queue) };
  }

  /** 取会话的事件枢纽（T31 装配 sseStreamHandler 时按 sessionID resolve）。 */
  hubOf(sessionID: string): EventHub | undefined {
    return this.#records.get(sessionID)?.hub;
  }

  /** W52：跨重启保留最后一次 active 压缩快照；live view 缺席时由 GET /compaction 回读。 */
  compactionCacheOf(sessionID: string): ActiveCompaction | null {
    return readCompactionCache(this.#stateRoot(), sessionID);
  }

  saveCompactionCache(sessionID: string, body: ActiveCompaction): void {
    try {
      writeCompactionCache(this.#stateRoot(), sessionID, body);
    } catch (err) {
      this.#journal("warn", "loom compaction cache write failed", {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * C2 历史压缩摘要视图（GET /sessions/:id/compactions）：durable boundary + append-only
   * auto 事件日志 + 当前 live/cache 观察面按摘要哈希合并、时间升序。未知会话 = undefined
   *（路由 404）；已知但从未压缩 = 空 events（合法空面）。
   *
   * seed-on-read：live/cache 是"当前最后一份摘要"，若日志里还没有该摘要，就地在本次查询中
   * 追加落盘——即使本次进程启动后没有任何 run-end 钩子跑过（例如重启后首次查询），当前
   * 摘要也会进入历史；同摘要后续查询按哈希去重，不再增长。
   */
  async compactionsView(sessionID: string): Promise<SessionCompactionsResponse | undefined> {
    if (!this.isKnownSession(sessionID)) return undefined;
    const loop = this.loopOf(sessionID) ?? this.ensure(sessionID).loop;
    // T7b：先 hydrate（记忆化）再读 live view——重启后 durable boundary 重放为 restored
    // view，否则 candidates 只剩旧缓存，历史会把 coveredCount 1 的重放边界漏掉。
    await loop.hydrate();
    const recordedAt = (this.#opts.now ?? Date.now)();
    const view = loop.session.compactionView;
    const liveEvent = view === null ? null : compactionEventFromSnapshot(view, recordedAt);
    const cached = this.compactionCacheOf(sessionID);
    const cachedEvent = cached === null ? null : compactionEventFromSnapshot(cached, recordedAt);
    const candidates = [liveEvent, cachedEvent].filter((event): event is CompactionEvent => event !== null);

    const boundaries = await this.#boundaryEvents(sessionID);
    const log = readCompactionEvents(this.#stateRoot(), sessionID);
    if (log.skipped > 0) {
      this.#journal("warn", "loom compaction event log skipped corrupt lines", {
        sessionID,
        skipped: log.skipped,
      });
    }
    const known = new Set<string>();
    for (const event of [...boundaries, ...log.events]) known.add(compactionEventKey(event.summaryText));
    for (const event of candidates) {
      const key = compactionEventKey(event.summaryText);
      if (known.has(key)) continue;
      known.add(key);
      try {
        appendCompactionEvent(this.#stateRoot(), sessionID, event);
      } catch (err) {
        this.#journal("warn", "loom compaction event append failed", {
          sessionID,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { sessionID, events: mergeCompactionEvents(boundaries, log.events, candidates) };
  }

  /** 按归属 store 解析 boundary（口径同 history()：首个 getLeafId 非空的 store 即真源）。 */
  async #boundaryEvents(sessionID: string): Promise<CompactionEvent[]> {
    const stores: readonly SessionStore[] = [this.#opts.store, ...(this.#opts.historyStores ?? [])];
    for (const store of stores) {
      try {
        if ((await store.getLeafId(sessionID)) === null) continue;
        return await boundaryEventsFromStore(store, sessionID);
      } catch (err) {
        this.#journal("warn", "loom compaction boundary read failed", {
          sessionID,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return [];
  }

  /** 取会话的主循环（装配产物 assemblies() 的观测面；冒烟/测试核验记忆注入前缀用）。 */
  loopOf(sessionID: string): MainSessionLoop | undefined {
    return this.#records.get(sessionID)?.loop;
  }

  /**
   * 缺省主会话（W12 目标解析回落）：boot 解析出的 mainSessionID 优先；未接线时保持旧面
   * （**首注册** sid，Map 插入序）。parentSessionId 不在账本行形状内（内核切片冻结），
   * 归属由 serve 侧 run-reminder router 旁路登记后走 queueReminder(target)。
   */
  defaultMainSessionId(): string | undefined {
    return this.#opts.mainSessionID ?? this.#records.keys().next().value;
  }

  /**
   * W12 提醒入队（transient 通道，绝不进转录）：target=在册主会话 sid → 直投其 loop
   * 边界队列；target 未在册 → 按 sid 滞留；target=undefined 且无会话 → orphan 滞留，
   * 首个注册会话冲刷。滞留可见性 = pendingReminderCount / loop.pendingReminders()。
   */
  queueReminder(target: string | undefined, line: string): void {
    const sid = target ?? this.defaultMainSessionId();
    if (sid === undefined) {
      this.#orphanReminders.push(line);
      return;
    }
    const rec = this.#records.get(sid);
    if (rec === undefined) {
      const queue = this.#detached.get(sid);
      if (queue === undefined) this.#detached.set(sid, [line]);
      else queue.push(line);
      return;
    }
    rec.loop.remind(line);
  }

  /**
   * W21 终态推送投递（发射时刻单点）：run-reminder router 的 onTerminal 唯一出口。
   * 目标解析与 queueReminder 同（target ?? 缺省主会话）。分派规则：
   *  - **无在册落点**（sid 未定义=无会话，或指定但未注册）→ 回落 queueReminder 三层滞留设计，
   *    发射时刻无 hub 即无 toast 落点、无会话可唤醒，行留 transient 队列待其注册后随首轮边界注入；
   *  - **在册且空闲**（running===null 且 SEND 队列空）→ 发 delivery.notify 帧 + 起唤醒轮
   *    （提醒行=该轮 durable user 消息，模型即刻见、可 task_fetch；**不再进边界队列**——行即 prompt，
   *    杜绝"唤醒 prompt + 边界注入"双份）；
   *  - **在册但忙/有排队** → 发 delivery.notify 帧 + queueReminder transient 边界注入
   *    （W12 busy 路径逐字节不变，无额外轮）。
   * 每终态恰一帧：drain 时刻发帧路径已下线（见 #ensure 注释），杜绝"发射一帧+drain一帧"双弹。
   * 唤醒轮走 #start（主会话 loop 轮），其终态不再经内核 onRunTerminal → 无唤醒递归。
   */
  deliverReminder(target: string | undefined, line: string): void {
    const sid = target ?? this.defaultMainSessionId();
    const rec = sid === undefined ? undefined : this.#records.get(sid);
    if (rec === undefined) {
      this.queueReminder(target, line);
      return;
    }
    rec.hub.publish("delivery.notify", rec.sessionID, reminderNotifyProps(line));
    if (rec.running === null && this.#pendingQueueLength(rec) === 0) {
      this.#start(rec, line);
    } else {
      rec.loop.remind(line);
    }
  }

  /**
   * 后台任务退出唤醒（PTY 等）：与 deliverReminder 的差别 = busy 时**不**走 transient
   * 边界提醒（run 在下一个 turn 边界前收束时该提醒会滞留、永不触发）。这里把退出行
   * 作为 durable user 消息入 send 队列：空闲则 #drainQueue 立即起轮；忙则等当前轮
   * 收尾后由 #start finally 的 #drainQueue 起新轮（队列 sidecar 持久，重启可恢复）。
   * 系统通知不受 SEND_QUEUE_CAP 背压限制（生产者数量由 PTY 会话上限约束）。
   */
  deliverWake(
    target: string | undefined,
    line: string,
    notifyProps?: Readonly<Record<string, unknown>>,
  ): void {
    const sid = target ?? this.defaultMainSessionId();
    if (sid === undefined) {
      this.queueReminder(target, line);
      return;
    }
    const rec = this.#records.get(sid);
    if (rec === undefined) {
      this.queueReminder(target, line);
      return;
    }
    rec.hub.publish("delivery.notify", rec.sessionID, notifyProps ?? ptyExitNotifyProps(line));
    const at = (this.#opts.now ?? Date.now)();
    rec.queue.push({ text: line, at });
    this.#syncQueueSidecar(rec);
    this.#publishPending(rec);
    if (rec.running === null) this.#drainQueue(rec);
  }

  /**
   * WakeScheduler 的 render 缝（同步契约）：flow 未接线 / 无缓存 / at 时刻无 due 主体 = null。
   * 缓存由 #syncFlowWake 与 reconcileFlowWakes 刷新；null 让调度器跳过投递并删 sidecar。
   */
  flowWakeLine(sessionID: string, at: number): string | null {
    return this.#flow?.wake.render(sessionID, at) ?? null;
  }

  /** L9 观察：从已武装计划反查 scheduledAt 对应的 subjectAt（投递事件用；查不到 null）。 */
  flowWakeSubjectAt(sessionID: string, scheduledAt: number): number | null {
    const plans = this.#flowWakePlans.get(sessionID);
    if (plans === undefined) return null;
    for (const [subjectAt, at] of plans) {
      if (at === scheduledAt) return subjectAt;
    }
    return null;
  }

  /**
   * boot 恢复：按 FlowStore 的 pending 主体重建唤醒计划。overdue 统一用 now+grace 小宽限，
   * 避免重启瞬间唤醒风暴；无 pending / 全 closed = 清除（onAutoWake null + 删 sidecar）。
   * 必须在 recoverSendQueues 与 WakeScheduler.restore 之后调用。
   */
  async reconcileFlowWakes(): Promise<void> {
    const flow = this.#flow;
    if (flow === undefined) return;
    const now = (this.#opts.now ?? Date.now)();
    let sessionIDs: readonly string[];
    try {
      sessionIDs = await flow.store.listSessionIds();
    } catch (err) {
      this.#journal("warn", "loom flow wake reconcile read failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (this.#opts.onWakeReconcileSource !== undefined) {
      for (const sessionID of sessionIDs) {
        try {
          const subjects = await flow.wake.refresh(sessionID);
          this.#reconcileFlowQueue(sessionID, subjects, now);
        } catch (err) {
          this.#journal("warn", "loom flow wake reconcile read failed", {
            sessionID,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return;
    }
    for (const sessionID of sessionIDs) {
      let earliest;
      try {
        earliest = await flow.store.earliestPending(sessionID, now);
      } catch (err) {
        this.#journal("warn", "loom flow wake reconcile pending read failed", {
          sessionID,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      try {
        await flow.wake.refresh(sessionID);
      } catch (err) {
        this.#journal("warn", "loom flow wake reconcile renderer refresh failed", {
          sessionID,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (earliest === null || earliest.next_decision_at === null) {
        this.#clearFlowWake(sessionID);
        continue;
      }
      const subjectAt = earliest.next_decision_at;
      if (this.#flowWakePlans.get(sessionID)?.has(subjectAt) === true) continue;
      const scheduledAt = subjectAt <= now ? now + FLOW_WAKE_BOOT_GRACE_MS : subjectAt;
      this.#armFlowWake(sessionID, subjectAt, scheduledAt);
    }
  }

  /** 该会话滞留提醒数（loop 边界队列 + 未注册滞留 map；测试/运维可见性面）。 */
  pendingReminderCount(sessionID: string): number {
    const loopPending = this.#records.get(sessionID)?.loop.pendingReminders() ?? 0;
    return loopPending + (this.#detached.get(sessionID)?.length ?? 0);
  }

  /** 读一页历史（真源 = 注入的 SessionStore；游标 x-next-cursor 语义见 history.ts）。 */
  async history(sessionID: string, query: HistoryQuery): Promise<HistoryPage> {
    // W9 切片0 读侧兜底（决策）：子/副转录落在主文件之外的独立 store（现网主历史面冻结、
    // 不合并文件）。按**归属**路由：首个 getLeafId 非空（持有该 sid）的 store 即真源；
    // 全域无人持有 → 回落主 store 读，保持未知 sid 的空页旧语义（主会话读路径逐字节不变）。
    const stores: readonly SessionStore[] = [this.#opts.store, ...(this.#opts.historyStores ?? [])];
    for (const s of stores) {
      if ((await s.getLeafId(sessionID)) !== null) return readHistoryPage(s, sessionID, query);
    }
    return readHistoryPage(this.#opts.store, sessionID, query);
  }

  /**
   * W23-A 缓存基面重建用：durable 转录全量（无分页）。归属路由口径同 history()
   * （主 store 优先，再查 historyStores——侧/子会话的转录在他处文件）。
   * 重放语义与 core resume 同谱：message 依序收集；compaction_boundary 出现即
   * **替换前缀**为 summary（被压缩吞掉的旧消息不再呈现）；terminal 跳过（元数据非消息）。
   * store 读炸 = 空数组（缓存面诚实降级为"转录不可得"，不反噬发线面在场性）。
   */
  async transcriptMessages(sessionID: string): Promise<readonly Message[]> {
    const stores: readonly SessionStore[] = [this.#opts.store, ...(this.#opts.historyStores ?? [])];
    for (const s of stores) {
      try {
        if ((await s.getLeafId(sessionID)) === null) continue;
        const path = await s.getPathToLeaf(sessionID);
        const out: Message[] = [];
        for (const stored of path) {
          const entry = stored.entry;
          if (entry.kind === "message") out.push(entry.message);
          else if (entry.kind === "compaction_boundary") out.splice(0, out.length, entry.summary);
        }
        return out;
      } catch {
        return [];
      }
    }
    return [];
  }

  /**
   * 发消息。W16-F1 排队语义（对齐 opencode prompt_async）：在途轮未收尾时按 FIFO 入队
   * 并即刻 202 受理（queued:true）；每轮收尾（#start finally）出队一条起新轮。
   * 队列满（SEND_QUEUE_CAP）才回压 409；abort 只掐当前轮、不清队列。
   *
   * W56 抢占（interruptOnSend === true）：busy 时新消息 **unshift 到队首** + abort 当前轮，
   * 返回 interrupted:true；当前轮 finally 的 #drainQueue 取其作下一轮 prompt，既有排队项
   * 保持原序作为 followers 合并进该轮（绝不丢弃/重排）。本路径**刻意绕开 SEND_QUEUE_CAP**：
   * 用户即时意图优先于排队容量闸（每次抢占只 +1，后续发送仍按 cap 回压），且不 steer 本项
   * （当前轮即将 abort，steer 会与 abort 竞态并违背"新消息=下一轮 prompt"语义）。
   *
   * busy 项**只在内存 + sidecar**：立刻 steer 进在途轮 inbox，由内核在 turn 边界 push 并
   * 随本轮 flush 按真实对话顺序落盘（前序 toolResult 在前）。受理时刻不写 store、不发
   * user echo；收尾 settle 以 store 证据（content,timestamp 全等）决定摘队或留给下一轮。
   */
  send(sessionID: string, text: string): SendOutcome {
    const rec = this.#ensure(sessionID);
    if (rec.running !== null) {
      if (this.#opts.interruptOnSend === true) {
        const item: SendQueueItem = { text, at: (this.#opts.now ?? Date.now)() };
        rec.queue.unshift(item);
        this.#syncQueueSidecar(rec);
        this.#publishPending(rec);
        rec.loop.abort("send:interrupt");
        return { accepted: true, interrupted: true, sessionID };
      }
      const pendingLength = this.#pendingQueueLength(rec);
      if (pendingLength >= SEND_QUEUE_CAP) {
        return {
          accepted: false,
          reason: "busy",
          sessionID,
          queueCapacity: SEND_QUEUE_CAP,
          queueLength: pendingLength,
        };
      }
      const item: SendQueueItem = { text, at: (this.#opts.now ?? Date.now)() };
      rec.queue.push(item);
      this.#syncQueueSidecar(rec);
      // W55 先发 pending 快照再 steer：受理可见性与 kernel 消费无关（SSE 订阅者立刻看到 queued）。
      this.#publishPending(rec);
      item.steerHandle = rec.loop.steer(
        { role: "user", content: text, timestamp: item.at },
        { onDrained: () => { item.drained = true; this.#publishPending(rec); } },
      );
      return { accepted: true, queued: true, sessionID };
    }
    // T5：空闲新消息 = 用户意志优先于待触发的重放——撤定时器并丢 replay 行（其 prompt 已在
    // 转录里，本轮新消息的普通 run 会从同一转录继续）；普通排队项保留，随后照旧起轮。
    if (this.#cancelReplay(rec)) this.#syncQueueSidecar(rec);
    // 起轮失败嗅探炸不拦轮（notice 缺席照常跑）。W16：只在**受理成功**时嗅探消费。
    let contextPreview: SessionContextPreview | null | undefined;
    try {
      contextPreview = this.#collectContextPreview(rec);
    } catch (err) {
      this.#journal("warn", "loom send context sniff failed (turn starts without notices)", {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
      contextPreview = null;
    }
    // W55 idle 直发也进队列（consumed 标记"正在跑"）：pending 读模型在首轮 flush 前即可见，
    // 收尾 settle 以 store 证据（text, at 全等）摘队——at 同时作为 promptTimestamp 落盘。
    const at = (this.#opts.now ?? Date.now)();
    rec.queue.push({ text, at, consumed: true });
    this.#syncQueueSidecar(rec);
    this.#publishPending(rec);
    this.#start(rec, text, { contextPreview, promptTimestamp: at });
    return { accepted: true, sessionID };
  }

  /**
   * W42b 队列耐重启：boot 时刻扫 `{stateRoot}/session/queue/*.json`，把崩溃前未跑完的
   * 排队项重灌进新 registry 并入队执行（有幸存项时首条起轮，其余随新轮 turn 边界消费）。
   *
   * 对账：先 hydrate，再按 `(content,timestamp)` 精确计数 `rec.loop.messages`。sidecar 行命中
   * 已载历史 = 该项早已落盘，直接丢弃（绝不再注入，也不起合成 run）；未命中 = 幸存项入队。
   * 坏 sidecar = 诚实丢弃（不 ensure、不入队、不假跑）+ WARN journal，文件留盘取证，
   * **绝不静默**。journal 每 sid 一行 `loom send queue recovered {sessionID,count}`。
   * 返回恢复条目总数（boot 日志/测试取证面）。
   */
  async recoverSendQueues(): Promise<number> {
    const dir = this.#queueDir();
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return 0; // 目录不在 = 无滞留队列（首启/从未 busy），零日志零副作用
    }
    let recovered = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const sid = name.slice(0, -".json".length);
      if (!VALID_SID_RE.test(sid)) {
        this.#journal("warn", "loom send queue sidecar skipped (bad session id in filename)", { file: join(dir, name) });
        continue;
      }
      let items: SendQueueItem[];
      try {
        const raw = readFileSync(join(dir, name), "utf8").trim();
        if (raw.length === 0) {
          this.#removeQueueSidecar(sid);
          continue;
        }
        items = normalizeQueueRows(JSON.parse(raw));
      } catch (err) {
        this.#journal("warn", "loom send queue sidecar unreadable", {
          sessionID: sid,
          error: err instanceof Error ? err.message : String(err),
        });
        continue; // 丢弃=不恢复该文件任何条目；WARN 响亮；文件留盘
      }
      if (items.length === 0) {
        this.#removeQueueSidecar(sid);
        continue;
      }
      const rec = this.#ensure(sid);
      // 顺序不变量：先 hydrate 再 reconcile。reconcile 会把缺失行补写进 store；若先补写再
      // hydrate，同一行会既在已载历史又在待出队队列，首次请求重复注入。
      try {
        await rec.loop.hydrate();
      } catch (err) {
        this.#journal("warn", "loom send queue recovery hydrate failed (items kept pending)", {
          sessionID: sid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        if (rec.loop.session.recoverStaleCompaction()) {
          this.#journal("info", "loom compaction stale state recovered for queue retry", {
            sessionID: sid,
          });
        }
      } catch (err) {
        this.#journal("warn", "loom compaction stale state recovery failed", {
          sessionID: sid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // 分区：hydrate 后的内核历史按 (content, timestamp) 精确计数；命中 = 该项早已落盘，
      // 只从 sidecar 消费、绝不再作 prompt/steer 注入（全命中也不起合成 run）。
      //
      // T5 崩溃限制（明示不在本片范围）：若进程死在 LLM error 之后、sidecar 改写
      // mode:"replay" 之前，落盘 sidecar 仍是普通 prompt 行；恢复时该行命中已落盘用户
      // 消息 → 按旧纪律丢弃，跨进程重放不会发生。要闭环需在 error 落账与 sidecar 同步
      // 之间做事务，本片明确不做。
      const loadedCounts = new Map<string, number>();
      for (const message of rec.loop.messages) {
        if (message.role !== "user" || typeof message.content !== "string") continue;
        const key = userMessageKey(message.content, message.timestamp);
        loadedCounts.set(key, (loadedCounts.get(key) ?? 0) + 1);
      }
      const pending: SendQueueItem[] = [];
      for (const item of items) {
        const key = userMessageKey(item.text, item.at);
        if (item.mode === "replay") {
          if ((item.attempts ?? 0) >= this.#replayRetries) {
            this.#journal("warn", "loom send queue replay cap reached (row dropped)", {
              sessionID: sid,
              attempts: item.attempts ?? 0,
            });
            continue;
          }
          const remaining = loadedCounts.get(key) ?? 0;
          if (remaining > 0) {
            // prompt 已在转录 → 保留 replay 行，按 nextAt 由 #drainQueue 走 continueRun()
            // （绝不因"已落盘"丢弃：失败轮正是 prompt 在、回答不在）。
            loadedCounts.set(key, remaining - 1);
            pending.push(item);
          } else {
            // prompt 根本没落盘 → 降级普通 prompt 行，按旧路径重新注入，绝不丢用户输入。
            pending.push({ text: item.text, at: item.at });
          }
          continue;
        }
        const remaining = loadedCounts.get(key) ?? 0;
        if (remaining > 0) {
          loadedCounts.set(key, remaining - 1);
        } else {
          pending.push({ text: item.text, at: item.at });
        }
      }
      rec.queue.push(...pending);
      this.#syncQueueSidecar(rec);
      this.#publishPending(rec);
      recovered += items.length;
      this.#journal("info", "loom send queue recovered", { sessionID: sid, count: items.length });
      if (pending.length > 0 && rec.running === null) {
        this.#drainQueue(rec);
      }
    }
    return recovered;
  }

  /**
   * 语音「先中止再发送」W16-F2 立接立回：响应不再同步等旧轮收尾（根除 hm aiohttp
   * 长轮 300s 超时假失败）——abort→等收尾→起语音轮挂进 voiceTail 后台链串行执行，
   * 语音消息严格 FIFO、恰起轮一次。不入 busy 文本队列、也不清它：出队轮接管话轮位时
   * 等其自然跑完再起语音轮（语音绝不与排队轮抢内核 _active）。
   */
  voiceSend(sessionID: string, text: string): SendOutcome {
    const rec = this.#ensure(sessionID);
    const prev = rec.voiceTail;
    rec.voiceTail = prev.then(() => this.#runVoiceTurn(rec, text)).catch(() => {
      /* 后台链吞断：起轮失败已由 #start 的 error 通道如实落 lastError，链断不复燃 */
    });
    return { accepted: true, sessionID };
  }

  /** 中止当前轮；命中在途 run 返回 true。 */
  abort(sessionID: string, reason = "abort requested"): boolean {
    const rec = this.#records.get(sessionID);
    if (rec === undefined || rec.running === null) return false;
    rec.loop.abort(reason);
    return true;
  }

  /**
   * 语音后台链单步（W16-F2）：掐掉起链时刻的在途轮 → 等收尾；若收尾瞬间有排队出队轮
   * 接管话轮位，等其自然跑完（**不再 abort**——abort 只掐语音到达时的当前轮）。
   * 静默（running null，F1 不变量下即队列空）后恰起一次语音轮。
   */
  async #runVoiceTurn(rec: SessionRecord, text: string): Promise<void> {
    let abortFired = false;
    for (;;) {
      if (rec.running === null) break;
      if (!abortFired) {
        abortFired = true;
        rec.loop.abort("voice:abort-then-send");
      }
      await rec.running.catch(() => {});
    }
    let contextPreview: SessionContextPreview | null | undefined;
    try {
      contextPreview = this.#collectContextPreview(rec);
    } catch (err) {
      this.#journal("warn", "loom voice send context sniff failed (turn starts without notices)", {
        sessionID: rec.sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
      contextPreview = null;
    }
    this.#start(rec, text, { contextPreview });
  }

  /**
   * W13 上下文预览：主会话内存快照命中优先；未命中（副会话 / 重启后）从当日 trace
   * assembly span + sessionStore 行数反推。未知会话返回 undefined（路由 404）。
   */
  async contextView(sessionID: string): Promise<ContextView | undefined> {
    const cached = this.#contextViews.get(sessionID);
    if (cached !== undefined) return cached;
    return this.#traceContextView(sessionID);
  }

  // ───────────────────────── 内部 ─────────────────────────

  /**
   * W16-D 准入预览（docs/01 D16 = mtime+size 轮询，绝不接 fs.watch/hotreload）：
   * 会话自己的 SessionContextWatcher.peek() 对照本会话水位做非变异检测；有动作时
   * 按 W17-F 既定形状发 context.notice 帧（帧先于 #start 的 busy 帧），并把本批观测
   * 施加到共享模板（此后新注册 sid 从这里起步，已消费 diff 不再重放）。返回预览交给
   * 内核在 run 起点 consume；watcher 缺席 = undefined（旧调用面），无变更 = null。
   */
  #collectContextPreview(rec: SessionRecord): SessionContextPreview | null | undefined {
    const watcher = rec.contextWatcher;
    if (watcher === null) return undefined;
    const preview = watcher.peek();
    if (preview === null) return null;
    this.#contextTemplate?.advance(preview.observations);
    if (preview.actions.length > 0) {
      // bytes = 该 notice 最终文本 UTF-8 字节（replace 是差异块尺寸、remove 是固定文案
      // 长度）；正文绝不进帧（内容真源=转录/wire）。
      const frameNotices = preview.actions.map((action, i) => ({
        action: action.kind,
        relPath: action.relPath,
        bytes: preview.noticeBytes[i] ?? 0,
      }));
      rec.hub.publish("context.notice", rec.sessionID, {
        notices: frameNotices,
        turnIdx: rec.turns, // 即将开跑的轮（0 基，= loop assembly 事件同轮 turnIdx）
      });
    }
    return preview;
  }

  /** 每轮收尾从 loop.events() 取最后一个 assembly 记录 → 分段构成快照（内存一份）。 */
  #captureContext(rec: SessionRecord, events: readonly LoopEvent[]): void {
    let last: Extract<LoopEvent, { type: "assembly" }> | null = null;
    for (const e of events) if (e.type === "assembly") last = e;
    if (last === null) return;
    const contextWindow = typeof this.#opts.model.contextWindow === "number" ? this.#opts.model.contextWindow : null;
    this.#contextViews.set(
      rec.sessionID,
      buildContextView({
        sessionID: rec.sessionID,
        // 重读后的 plan 尚未产生新 assembly 事件时，currentAssembly() 给出按新 plan 重建的
        // 前缀视图；事件面（assemblies()/trace）仍保持历史。
        assembly: rec.loop.currentAssembly() ?? last.assembly,
        turnIdx: last.turnIdx,
        capturedAt: (this.#opts.now ?? Date.now)(),
        contextWindow,
      }),
    );
  }

  /** C1 run-end 记录：live 压缩摘要存在则追加事件日志；失败只 WARN，绝不打断 finally。 */
  #recordCompactionEvent(rec: SessionRecord): void {
    try {
      const view = rec.loop.session.compactionView;
      // T7b：restored view 是 durable boundary 的重放面，不是本轮新观察——它的 canonical
      // 事件由 /compactions 的 boundary 读取提供；此处再记会造出 coveredCount=1 的重复 auto。
      if (view === null || view.restored === true) return;
      const event = compactionEventFromSnapshot(view, (this.#opts.now ?? Date.now)());
      appendCompactionEvent(this.#stateRoot(), rec.sessionID, event);
    } catch (err) {
      this.#journal("warn", "loom compaction event append failed", {
        sessionID: rec.sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 副会话反推：当日 trace 里该会话最后一条 assembly span（不存在 = undefined）。 */
  async #traceContextView(sessionID: string): Promise<ContextView | undefined> {
    const stateRoot = this.#opts.stateRoot ?? process.env["LOOM_STATE"] ?? "state";
    let records: TraceRecord[];
    try {
      records = readTraceFile(stateRoot, localDateKey(Date.now()));
    } catch {
      return undefined;
    }
    const isAssemblySpan = (r: TraceRecord): r is RunSpan => r.kind === "span" && r.stage === "assembly";
    const spans = records.filter(isAssemblySpan).filter((r) => r.sessionId === sessionID);
    const span = spans[spans.length - 1];
    if (span === undefined) return undefined;
    const injected = span.attrs?.["injectedLines"];
    return buildTraceContextView({
      sessionID,
      capturedAt: span.end,
      injectedLines: typeof injected === "number" ? injected : 0,
      memorySourceCount: span.assemblyRowCount ?? 0,
      historyRows: await this.#historyRowCount(sessionID),
      contextWindow: typeof this.#opts.model.contextWindow === "number" ? this.#opts.model.contextWindow : null,
    });
  }

  /** 该会话转录的 message 类 entry 条数（按归属 store 解析，口径同 history()）。 */
  async #historyRowCount(sessionID: string): Promise<number | null> {
    const stores: readonly SessionStore[] = [this.#opts.store, ...(this.#opts.historyStores ?? [])];
    for (const s of stores) {
      try {
        if ((await s.getLeafId(sessionID)) === null) continue;
        const path = await s.getPathToLeaf(sessionID);
        return path.filter((entry) => entry.entry.kind === "message").length;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * W11a P2 session.created（文档 L135-160 形状：properties.info{id, projectID,
   * directory, title, version, time{created,updated}}）。
   *
   * 广播口径（决策）：opencode 真源是 /global/event 单一全局总线，loom 的 SSE 是
   * 每会话 hub——会话生命周期帧只有广播到全部已登记 hub 才能被在线订阅者看见
   * （新建会话自身此刻必无订阅者）。properties.sessionID = **新会话** id
   * （前端 resolveSessionId 归属口径），info.id 同值镜像。
   */
  #publishCreated(rec: SessionRecord): void {
    const at = (this.#opts.now ?? Date.now)();
    const id = sanitizeId(rec.sessionID);
    const info: Record<string, unknown> = {
      id,
      projectID: "global",
      title: "New session",
      time: { created: at, updated: at },
    };
    if (this.#opts.version !== undefined) info["version"] = this.#opts.version;
    if (this.#opts.workspaceRoot !== undefined) info["directory"] = this.#opts.workspaceRoot;
    for (const other of this.#records.values()) {
      other.hub.publish("session.created", rec.sessionID, { info });
    }
  }

  #ensure(sessionID: string): SessionRecord {
    const existing = this.#records.get(sessionID);
    if (existing !== undefined) return existing;

    const opts = this.#opts;
    // W23-A 发线面持久回调本地捕获（readonly 链在闭包中不保窄化，先落局部 const）。
    const wireSink = this.#opts.onWireSnapshot;
    // serve 未走 runStreaming（loop.start 驱动），recorded 轨由本钩子逐事件转发：
    // llm-end → message.updated 信息帧（provider/model/tokens 的**唯一**帧来源，
    // 真模型断言的取证面）；tool-end → message.part.updated 工具帧。
    let hub: EventHub | null = null;
    let compactionStream: CompactionStreamPublisher | null = null;
    const baseCompaction = opts.compaction;
    const compaction =
      baseCompaction === undefined
        ? undefined
        : {
            ...baseCompaction,
            onEvent: (event: Parameters<NonNullable<typeof baseCompaction.onEvent>>[0]): void => {
              baseCompaction.onEvent?.(event);
              compactionStream?.handle(event);
            },
          };
    const recorded: Hook = {
      name: "session-api.recorded-forward",
      onLlmEnd(input): void {
        hub?.forwardRecorded({ type: "llm-end", msg: input.msg, durationMs: input.durationMs });
      },
      onPostToolUse(input): void {
        hub?.forwardRecorded({
          type: "tool-end",
          call: input.call,
          result: input.result,
          durationMs: input.durationMs,
        });
      },
    };
    const flowCapture: Hook | null =
      opts.flow === undefined
        ? null
        : {
            name: "session-api.flow-capture",
            onPostToolUse(input): void {
              const rec = recRef;
              if (rec === null) return;
              const flow = readFlow(input.result.details);
              if (flow !== null) rec.flow = flow;
            },
          };
    // W16/W25 上下文侦听器：每会话一份（水位 + 上次已交付全文），共享模板只做跨会话
    // 起步基线。主会话 contextCheckEachTurn=false：准入 peek + session-start/compaction
    // rebase 两触发点（Oracle 条件，W17-F 帧/转录并行保持）。
    let recRef: SessionRecord | null = null;
    let contextWatcher: SessionContextWatcher | null = null;
    const contextTemplate = this.#contextTemplate;
    if (
      contextTemplate !== null &&
      (opts.contextChange !== undefined || opts.skillsSniff !== undefined)
    ) {
      const seed = opts.contextChange;
      const sniff = opts.skillsSniff;
      let rescanError: { readonly error: unknown } | null = null;
      const sources: SessionContextSource[] = (seed?.files ?? [])
        .filter((file) => file.relPath !== SKILLS_CATALOG_REL_PATH)
        .map((file) => ({
          relPath: file.relPath,
          content: file.bootHash !== null ? (file.content ?? "") : null,
          ...(file.mtimeMs !== null ? { mtimeMs: file.mtimeMs } : {}),
          ...(file.size !== null ? { size: file.size } : {}),
        }));
      const dynamicSources: SessionContextDynamicSource[] =
        sniff === undefined
          ? []
          : [
              {
                relPath: SKILLS_CATALOG_REL_PATH,
                // watcher 对 rescan 失败 fail-soft（跳过该合成源）；把错误留给紧随其后的
                // snapshot 上抛，保持准入 catch / drain 回滚的既有调用方语义（W42b）。
                rescan: () => {
                  rescanError = null;
                  try {
                    sniff.rescan();
                  } catch (err) {
                    rescanError = { error: err };
                  }
                },
                snapshot: () => {
                  const failed = rescanError;
                  rescanError = null;
                  if (failed !== null) throw failed.error;
                  const snapshot = sniff.snapshot();
                  return { text: snapshot.text, revision: snapshot.generation };
                },
              },
            ];
      contextWatcher = new SessionContextWatcher({
        workspaceRoot: seed?.workspaceRoot ?? opts.workspaceRoot ?? process.cwd(),
        sources,
        ...(dynamicSources.length > 0 ? { dynamicSources } : {}),
        template: contextTemplate,
        onOutcome: (outcome: ContextChangeOutcome) => {
          const rec = recRef;
          if (rec === null) return;
          const notices = outcome.actions.map((action, i) => ({
            action: action.kind,
            relPath: action.relPath,
            bytes: outcome.noticeBytes[i] ?? 0,
          }));
          rec.hub.publish("context.notice", rec.sessionID, { notices, turnIdx: rec.turns });
        },
      });
    }
    const refreshFactory = opts.refreshAssemblyPlanFor;
    let refreshAssemblyPlan:
      | ReturnType<NonNullable<typeof refreshFactory>>
      | undefined;
    if (refreshFactory !== undefined && opts.assembly !== undefined) {
      const provider = refreshFactory(sessionID);
      const sniff = opts.skillsSniff;
      refreshAssemblyPlan =
        contextWatcher === null || sniff === undefined
          ? provider
          : async (reason) => {
              const result = await provider(reason);
              if (result === null || !("plan" in result)) return result;
              let catalog: { readonly text: string; readonly generation: number };
              try {
                catalog = sniff.snapshot();
              } catch {
                return result;
              }
              // 合成源不是 plan.memorySource：resync 基线必须补上当前 catalog 快照，
              // 否则 reseed 后 fresh check 会把准入预览里已发过的 catalog diff 再发一遍。
              return {
                ...result,
                contextBaseline: [
                  ...(result.contextBaseline ?? []),
                  {
                    relPath: SKILLS_CATALOG_REL_PATH,
                    content: catalog.text,
                    mtimeMs: catalog.generation,
                    size: Buffer.byteLength(catalog.text, "utf8"),
                  },
                ],
              };
            };
    }
    const loop = MainSessionLoop.create({
      model: opts.model,
      store: opts.store,
      sessionId: sessionID,
      // W49-C：静态无状态钩（recorded/skills/tool-stream）之后追加 per-session 工厂产物
      // （opts.hooksFor 逐会话新构造——autoCompaction 闭包绝不跨会话共享 = T4 破法；
      // 工厂缺席 = spread 空数组 = extraHooks 逐字节旧形状 = G6 面）。
      extraHooks: [
        recorded,
        ...(opts.hooks ?? []),
        ...(opts.hooksFor?.(sessionID) ?? []),
        ...(flowCapture === null ? [] : [flowCapture]),
      ],
      ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
      ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
      ...(opts.assembly !== undefined ? { assembly: opts.assembly } : {}),
      // systemPrompt/memory 重读仅在有装配 plan 时可换前缀（core 同款前置条件）：
      // 两键任一缺席 = 键不出现 = 旧冻结前缀行为。
      ...(refreshAssemblyPlan !== undefined ? { refreshAssemblyPlan } : {}),
      ...(contextWatcher !== null ? { contextWatcher, contextCheckEachTurn: false } : {}),
      ...(opts.llmOptions !== undefined ? { llmOptions: opts.llmOptions } : {}),
      // W57 P2c-2：可选会话级压缩接线逐值透传（缺席 = 键不出现 = core 旧行为）。
      ...(compaction !== undefined ? { compaction } : {}),
      ...(opts.limits !== undefined ? { limits: opts.limits } : {}),
      // W42c：llmErrorRetries 逐值条件透传（缺席 = 键不出现 = core 缺省 2，旧调用面逐字节；
      // 与 W26 convergenceEnforced 同形状。除此一行 + types.ts 一字段外，本文件零改动）。
      ...(opts.llmErrorRetries !== undefined ? { llmErrorRetries: opts.llmErrorRetries } : {}),
      // T4：重试退避基数逐值条件透传（缺席 = 键不出现 = core 缺省 1000；仅主会话）。
      ...(opts.llmErrorRetryBackoffMs !== undefined
        ? { llmErrorRetryBackoffMs: opts.llmErrorRetryBackoffMs }
        : {}),
      // W26：收束强制开关逐值条件透传（缺席 = 键不出现 = core 缺省强制，旧调用面逐字节）。
      ...(opts.convergenceEnforced !== undefined
        ? { convergenceEnforced: opts.convergenceEnforced }
        : {}),
      // L6/L8：flow store 与 converge 摘除开关逐值条件透传（缺席 = 键不出现 = 旧行为）。
      ...(opts.flow !== undefined ? { flow: opts.flow } : {}),
      ...(opts.converge !== undefined ? { converge: opts.converge } : {}),
      // 自动唤醒开关/时钟逐值条件透传（缺席 = 不物化 = core 缺省启用/Date.now）。
      ...(opts.autoWakeEnabled !== undefined ? { autoWakeEnabled: opts.autoWakeEnabled } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      // W21：delivery.notify 发帧点单移到"发射时刻"（见 deliverReminder），此处**不再发帧**。
      // 保留 onRemindersDrained 仅记账（loop 内部 reminder-drained 事件面不变，busy 路径 transient
      // 注入语义不变）；若在此再发帧，与 deliverReminder 的发射帧叠成双弹（一终态两 toast）——下线。
      onRemindersDrained: () => {},
      // W23-A 发线面持久：逐会话包 sid 透传（boot 注入 = wire-cache 落盘；未接 = 键缺席旧行为）。
      ...(wireSink === undefined
        ? {}
        : {
            onWireSnapshot: (snap: WireRequestSnapshot, payload: string | null): void =>
              wireSink(sessionID, snap, payload),
          }),
    });
    hub = new EventHub({
      session: loop.session,
      ...(opts.stateRoot !== undefined ? { stateRoot: opts.stateRoot } : {}),
    });
    if (compaction !== undefined) {
      compactionStream = new CompactionStreamPublisher({
        hub,
        sessionID,
        ...(compaction.stream?.flushIntervalMs === undefined
          ? {}
          : { flushIntervalMs: compaction.stream.flushIntervalMs }),
        ...(compaction.stream?.flushMaxBytes === undefined
          ? {}
          : { flushMaxBytes: compaction.stream.flushMaxBytes }),
      });
    }
    const rec: SessionRecord = {
      sessionID,
      loop,
      hub,
      contextWatcher,
      // W23-B 诞生时刻：boot 快照（重水化 sid=转录首时间戳）优先，缺席=登记时刻 now（新会话）。
      createdAt: opts.createdAtOf?.(sessionID) ?? (opts.now ?? Date.now)(),
      status: "idle",
      lastError: null,
      turns: 0,
      running: null,
      flow: null,
      replayTimer: null,
      queue: [],
      voiceTail: Promise.resolve(),
    };
    const isFirstRecord = this.#records.size === 0;
    this.#records.set(sessionID, rec);
    recRef = rec;
    // W12 滞留冲刷：该 sid 的未注册滞留提醒 + （首注册时）orphans，全部进边界队列待下轮消费。
    const detached = this.#detached.get(sessionID);
    if (detached !== undefined) {
      this.#detached.delete(sessionID);
      for (const line of detached) loop.remind(line);
    }
    if (isFirstRecord && this.#orphanReminders.length > 0) {
      const orphans = this.#orphanReminders;
      this.#orphanReminders = [];
      for (const line of orphans) loop.remind(line);
    }
    return rec;
  }

  /**
   * T5 重放资格（brief 冻结规则）：预算 >0、终态 error、末条 assistant stopReason 为
   * error/aborted、且非用户/进程 abort（`send:interrupt` / `shutdown`）。sync throw 的
   * "无失败 assistant" 由调用方尾部检查排除（此处只看 RunSummary，不看 store）。
   */
  #isReplayEligible(result: MainLoopResult): boolean {
    if (this.#replayRetries <= 0) return false;
    if (result.type !== "error") return false;
    const stop = result.summary.lastMessage?.stopReason;
    if (stop !== "error" && stop !== "aborted") return false;
    const abortReason = result.summary.abortReason;
    if (
      abortReason !== undefined &&
      (abortReason.includes("send:interrupt") || abortReason.includes("shutdown"))
    ) {
      return false;
    }
    return true;
  }

  /** T5：撤待触发的重放定时器并按需丢弃 replay 行；返回队列是否被改动（调用方同步 sidecar）。 */
  #cancelReplay(rec: SessionRecord): boolean {
    const timer = rec.replayTimer;
    if (timer !== undefined && timer !== null) {
      clearTimeout(timer);
      rec.replayTimer = null;
    }
    const kept = rec.queue.filter((item) => item.mode !== "replay");
    if (kept.length === rec.queue.length) return false;
    rec.queue = kept;
    return true;
  }

  /** 同步启动一轮：置 busy、publish session.status、后台跑 loop，收尾置 idle/error + publish idle。 */
  #start(
    rec: SessionRecord,
    text: string,
    // exactOptionalPropertyTypes 纪律：调用方以"键在场、值可 undefined"组包，类型须如实并写 undefined。
    turnOpts?: {
      contextPreview?: SessionContextPreview | null | undefined;
      /** W55：队列 prompt 保留受理时刻（= SendQueueItem.at），首条 user 消息 timestamp 用它。 */
      promptTimestamp?: number | undefined;
      /** T5：true = 失败回合重放，走 `continueRun()`（prompt 已在转录；notices/timestamp 忽略）。 */
      continuation?: boolean | undefined;
    },
  ): void {
    rec.status = "busy";
    rec.lastError = null;
    rec.flow = null;
    rec.turns += 1;
    rec.hub.publish("session.status", rec.sessionID, statusProps("busy"));
    // T5 每轮独立的收尾信号：仅本轮的瞬时 LLM 错误可触发重放，sync throw/成功轮恒 false。
    let replayEligible = false;

    const running = (async (): Promise<void> => {
      try {
        // W17-G 首跑前 resume 装载（记忆化，后续轮零成本）：boot 重水化 sid 的内核内存
        // 本世为空但盘上有转录 ⇒ 用 AgentSession.resume 同一重放体把历史（压缩边界后）
        // 灌入请求面；全新 sid（getLeafId=null）⇒ no-op，逐字节旧行为。失败落下方 error 通道。
        await rec.loop.hydrate();
        rec.loop.session.recoverStaleCompaction();
        const contextPreview = turnOpts?.contextPreview;
        const promptTimestamp = turnOpts?.promptTimestamp;
        const messagesBefore = rec.loop.messages.length;
        const result =
          turnOpts?.continuation === true
            ? await rec.loop.continueRun()
            : contextPreview === undefined && promptTimestamp === undefined
              ? await rec.loop.start(text)
              : await rec.loop.start(text, {
                  ...(contextPreview !== undefined ? { contextPreview } : {}),
                  ...(promptTimestamp !== undefined ? { promptTimestamp } : {}),
                });
        // flow 未接线时才消费 converge 回执的 wake；flow 接线后唤醒权威 = FlowStore。
        if (result.type === "converged" && this.#flow === undefined) {
          const nextWake = nextWakeAtOf(result.receipt);
          if (nextWake !== undefined) {
            try {
              this.#opts.onAutoWake?.(rec.sessionID, nextWake);
            } catch (err) {
              this.#journal("warn", "loom auto wake arm failed", {
                sessionID: rec.sessionID,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
        if (result.type === "flowEnded") {
          rec.flow = {
            subject_id: result.flow.subject_id,
            subject_name: result.flow.subject_name,
            state: result.flow.state,
            next_decision_at: result.flow.next_decision_at,
          };
          this.#observe({
            type: "flow.ended",
            session_id: rec.sessionID,
            subject_id: result.flow.subject_id,
            state: result.flow.state,
            next_decision_at: result.flow.next_decision_at,
          });
        }
        if (result.type === "error") {
          // sync throw（streamThrows 等）不产生本轮的失败 assistant：必须"本轮新增了
          // 尾随 error/aborted assistant"才算可 continue() 的失败回合（brief 明令排除）。
          const tail = rec.loop.messages[rec.loop.messages.length - 1];
          const failedAssistantAtTail =
            rec.loop.messages.length > messagesBefore &&
            tail !== undefined &&
            tail.role === "assistant" &&
            (tail.stopReason === "error" || tail.stopReason === "aborted");
          replayEligible = failedAssistantAtTail && this.#isReplayEligible(result);
          rec.status = "error";
          rec.lastError = result.summary.error?.message ?? "run ended with error";
          rec.hub.publish("session.error", rec.sessionID, {
            error: { message: rec.lastError },
          });
        } else {
          rec.status = "idle";
        }
      } catch (err) {
        rec.status = "error";
        rec.lastError = err instanceof Error ? err.message : String(err);
        rec.hub.publish("session.error", rec.sessionID, {
          error: { message: rec.lastError },
        });
      } finally {
        rec.running = null;
        // 装配 span 落 trace + W13 上下文快照留内存（观测面：失败都不影响会话终态）。
        try {
          const events = rec.loop.events();
          this.#opts.assemblyTrace?.write(rec.sessionID, events);
          this.#captureContext(rec, events);
        } catch {
          /* 端口自身坏（不应发生，writer 内部已 fail-soft）——吞在会话域最后防线 */
        }
        // busy-steer 唯一性支柱：本轮已收尾，仍 park 在 kernel inbox 的 steer 必须撤回——
        // 否则同一 kernel 下一次 run 会再次 drain 它，与队首项形成重复消费/乱序。
        // cancel() true = 仍 park（撤回成功）：项留队，由 #drainQueue 作为下一轮 prompt 消费；
        // false = 已被 kernel drain：只置 drained，由 store 证据决定摘队/留队。
        for (const item of [...rec.queue]) {
          const handle = item.steerHandle;
          if (handle === undefined) continue;
          item.steerHandle = undefined;
          if (handle.cancel()) continue;
          item.drained = true;
        }
        await this.#settleDrainedItems(rec, replayEligible);
        this.#publishPending(rec);
        this.#syncQueueSidecar(rec);
        // C1：本轮结束把 live 压缩摘要追加到 append-only 事件日志（同摘要哈希去重）。
        // 放在 settle/publish/sync 之后、下轮接管早退之前——收尾链任何一步异常都不影响它，
        // 其自身失败只 WARN，绝不反噬会话终态。
        this.#recordCompactionEvent(rec);
        // L6：每次主 run 终止后（不只 converged）对齐 flow 唤醒；无 pending 时清 sidecar。
        await this.#syncFlowWake(rec.sessionID);
        // settle 期间可能有新 send/voiceSend 起了下一轮（rec.running 已被其接管）：
        // 让该轮的 finally 接手出队；旧轮不再抢发 idle（否则会在新轮 busy 之后倒灌旧终态）。
        if (rec.running !== null) return;
        // idle 必须在 queue 快照之后发：W54 的 session.queue 收尾帧若晚于 idle，会破坏
        // W11 “idle 是最后一帧”的既有 SSE 契约。镜像一份 id：前端 session.idle 无 id
        // 会挂 120s（T29 硬契约）。无排队项时 idle 即最后一帧；有排队项时随后由
        // #drainQueue 发新轮 session.status(busy)。
        rec.hub.publish("session.idle", rec.sessionID, {
          id: rec.sessionID,
          ...statusProps("idle"),
          ...(rec.flow !== null ? { flow: rec.flow } : {}),
        });
        this.#observe({
          type: "session.idle",
          session_id: rec.sessionID,
          has_flow: rec.flow !== null,
          flow:
            rec.flow === null
              ? null
              : { subject_id: rec.flow.subject_id, state: rec.flow.state },
        });
        // W16-F1 收尾出队：本轮 idle/error 落定后逐条起排队轮（一次一条，其余随其 finally 接力）。
        // W42b 加固：出队链整体入 #drainQueue（异常回插 + session.error + journal，绝不静默蒸发）。
        this.#drainQueue(rec);
      }
    })();
    rec.running = running;
  }

  /**
   * W42b/W55 收尾出队单步（#start finally 与 recoverSendQueues 共用）：不 shift，只把
   * **队首未消费项**标记 consumed（= 本轮 prompt，仍留在队里等 settle 凭 store 证据摘除）。
   *
   * W55 合并：idle 终态（成功/abort/启动恢复）下，队内其余未消费/未 drain 项全部 steer 进
   * 本轮，turn 0 的 steering drain 在首次 LLM 请求之前一次性消费整条队列——N 条排队只新增
   * 1 个 run，且每条消息仍是独立 Message（转录恰一份，绝不拼串）。error 终态**不合并**、
   * 逐条出队：起轮前反复失败时合并会把全部 followers 每轮重挂一遍，形成无界 churn。
   *
   * 任何一步抛错 = 本帧创建的 steer 句柄全部撤回（项留队）+ 队首 consumed 复位 + sidecar
   * 回写 + pending 快照 + session.error 帧 + WARN journal——项绝不静默蒸发（滞留队列可见，
   * 下一次 send/drain 照常接力）。
   */
  #drainQueue(rec: SessionRecord): void {
    const next = rec.queue.find((item) => item.consumed !== true && item.drained !== true);
    if (next === undefined) return;
    // T5：队首重放行未到点 → 单定时器等待。已有 timer 就把它留给原 nextAt（不重复建）。
    const now = (this.#opts.now ?? Date.now)();
    if (next.nextAt !== undefined && next.nextAt > now) {
      if (rec.replayTimer !== undefined && rec.replayTimer !== null) return;
      const timer = setTimeout(() => {
        rec.replayTimer = null;
        this.#drainQueue(rec);
      }, next.nextAt - now);
      rec.replayTimer = timer;
      timer.unref();
      return;
    }
    // 走到这里 = 队首已可执行；为旧 nextAt 建立的 timer 全部作废。
    if (rec.replayTimer !== undefined && rec.replayTimer !== null) {
      clearTimeout(rec.replayTimer);
      rec.replayTimer = null;
    }
    // 仅本调用创建的 followers（rollback 用；已在队的旧句柄不归本帧管）。
    const parked: SendQueueItem[] = [];
    try {
      next.consumed = true;
      this.#syncQueueSidecar(rec);
      this.#publishPending(rec);
      // 终态在 #start finally 已落定：成功/abort => idle，error => error；boot/recovery 为 idle。
      // T5 replay 行绝不合并 followers：prompt 已在转录，continue() 本轮只续跑一次；
      // 未持久化的 followers 留队等下一轮正常 prompt。
      const isReplay = next.mode === "replay";
      const coalesce = rec.status === "idle" && !isReplay;
      // 嗅探先于 steer：抛错时尚未创建任何句柄，catch 只需复位 consumed。
      const contextPreview = isReplay ? undefined : this.#collectContextPreview(rec);
      if (coalesce) {
        for (const item of [...rec.queue]) {
          if (item === next || item.consumed === true || item.drained === true) continue;
          if (item.mode === "replay") continue; // 重放行绝不 steer（prompt 已在转录）
          item.steerHandle = rec.loop.steer(
            { role: "user", content: item.text, timestamp: item.at },
            { onDrained: () => { item.drained = true; this.#publishPending(rec); } },
          );
          parked.push(item);
        }
      }
      if (isReplay) {
        this.#start(rec, next.text, { continuation: true });
      } else {
        this.#start(rec, next.text, { contextPreview, promptTimestamp: next.at });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 无 shift 语义：项从未离开队列，只需复位本帧的 consumed 标记。
      next.consumed = false;
      for (const item of parked) {
        item.steerHandle?.cancel();
        item.steerHandle = undefined;
      }
      this.#syncQueueSidecar(rec);
      this.#publishPending(rec);
      rec.status = "error";
      rec.lastError = message;
      try {
        rec.hub.publish("session.error", rec.sessionID, { error: { message } });
      } catch {
        /* 帧面自炸不反噬加固链（journal 仍响亮） */
      }
      this.#journal("warn", "loom send queue drain failed (item kept at head)", {
        sessionID: rec.sessionID,
        error: message,
      });
    }
  }

  /** 排队深度只算尚未被任何轮消费的项（queued）；running/drained 项不占新消息容量。 */
  #pendingQueueLength(rec: SessionRecord): number {
    let pending = 0;
    for (const item of rec.queue) {
      if (item.consumed !== true && item.drained !== true) pending += 1;
    }
    return pending;
  }

  /**
   * busy 项摘队（按对象身份，幂等；收尾 settle 与 rollback 共用）：
   * 不在队 = 已被摘除/消费，no-op；在队则 splice + sidecar 同步。
   */
  #removeQueueItem(rec: SessionRecord, item: SendQueueItem): void {
    const idx = rec.queue.indexOf(item);
    if (idx < 0) return;
    rec.queue.splice(idx, 1);
    this.#syncQueueSidecar(rec);
  }

  /**
   * 本轮收尾 settle（drain-before-flush 崩溃窗口的内进程面）：处理 consumed（当前 prompt）
   * 与 drained（steer 已进本轮）两类项；读一次 store path，存在精确 `(content,timestamp)`
   * user 证据才摘队；缺席 = flush 没落账，清标志留给 #drainQueue 重投。
   *
   * 过滤快照必须在函数入口**同步**取：settle 的 store await 期间到达的 idle send 会新起
   * 一轮，其 consumed 项绝不能被上一轮的 settle 清掉（否则同一条消息会被再跑一次）。
   * store 读炸 = 保留项并复位 drained/steerHandle（WARN 响亮），交给后续 drain 重投；
   * consumed 保持不动——该 prompt 在 turn 起点的落盘已完成，读失败不构成重跑证据。
   */
  async #settleDrainedItems(rec: SessionRecord, replayEligible = false): Promise<void> {
    const candidates = rec.queue.filter((item) => item.consumed === true || item.drained === true);
    if (candidates.length === 0) return;
    let path: StoredEntry[];
    try {
      path = await this.#opts.store.getPathToLeaf(rec.sessionID);
    } catch (err) {
      this.#journal("warn", "loom send queue settle store read failed (items kept)", {
        sessionID: rec.sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
      for (const item of candidates) {
        item.drained = false;
        item.steerHandle = undefined;
      }
      return;
    }
    const now = (this.#opts.now ?? Date.now)();
    for (const item of candidates) {
      if (storedUserMessageExists(path, item.text, item.at)) {
        // T5：失败轮的 prompt 已落盘但无回答——不摘队，转 replay 行以 continue() 续跑。
        // 只认被本轮选作 prompt 的项（consumed）；drained followers 已随同一转录落盘，
        // 重放一次 continue() 即覆盖它们，不单独排队（避免重复续跑）。
        // rec.running 在 settle await 期间可能被新 send 接管：该轮已从同一转录 continue
        // 覆盖了本失败回合，再挂 replay 会变成"新回答之后再补一轮"的错序冗余——按失败处理
        // 前的旧纪律摘队即可（prompt 已落盘，不会丢）。
        if (
          replayEligible &&
          rec.running === null &&
          item.consumed === true &&
          (item.attempts ?? 0) < this.#replayRetries
        ) {
          item.attempts = (item.attempts ?? 0) + 1;
          item.mode = "replay";
          item.nextAt =
            now + this.#replayBackoffMs * 2 ** Math.min(item.attempts - 1, 5);
          item.consumed = false;
          item.drained = false;
          item.steerHandle = undefined;
          this.#syncQueueSidecar(rec);
          continue;
        }
        this.#removeQueueItem(rec, item);
      } else {
        item.consumed = false;
        item.drained = false;
        item.steerHandle = undefined;
        item.mode = undefined;
        item.attempts = undefined;
        item.nextAt = undefined;
      }
    }
  }

  /** W55 pending 快照发帧（队列每次变更后调用；空队列也发，前端据此清空）。 */
  #publishPending(rec: SessionRecord): void {
    rec.hub.publish("session.queue", rec.sessionID, { pending: pendingItemViews(rec.queue) });
  }

  // ────────────── W42b send 队列 sidecar（耐重启） ──────────────

  #stateRoot(): string {
    return this.#opts.stateRoot ?? process.env["LOOM_STATE"] ?? "state";
  }

  #queueDir(): string {
    return join(this.#stateRoot(), "session", "queue");
  }

  #queueFile(sessionID: string): string {
    return join(this.#queueDir(), `${sessionID}.json`);
  }

  /**
   * 队列每次变更（push/摘队/恢复/标记）时刻原子重写：tmp + rename（读侧永不见半截）。
   * 队列空 = 删文件（sidecar 在场 ⟺ 队列非空）。写失败 WARN（内存队列照常，耐重启面降级）。
   */
  #syncQueueSidecar(rec: SessionRecord): void {
    if (!VALID_SID_RE.test(rec.sessionID)) return; // 非法文件名面：只保内存队列（boot 重水化 sid 恒合法）
    const file = this.#queueFile(rec.sessionID);
    try {
      if (rec.queue.length === 0) {
        try {
          unlinkSync(file);
        } catch {
          /* 本就不在 = 已归零，幂等 */
        }
        return;
      }
      mkdirSync(dirname(file), { recursive: true });
      // T5：普通行保持 {text,at} 旧形状；仅 replay 行追加 mode/attempts/nextAt（三种键
      // 缺失时 normalize 仍按普通 prompt 行接受，旧 sidecar 向后兼容）。
      const rows = rec.queue.map((it) =>
        it.mode === "replay"
          ? {
              text: it.text,
              at: it.at,
              mode: "replay",
              attempts: it.attempts ?? 0,
              nextAt: it.nextAt ?? 0,
            }
          : { text: it.text, at: it.at },
      );
      const tmp = `${file}.${process.pid}.${++sidecarSeq}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(rows)}\n`, "utf8");
      renameSync(tmp, file);
    } catch (err) {
      this.#journal("warn", "loom send queue sidecar write failed", {
        sessionID: rec.sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  #removeQueueSidecar(sessionID: string): void {
    try {
      unlinkSync(this.#queueFile(sessionID));
    } catch {
      /* 幂等归零 */
    }
  }

  #reconcileFlowQueue(
    sessionID: string,
    subjects: readonly FlowSubject[],
    now: number,
  ): void {
    const entries: WakeQueueEntryLike[] = pendingSubjects(subjects).map(({ subject, at }) => ({
      // id 含 at：改期即新条目，避免已投递归档抑制改期唤醒。
      id: `flow.${subject.subject_id}.${String(at)}`,
      source: "flow",
      action: "flow.check",
      at,
      payload: { subject_id: subject.subject_id, at },
      created_at: now,
      attempts: 0,
    }));
    try {
      this.#opts.onWakeReconcileSource?.(sessionID, "flow", entries);
    } catch (err) {
      this.#journal("warn", "loom flow wake reconcile failed", {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * L6：主 run 收尾后按 FlowStore 对齐唤醒计划。读最早 pending 主体 → 武装其
   * next_decision_at；无 pending/closed → onAutoWake(null) 清 sidecar。
   * 去重键 = subjectAt（FlowStore 值）：同一计划只 arm 一次，overdue 已投递且模型未
   * 提交新状态时不重复 arm（防唤醒回环）；新提交改变 next_decision_at 才会再武装。
   */
  async #syncFlowWake(sessionID: string): Promise<void> {
    const flow = this.#flow;
    if (flow === undefined) return;
    const now = (this.#opts.now ?? Date.now)();
    if (this.#opts.onWakeReconcileSource !== undefined) {
      let subjects: readonly FlowSubject[];
      try {
        subjects = await flow.wake.refresh(sessionID);
      } catch (err) {
        this.#journal("warn", "loom flow wake read failed", {
          sessionID,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      this.#reconcileFlowQueue(sessionID, subjects, now);
      return;
    }
    let earliest;
    try {
      earliest = await flow.store.earliestPending(sessionID, now);
    } catch (err) {
      this.#journal("warn", "loom flow wake read failed", {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    try {
      await flow.wake.refresh(sessionID);
    } catch (err) {
      this.#journal("warn", "loom flow wake renderer refresh failed", {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (earliest === null || earliest.next_decision_at === null) {
      this.#clearFlowWake(sessionID);
      return;
    }
    let subjectAt = earliest.next_decision_at;
    const plans = this.#flowWakePlans.get(sessionID);
    if (plans?.has(subjectAt) === true) {
      this.#observe({
        type: "wake.duplicate_suppressed",
        session_id: sessionID,
        subject_at: subjectAt,
      });
      // 计划仍在等待调度（未来时刻或 boot grace）= 不重复；已到点且模型未提交新状态 =
      // 该计划已投递，跳到下一个未占用的 pending 时刻，避免最早主体饿死其它主体或唤醒回环。
      const scheduledAt = plans.get(subjectAt) ?? subjectAt;
      if (now < scheduledAt || subjectAt > now) return;
      const nextAt = await this.#nextPendingNotPlanned(sessionID, plans);
      if (nextAt === null) return;
      subjectAt = nextAt;
    }
    this.#armFlowWake(sessionID, subjectAt, subjectAt);
  }

  /** 多主体调度：下一个未武装/未投递的 pending next_decision_at（读失败 = null）。 */
  async #nextPendingNotPlanned(
    sessionID: string,
    plans: ReadonlyMap<number, number>,
  ): Promise<number | null> {
    const flow = this.#flow;
    if (flow === undefined) return null;
    let subjects;
    try {
      subjects = await flow.store.list(sessionID);
    } catch (err) {
      this.#journal("warn", "loom flow wake next pending read failed", {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    let best: number | null = null;
    for (const subject of subjects) {
      if (subject.state === "closed") continue;
      const at = subject.next_decision_at;
      if (at === null || plans.has(at)) continue;
      if (best === null || at < best) best = at;
    }
    return best;
  }

  #armFlowWake(sessionID: string, subjectAt: number, scheduledAt: number): void {
    try {
      this.#opts.onAutoWake?.(sessionID, scheduledAt);
    } catch (err) {
      this.#journal("warn", "loom flow wake arm failed", {
        sessionID,
        at: scheduledAt,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const plans = this.#flowWakePlans.get(sessionID) ?? new Map<number, number>();
    plans.set(subjectAt, scheduledAt);
    this.#flowWakePlans.set(sessionID, plans);
    if (this.#opts.onAutoWake !== undefined) {
      this.#observe({
        type: "wake.armed",
        session_id: sessionID,
        subject_at: subjectAt,
        scheduled_at: scheduledAt,
      });
    }
  }

  #clearFlowWake(sessionID: string): void {
    const planned = [...(this.#flowWakePlans.get(sessionID)?.keys() ?? [])];
    this.#flowWakePlans.delete(sessionID);
    this.#flow?.wake.clear(sessionID);
    if (planned.length > 0) {
      this.#observe({
        type: "wake.cleared",
        session_id: sessionID,
        subject_ats: planned,
      });
    }
    try {
      this.#opts.onAutoWake?.(sessionID, null);
    } catch (err) {
      this.#journal("warn", "loom flow wake clear failed", {
        sessionID,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** L9 观察面统一入口：sink 自身坏绝不反噬受理/收尾/唤醒链。 */
  #observe(event: FlowObservationInput): void {
    try {
      this.#flowObservation?.observe(event);
    } catch {
      /* 观察 sink 自炸吞断 */
    }
  }

  /** 观测面统一入口：journal 自身坏绝不反噬受理/收尾链。 */
  #journal(level: LogLevel, msg: string, fields: Record<string, unknown>): void {
    try {
      this.#opts.logSink?.(level, msg, fields);
    } catch {
      /* sink 自炸吞断 */
    }
  }
}

/* ────────────── 模块级 IO helpers（send 队列 sidecar / 对账） ────────────── */

/** 文件名安全 sid（与 routes.ts SESSION_ID_RE 同口径；sidecar 读写两侧的入参闸）。 */
const VALID_SID_RE = /^[a-zA-Z0-9_]+$/;

/** sidecar tmp 名去重计数（同 pid 同刻多次写不互踩）。 */
let sidecarSeq = 0;

/**
 * sidecar JSON → SendQueueItem[] 的边界解析（parse-don't-validate：出此函数即可信）。
 * 只校验 text/at 与 T5 可选重放三元组；legacy entryId 及未知字段一律忽略（旧版本 sidecar
 * 可读：无 mode/attempts/nextAt 的行 = 普通 prompt 行）。任何形状违规 = 抛错，由
 * recoverSendQueues 折算"诚实丢弃 + WARN"——绝不部分恢复。
 */
function normalizeQueueRows(raw: unknown): SendQueueItem[] {
  if (!Array.isArray(raw)) throw new Error("sidecar root must be an array");
  return raw.map((row, idx) => {
    if (typeof row !== "object" || row === null) throw new Error(`row[${String(idx)}] not an object`);
    const r = row as { text?: unknown; at?: unknown; mode?: unknown; attempts?: unknown; nextAt?: unknown };
    if (typeof r.text !== "string" || r.text.length === 0) throw new Error(`row[${String(idx)}] bad text`);
    if (typeof r.at !== "number" || !Number.isFinite(r.at)) throw new Error(`row[${String(idx)}] bad at`);
    let mode: "prompt" | "replay" | undefined;
    if (typeof r.mode === "string" && (r.mode === "prompt" || r.mode === "replay")) {
      mode = r.mode;
    } else if (r.mode !== undefined) {
      throw new Error(`row[${String(idx)}] bad mode`);
    }
    let attempts: number | undefined;
    if (typeof r.attempts === "number" && Number.isInteger(r.attempts) && r.attempts >= 0) {
      attempts = r.attempts;
    } else if (r.attempts !== undefined) {
      throw new Error(`row[${String(idx)}] bad attempts`);
    }
    let nextAt: number | undefined;
    if (typeof r.nextAt === "number" && Number.isFinite(r.nextAt)) {
      nextAt = r.nextAt;
    } else if (r.nextAt !== undefined) {
      throw new Error(`row[${String(idx)}] bad nextAt`);
    }
    return {
      text: r.text,
      at: r.at,
      ...(mode === undefined ? {} : { mode }),
      ...(attempts === undefined ? {} : { attempts }),
      ...(nextAt === undefined ? {} : { nextAt }),
    };
  });
}

/** 对账键：user 消息的正文 + 时间戳全等（settle 与 recovery 共用）。 */
function userMessageKey(content: string, at: number): string {
  return `${content}\u0000${at}`;
}

/** SendQueueItem → pending 读模型（consumed 优先于 drained；单一派生点）。 */
function pendingItemViews(queue: readonly SendQueueItem[]): PendingItemView[] {
  return queue.map((item) => ({
    text: item.text,
    at: item.at,
    state: item.consumed === true ? "running" : item.drained === true ? "drained" : "queued",
  }));
}

/** store path 里是否存在该 `(content,timestamp)` 的 user 消息（settle 的唯一摘队证据）。 */
function storedUserMessageExists(path: readonly StoredEntry[], content: string, at: number): boolean {
  const key = userMessageKey(content, at);
  return path.some(
    (stored) =>
      stored.entry.kind === "message" &&
      stored.entry.message.role === "user" &&
      typeof stored.entry.message.content === "string" &&
      userMessageKey(stored.entry.message.content, stored.entry.message.timestamp) === key,
  );
}
