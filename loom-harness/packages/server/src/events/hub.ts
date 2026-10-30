/**
 * T29 事件域 —— EventHub：loom 体内的原生多订阅者 SSE 扇出枢纽（docs/01 D33 修正一）。
 *
 * 形态（后端 events.py 从"单上游多扇出"降为本枢纽的订阅者之一）：
 *   - 每个订阅者拥有**独立的 EventPump + 独立 sink**（vendor 件只 import：
 *     adapters EventPump / http sse 帧写手）；一个订阅者写失败只摘除它自己，
 *     绝不影响其他订阅者，也绝不反压 kernel（pump 的 onError 隔离语义）。
 *   - live 轨由 pump.attachLive() 自动捕；recorded 轨由调用方（T27 会话域）在
 *     runStreaming 循环里 `forwardRecorded(event)` 灌入——同一 kernel 事件经
 *     共享 ProjectionState 的 WeakMap 记忆化，对所有订阅者投出**相同 id** 的帧。
 *   - 断连（res 'close'）即退订：detach live + 出集合，无悬挂监听器。
 *   - Last-Event-ID 重连补发：从当日 trace jsonl（core reader，撕裂行容忍）
 *     补发该会话的运行状态/告警帧，然后切 live。补发是**粗粒度重放当日记录**
 *     （前端按 part id splice 幂等）；消息级 live 增量不可从 trace 复原，缺口
 *     由前端历史分页（x-next-cursor，T27）兜底——此权衡记入 T38 验收。
 *
 * 帧形状（前端硬契约，docs/02）：`data:{seq,payload:{type,properties}}\n\n`，
 * 无 `event:` 行；`properties` 恒存在；每条帧带 `sessionID`；seq 每订阅者流内
 * 从 0 单调 +1（replay 帧与 live 帧共用同一计数器，重连后仍单调）。
 */

import type { ServerResponse } from "node:http";
import type { AgentSession, SessionEvent, TraceRecord } from "@axeuh/loom-core";
import { localDateKey, readTraceFile } from "@axeuh/loom-core";
import { EventPump, type TransportEnvelope, type TransportSink } from "@axeuh/loom-adapters";
import { startSseStream, writeSseFrame, writeSseKeepalive } from "../http/sse.js";
import { newProjectionState, projectEnvelope } from "./project.js";
import type { FrameDraft, ProjectionState } from "./project.js";
import { projectTraceRecord } from "./replay.js";
import { eventPayload, sanitizeId } from "./types.js";
import type { LoomFrame } from "./types.js";

/** 订阅一次 SSE 的返回句柄；调用方（handler）在异常路径也要调 close()。 */
export type Unsubscribe = () => void;

export interface EventHubOptions {
  /** 扇出的事件源会话（live 轨经其 Event Bus；recorded 轨经 forwardRecorded 灌入）。 */
  readonly session: AgentSession;
  /** trace 根目录（内含 `trace/{YYYY-MM-DD}.jsonl`）；replay 读取用。 */
  readonly stateRoot?: string;
  /** 订阅者被摘除时的上报通道（写失败/投影异常）；不给则静默——枢纽自身不猜日志后端。 */
  readonly onSubscriberDrop?: (reason: DropReason, sessionId: string) => void;
  /**
   * W11a P3：心跳周期（毫秒）——每 tick 写一帧 `: keepalive` 注释帧 + 一帧
   * `server.heartbeat` data 帧（EVENT_API_DOC §1 定 10s 周期，此处为可注入缺省）。
   * <=0 = 关心跳（测试可关）。
   */
  readonly heartbeatMs?: number;
}

/** 心跳缺省周期（文档 L77：every 10 seconds）。 */
const DEFAULT_HEARTBEAT_MS = 10_000;

/** 订阅者摘除原因（判别联合：新增原因编译器强制 publish 侧同步）。 */
export type DropReason =
  | { kind: "client-close" }
  | { kind: "write-failed"; error: unknown };

interface Subscriber {
  readonly res: ServerResponse;
  pump: EventPump | null;
  detach: Unsubscribe | null;
  /** 本订阅者流的下一帧 seq（单调计数器；-1 = 还没发过）。 */
  seq: number;
  closed: boolean;
  /** W11a P3 心跳定时器（drop 时必清；unref 过，不留悬挂句柄）。 */
  heartbeat: ReturnType<typeof setInterval> | null;
}

