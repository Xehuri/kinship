/**
 * 每会话一次性自动唤醒调度器（server 进程内）。
 *
 * 状态面：`{stateRoot}/session/wake/{sessionID}.json`（tmp + rename 原子写），
 * 只存 {sessionID, at}；重启后由 restore() 重新武装，进程内只有 setTimeout，
 * 不用 setInterval / cron / 全局共享定时器。deliver 抛错时保留 sidecar（at-least-once）。
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { WAKE_MAX_HORIZON_MS, formatWakeAt } from "@axeuh/loom-core";

import type { WakeObservationInput } from "../flow/index.js";

export interface WakeSchedulerOptions {
  readonly stateRoot: string;
  readonly now?: () => number;
  readonly deliver: (
    sessionID: string,
    line: string,
    props: Readonly<Record<string, unknown>>,
  ) => void;
  /**
   * 到点行渲染（flow 接线用）：null = 该唤醒已过期（无主体仍 due），跳过投递并删除
   * sidecar；缺省 = 旧行为（formatAutoWakeLine 恒投递）。
   */
  readonly render?: (sessionID: string, at: number) => string | null;
  readonly hasSession: (sessionID: string) => boolean;
  readonly log?: (level: "warn" | "info", msg: string, fields: Record<string, unknown>) => void;
  readonly maxTimerMs?: number;
  /** L9 观察缝：投递成功 / stale 跳过；回调自炸吞断。 */
  readonly observe?: (event: WakeObservationInput) => void;
  /** delivered 事件反查 subject_at；缺省/抛错 = null。 */
  readonly subjectAt?: (sessionID: string, scheduledAt: number) => number | null;
}

export type AutoWakeNotifyProps = {
  readonly title: string;
  readonly message: string;
  readonly variant: "info";
};

const DEFAULT_MAX_TIMER_MS = 2_147_000_000;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const VALID_SID_RE = /^[a-zA-Z0-9_]+$/;
const SIDECAR_SUFFIX = ".json";

type TimerHandle = ReturnType<typeof setTimeout>;

interface TimerEntry {
  readonly at: number;
  readonly timer: TimerHandle;
}

/** 同 pid 同刻多次写的 tmp 名去重（与 registry #syncQueueSidecar 同口径）。 */
let tmpSeq = 0;

export function formatAutoWakeLine(at: number): string {
  return `【自动唤醒】设定的唤醒时间已到（${formatWakeAt(at)}，本地时间）。请继续处理此前挂起的任务。`;
}

