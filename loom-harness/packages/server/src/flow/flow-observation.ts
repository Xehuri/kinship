/**
 * L9 flow 观察窗：把唤醒/终态/idle/unset 事实追加到独立 JSONL（默认关闭、零行为改动）。
 *
 * 落盘 `{stateRoot}/flow-observation/events.jsonl`（只追加）与 `window.json`（观察窗）。
 * 所有写入 fail-soft：观察面自炸绝不反噬 run、wake、idle 或 unset 审计。
 */

import { appendFileSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const FLOW_OBSERVATION_DIR = "flow-observation";
export const FLOW_OBSERVATION_EVENTS_FILE = "events.jsonl";
export const FLOW_OBSERVATION_WINDOW_FILE = "window.json";
export const FLOW_OBSERVATION_WINDOW_SCHEMA = 1;

export interface FlowObservationWindow {
  readonly schema: typeof FLOW_OBSERVATION_WINDOW_SCHEMA;
  readonly started_at: number;
  readonly ends_at: number;
  readonly days: number;
}

export interface WakeArmedObservation {
  readonly type: "wake.armed";
  readonly session_id: string;
  readonly subject_at: number;
  readonly scheduled_at: number;
}

export interface WakeDeliveredObservation {
  readonly type: "wake.delivered";
  readonly session_id: string;
  readonly scheduled_at: number;
  /** 由 registry 的 (subjectAt → scheduledAt) 计划反查；查不到为 null。 */
  readonly subject_at: number | null;
}

export interface WakeDuplicateSuppressedObservation {
  readonly type: "wake.duplicate_suppressed";
  readonly session_id: string;
  readonly subject_at: number;
}

export interface WakeStaleObservation {
  readonly type: "wake.stale";
  readonly session_id: string;
  readonly scheduled_at: number;
}

export interface WakeClearedObservation {
  readonly type: "wake.cleared";
  readonly session_id: string;
  readonly subject_ats: readonly number[];
}

export interface FlowEndedObservation {
  readonly type: "flow.ended";
  readonly session_id: string;
  readonly subject_id: string;
  readonly state: string;
  readonly next_decision_at: number | null;
}

export interface SessionIdleObservation {
  readonly type: "session.idle";
  readonly session_id: string;
  readonly has_flow: boolean;
  readonly flow: { readonly subject_id: string; readonly state: string } | null;
}

export interface FlowUnsetObservation {
  readonly type: "flow.unset";
  readonly session_id: string;
  readonly reason: string;
  readonly turn_idx: number;
}

export type FlowObservationInput =
  | WakeArmedObservation
  | WakeDeliveredObservation
  | WakeDuplicateSuppressedObservation
  | WakeStaleObservation
  | WakeClearedObservation
  | FlowEndedObservation
  | SessionIdleObservation
  | FlowUnsetObservation;

/** 调度器只产这两个事件；类型单独收窄，避免让 scheduler 依赖整个观察面。 */
export type WakeObservationInput = WakeDeliveredObservation | WakeStaleObservation;

export interface FlowObservationSink {
  observe(event: FlowObservationInput): void;
}

export interface FlowObservationOptions {
  readonly stateRoot: string;
  /** 事件时钟注入（测试固定值）；缺省 Date.now。 */
  readonly now?: () => number;
}

export interface FlowObservationLine {
  readonly ts: number;
}

let tmpSeq = 0;

/** 原子写窗口文件；观察面失败返回 null，不抛。 */
function writeWindowAtomic(file: string, window: FlowObservationWindow): FlowObservationWindow | null {
  let tmp: string | null = null;
  try {
    mkdirSync(dirname(file), { recursive: true });
    tmp = `${file}.${String(process.pid)}.${String(++tmpSeq)}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(window)}\n`, "utf8");
    renameSync(tmp, file);
    return window;
  } catch {
    if (tmp !== null) {
      try {
        unlinkSync(tmp);
      } catch {
        // tmp 未落地时无需清理
      }
    }
    return null;
  }
}

export class JsonFlowObservationSink implements FlowObservationSink {
  readonly #dir: string;
  readonly #eventsFile: string;
  readonly #windowFile: string;
  readonly #now: () => number;

  constructor(options: FlowObservationOptions) {
    this.#dir = join(options.stateRoot, FLOW_OBSERVATION_DIR);
    this.#eventsFile = join(this.#dir, FLOW_OBSERVATION_EVENTS_FILE);
    this.#windowFile = join(this.#dir, FLOW_OBSERVATION_WINDOW_FILE);
    this.#now = options.now ?? Date.now;
  }

  get directory(): string {
    return this.#dir;
  }

  get eventsFile(): string {
    return this.#eventsFile;
  }

  get windowFile(): string {
    return this.#windowFile;
  }

  /** 追加一条事件；任何 IO/序列化错误吞断（观察面绝不反噬主链）。 */
  observe(event: FlowObservationInput): void {
    try {
      mkdirSync(this.#dir, { recursive: true });
      const line: FlowObservationLine & FlowObservationInput = { ts: this.#now(), ...event };
      appendFileSync(this.#eventsFile, `${JSON.stringify(line)}\n`, "utf8");
    } catch {
      /* fail-soft：观察写失败不影响 run / wake / idle */
    }
  }

  /** 开窗（覆盖旧窗）；失败返回 null。 */
  startWindow(days: number): FlowObservationWindow | null {
    if (!Number.isFinite(days) || days <= 0) return null;
    const startedAt = this.#now();
    const window: FlowObservationWindow = {
      schema: FLOW_OBSERVATION_WINDOW_SCHEMA,
      started_at: startedAt,
      ends_at: startedAt + Math.round(days * 24 * 60 * 60 * 1000),
      days,
    };
    return writeWindowAtomic(this.#windowFile, window);
  }
}

export function createFlowObservationSink(
  options: FlowObservationOptions,
): JsonFlowObservationSink {
  return new JsonFlowObservationSink(options);
}