export class EventHub {
  readonly #session: AgentSession;
  readonly #stateRoot: string;
  readonly #heartbeatMs: number;
  readonly #onDrop: ((reason: DropReason, sessionId: string) => void) | undefined;
  readonly #subs = new Set<Subscriber>();
  readonly #projection: ProjectionState = newProjectionState();

  constructor(opts: EventHubOptions) {
    this.#session = opts.session;
    this.#stateRoot = opts.stateRoot ?? process.env["LOOM_STATE"] ?? "state";
    this.#heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#onDrop = opts.onSubscriberDrop;
  }

  /** 当前活跃订阅者数（泄漏验收用：断连后必须回落）。 */
  get subscriberCount(): number {
    return this.#subs.size;
  }

  /**
   * 注册一个 SSE 订阅者：先写 SSE 头（+ 可选 trace 补发帧），再挂独立 pump 捕 live。
   * @param lastEventId 客户端 `Last-Event-ID`（数值化）；存在则先补发当日 trace 帧再切 live。
   * @returns 退订函数（幂等；handler 异常路径调用以不留悬挂订阅者）。
   */
  subscribe(res: ServerResponse, lastEventId?: number): Unsubscribe {
    startSseStream(res);
    const sub: Subscriber = { res, pump: null, detach: null, seq: -1, closed: false, heartbeat: null };
    this.#subs.add(sub);

    // W11a P3：订阅建立即发 `server.connected` 首帧（文档 L64-70；properties 空袋，
    // loom 信封纪律自动补 sessionID——既有每条帧带 sessionID 的口径不变）。
    this.#emit(sub, {
      type: "server.connected",
      sessionID: sanitizeId(this.#session.id),
      properties: {},
    });

    if (lastEventId !== undefined && Number.isFinite(lastEventId)) {
      this.#replayTrace(sub);
    }