export function autoWakeNotifyProps(at: number): AutoWakeNotifyProps {
  return { title: "自动唤醒", message: `设定时间已到（${formatWakeAt(at)}）`, variant: "info" };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

function unrefTimer(handle: TimerHandle): void {
  // vitest 假定时器的返回值可能不是 NodeJS.Timeout；unref 缺失时静默跳过。
  const candidate: { unref?: () => void } = handle;
  candidate.unref?.();
}

export class WakeScheduler {
  readonly #stateRoot: string;
  readonly #now: () => number;
  readonly #deliver: WakeSchedulerOptions["deliver"];
  readonly #render: WakeSchedulerOptions["render"];
  readonly #hasSession: WakeSchedulerOptions["hasSession"];
  readonly #logSink: WakeSchedulerOptions["log"];
  readonly #observeSink: WakeSchedulerOptions["observe"];
  readonly #subjectAt: WakeSchedulerOptions["subjectAt"];
  readonly #maxTimerMs: number;
  readonly #timers = new Map<string, TimerEntry>();

  constructor(opts: WakeSchedulerOptions) {
    this.#stateRoot = opts.stateRoot;
    this.#now = opts.now ?? Date.now;
    this.#deliver = opts.deliver;
    this.#render = opts.render;
    this.#hasSession = opts.hasSession;
    this.#logSink = opts.log;
    this.#observeSink = opts.observe;
    this.#subjectAt = opts.subjectAt;
    const configured = opts.maxTimerMs ?? DEFAULT_MAX_TIMER_MS;
    this.#maxTimerMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_TIMER_MS;
  }

  /** `at === null` = 取消；非法/超视界 = 保持原状（忽略 + WARN）。 */
  arm(sessionID: string, at: number | null): void {
    if (!VALID_SID_RE.test(sessionID)) {
      this.#log("warn", "loom auto-wake rejected: invalid session id", { sessionID });
      return;
    }
    if (at !== null) {
      if (!Number.isFinite(at)) {
        this.#log("warn", "loom auto-wake rejected: non-finite at", { sessionID, at });
        return;
      }
      if (at > this.#now() + WAKE_MAX_HORIZON_MS) {
        this.#log("warn", "loom auto-wake rejected: beyond max horizon", { sessionID, at });
        return;
      }
    }
    this.#clearTimer(sessionID);
    if (at === null) {
      this.#removeSidecar(sessionID);
      return;
    }
    this.#writeSidecar(sessionID, at);
    this.#schedule(sessionID, at);
  }

  /** 取消并清掉持久面（幂等）。 */
  clear(sessionID: string): void {
    this.#clearTimer(sessionID);
    this.#removeSidecar(sessionID);
  }

  /** 重启恢复：sidecar 目录 → 定时器；坏条目删除并计入 dropped。 */
  restore(): { restored: number; dropped: number } {
    let restored = 0;
    let dropped = 0;
    const dir = this.#wakeDir();
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      if (!isEnoent(err)) {
        this.#log("warn", "loom auto-wake restore: read dir failed", { dir, error: errorMessage(err) });
      }
      return { restored, dropped };
    }
    const now = this.#now();
    for (const name of names) {
      if (!name.endsWith(SIDECAR_SUFFIX)) continue;
      const sessionID = name.slice(0, -SIDECAR_SUFFIX.length);
      const file = join(dir, name);
      const at = this.#readSidecar(file, sessionID);
      if (at === null) {
        this.#removeFile(file);
        this.#log("warn", "loom auto-wake sidecar dropped: invalid", { file });
        dropped += 1;
        continue;
      }
      if (at > now + WAKE_MAX_HORIZON_MS) {
        this.#removeFile(file);
        this.#log("warn", "loom auto-wake sidecar dropped: beyond max horizon", { file, at });
        dropped += 1;
        continue;
      }
      if (at < now - STALE_AFTER_MS) {
        this.#removeFile(file);
        this.#log("warn", "loom auto-wake sidecar dropped: stale", { file, at });
        dropped += 1;
        continue;
      }
      this.#clearTimer(sessionID);
      this.#schedule(sessionID, at);
      restored += 1;
    }
    return { restored, dropped };
  }

  pending(sessionID: string): number | undefined {
    return this.#timers.get(sessionID)?.at;
  }

  /** 只清内存定时器；sidecar 保留给下次启动 restore（进程退出不该丢唤醒）。 */
  dispose(): void {
    for (const entry of this.#timers.values()) clearTimeout(entry.timer);
    this.#timers.clear();
  }

  #wakeDir(): string {
    return join(this.#stateRoot, "session", "wake");
  }

  #wakeFile(sessionID: string): string {
    return join(this.#wakeDir(), `${sessionID}${SIDECAR_SUFFIX}`);
  }

  #schedule(sessionID: string, at: number): void {
    const delay = Math.min(at - this.#now(), this.#maxTimerMs);
    const handle = setTimeout(() => {
      this.#onTimer(sessionID);
    }, delay > 0 ? delay : 0);
    unrefTimer(handle);
    this.#timers.set(sessionID, { at, timer: handle });
  }

  /** 长延时按 maxTimerMs 分块；块到期仍未到点就续，避免 setTimeout 溢出。 */
  #onTimer(sessionID: string): void {
    const entry = this.#timers.get(sessionID);
    if (entry === undefined) return;
    if (this.#now() < entry.at) {
      this.#schedule(sessionID, entry.at);
      return;
    }
    this.#fire(sessionID);
  }

  #fire(sessionID: string): void {
    const entry = this.#timers.get(sessionID);
    if (entry === undefined) return;
    this.#timers.delete(sessionID);
    const at = entry.at;
    if (!this.#hasSession(sessionID)) {
      // 会话已不在：绝不回落给别的会话，删掉持久面。
      this.#removeSidecar(sessionID);
      this.#log("warn", "loom auto-wake dropped: session not found", { sessionID, at });
      return;
    }
    let line = formatAutoWakeLine(at);
    if (this.#render !== undefined) {
      let rendered: string | null;
      try {
        rendered = this.#render(sessionID, at);
      } catch (err) {
        // 渲染失败按投递失败同口径：保留 sidecar 等下次启动重试，绝不静默吞。
        this.#log("warn", "loom auto-wake render failed (sidecar kept for retry)", {
          sessionID,
          at,
          error: errorMessage(err),
        });
        return;
      }
      if (rendered === null) {
        this.#removeSidecar(sessionID);
        this.#log("info", "loom auto-wake skipped: renderer reports stale", { sessionID, at });
        this.#observe({ type: "wake.stale", session_id: sessionID, scheduled_at: at });
        return;
      }
      line = rendered;
    }
    try {
      this.#deliver(sessionID, line, autoWakeNotifyProps(at));
    } catch (err) {
      // at-least-once：保留 sidecar，下次启动 restore 再试。
      this.#log("warn", "loom auto-wake deliver failed (sidecar kept for retry)", {
        sessionID,
        at,
        error: errorMessage(err),
      });
      return;
    }
    this.#removeSidecar(sessionID);
    let subjectAt: number | null = null;
    try {
      subjectAt = this.#subjectAt?.(sessionID, at) ?? null;
    } catch {
      /* 反查失败按不可派生处理，不反噬投递 */
    }
    this.#observe({
      type: "wake.delivered",
      session_id: sessionID,
      scheduled_at: at,
      subject_at: subjectAt,
    });
  }

  #clearTimer(sessionID: string): void {
    const entry = this.#timers.get(sessionID);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.#timers.delete(sessionID);
  }

  #writeSidecar(sessionID: string, at: number): void {
    const file = this.#wakeFile(sessionID);
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${String(process.pid)}.${String(++tmpSeq)}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ sessionID, at })}\n`, "utf8");
      renameSync(tmp, file);
    } catch (err) {
      this.#log("warn", "loom auto-wake sidecar write failed", { sessionID, error: errorMessage(err) });
    }
  }

  #readSidecar(file: string, sessionID: string): number | null {
    if (!VALID_SID_RE.test(sessionID)) return null;
    try {
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (typeof raw !== "object" || raw === null) return null;
      if (!("sessionID" in raw) || raw.sessionID !== sessionID) return null;
      if (!("at" in raw)) return null;
      const at = raw.at;
      if (typeof at !== "number" || !Number.isFinite(at)) return null;
      return at;
    } catch {
      return null;
    }
  }

  #removeSidecar(sessionID: string): void {
    if (!VALID_SID_RE.test(sessionID)) return;
    this.#removeFile(this.#wakeFile(sessionID));
  }

  #removeFile(file: string): void {
    try {
      unlinkSync(file);
    } catch (err) {
      if (!isEnoent(err)) {
        this.#log("warn", "loom auto-wake sidecar delete failed", { file, error: errorMessage(err) });
      }
    }
  }

  #log(level: "warn" | "info", msg: string, fields: Record<string, unknown>): void {
    try {
      this.#logSink?.(level, msg, fields);
    } catch {
      /* 日志 sink 自炸不反噬调度链 */
    }
  }

  #observe(event: WakeObservationInput): void {
    try {
      this.#observeSink?.(event);
    } catch {
      /* 观察 sink 自炸不反噬调度链 */
    }
  }
}