    const sink: TransportSink = {
      send: (env: TransportEnvelope): void => this.#onEnvelope(sub, env),
    };
    const pump = new EventPump(this.#session, {
      sink,
      // sink.send 内部已自捕写失败；走到这里说明是投影层异常——同样只摘该订阅者。
      onError: (err) => this.#drop(sub, { kind: "write-failed", error: err }),
    });
    sub.pump = pump;
    sub.detach = pump.attachLive();

    if (this.#heartbeatMs > 0) {
      const timer = setInterval(() => {
        if (sub.closed || sub.res.destroyed || sub.res.writableEnded) return;
        try {
          writeSseKeepalive(sub.res); // 注释帧保留（防代理空闲断连）
        } catch {
          return; // 写坏即由 close 通路摘除，此处不发 data 帧
        }
        this.#emit(sub, {
          type: "server.heartbeat",
          sessionID: sanitizeId(this.#session.id),
          properties: {},
        });
      }, this.#heartbeatMs);
      // 心跳句柄不吊住事件循环（订阅者自然断开即止；停机另有 close 全清）。
      timer.unref?.();
      sub.heartbeat = timer;
    }

    const onClose = (): void => this.#drop(sub, { kind: "client-close" });
    res.on("close", onClose);
    return () => {
      res.removeListener("close", onClose);
      this.#drop(sub, { kind: "client-close" });
    };
  }

  /**
   * recorded 轨入口：T27 会话域在 `for await (const ev of session.runStreaming(...))`
   * 循环里逐条调用；枢纽扇出给所有订阅者的独立 pump。
   */
  forwardRecorded(event: SessionEvent): void {
    for (const sub of [...this.#subs]) {
      if (sub.pump !== null && !sub.closed) sub.pump.forwardRecorded(event);
    }
  }

  /**
   * 域注入帧（§10.3 运行状态 / 投递通知 / 看门狗告警：T28/T15/T13 的发布接缝）。
   * sessionID 在此边界统一 sanitize；properties 恒存在。
   */
  publish(type: string, sessionID: string, properties: Readonly<Record<string, unknown>> = {}): void {
    const draft: FrameDraft = { type, sessionID: sanitizeId(sessionID), properties: { ...properties, sessionID: sanitizeId(sessionID) } };
    for (const sub of [...this.#subs]) this.#emit(sub, draft);
  }

  /**
   * W11a P0/P1：工具 part 状态帧（pending / running(+output 增量) / file 侧信道复用）。
   * part id 与终态 tool-end 帧同坐标系（投影状态 messageSeq + sanitizeId(callID)），
   * 前端按 part id splice 原位替换——running 卡与 completed 卡是同一张卡。
   */
  publishToolPart(callID: string, tool: string, state: Readonly<Record<string, unknown>>): void {
    const seq = this.#projection.messageSeq;
    const sessionID = sanitizeId(this.#session.id);
    const messageID = `msg_${seq}`;
    const cleanCallID = sanitizeId(callID);
    const part = {
      id: `part_${seq}_tool_${cleanCallID}`,
      sessionID,
      messageID,
      type: "tool",
      callID: cleanCallID,
      tool,
      state,
    };
    this.publish("message.part.updated", this.#session.id, { messageID, part });
  }

  /** 关闭全部订阅（serve 优雅停机用；drain 后调用）。 */
  close(): void {
    for (const sub of [...this.#subs]) this.#drop(sub, { kind: "client-close" });
  }

  // ───────────────────────── 内部 ─────────────────────────

  #onEnvelope(sub: Subscriber, env: TransportEnvelope): void {
    if (sub.closed) return;
    for (const draft of projectEnvelope(this.#projection, env)) {
      this.#emit(sub, draft);
      if (sub.closed) return; // 本帧写失败已摘除，剩余草案作废
    }
  }

  #emit(sub: Subscriber, draft: FrameDraft): void {
    if (sub.closed || sub.res.destroyed || sub.res.writableEnded) return;
    const frame: LoomFrame = { seq: ++sub.seq, payload: eventPayload(draft.type, draft.sessionID, draft.properties) };
    try {
      writeSseFrame(sub.res, frame);
    } catch (err) {
      this.#drop(sub, { kind: "write-failed", error: err });
    }
  }

  /** 重连补发：当日 trace jsonl 里属于本会话的记录 → run.status / watchdog.alarm 帧。 */
  #replayTrace(sub: Subscriber): void {
    const dateKey = localDateKey(Date.now());
    let records: TraceRecord[];
    try {
      records = readTraceFile(this.#stateRoot, dateKey);
    } catch (err) {
      // 读侧本身坏行容忍；这里只兜真正的 I/O 异常（目录不存在等）→ 404 语义前已 flush 头，
      // 不静默吞：发一条 session.error 告知补发失败，live 轨照常。
      this.#emit(sub, {
        type: "session.error",
        sessionID: sanitizeId(this.#session.id),
        properties: { replay_error: err instanceof Error ? err.message : String(err) },
      });
      return;
    }
    const sid = this.#session.id;
    for (const rec of records) {
      // nudge 行 schema 不带 sessionId（T21），无法归属会话 → 不进按会话补发（TODO(T38)）。
      if (rec.kind === "nudge") continue;
      if (rec.sessionId !== sid) continue; // 只补发本会话的记录
      for (const draft of projectTraceRecord(rec)) this.#emit(sub, draft);
      if (sub.closed) return;
    }
  }

  /** 摘除订阅者（幂等）：退订 live、清心跳、出集合、尽力 end 响应；杜绝悬挂。 */
  #drop(sub: Subscriber, reason: DropReason): void {
    if (sub.closed) return;
    sub.closed = true;
    if (sub.heartbeat !== null) clearInterval(sub.heartbeat);
    sub.heartbeat = null;
    sub.detach?.();
    sub.detach = null;
    this.#subs.delete(sub);
    this.#onDrop?.(reason, this.#session.id);
    // 连接已断（destroyed / 已 end）时不再 end——写了也到不了对端，只会制造 error 事件。
    if (!sub.res.destroyed && !sub.res.writableEnded) sub.res.end();
  }
}

/** 从请求头值解析 Last-Event-ID（非数字/缺失/数组多值 → undefined = 纯 live 订阅）。 */
export function parseLastEventId(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n;
}
