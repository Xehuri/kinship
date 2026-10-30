/**
 * W57 P5：把 CompactionWorkerEvent 投影成 per-session SSE 帧。
 *
 * 本模块只做展示面：虚拟 part id、reasoning/content delta、节流、脱敏与终态 flush。
 * 不写 transcript、不改 boundary、不影响 worker 成败；hub.publish 失败由 EventHub 自己隔离。
 */

import type { CompactionWorkerEvent, CompactionReason } from "@axeuh/loom-core";
import { sanitizeId } from "../events/types.js";

export interface CompactionStreamPublisherOptions {
  readonly hub: { publish(type: string, sessionID: string, properties?: Readonly<Record<string, unknown>>): void };
  readonly sessionID: string;
  readonly flushIntervalMs?: number;
  readonly flushMaxBytes?: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 50;
const DEFAULT_FLUSH_MAX_BYTES = 4096;
/** 流式脱敏的尾部保留窗口；只发送确定不在机密 token 中间的文本。 */
const SCRUB_HOLD_BACK_CHARS = 128;

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,
  /(?:AKIA|ASIA|ABIA|ACCA|A3T)[A-Z0-9]{16}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /(?:sk|pk|rp)_live_[A-Za-z0-9]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\d{8,10}:AA[A-Za-z0-9_-]{33}/g,
  /\b(?:password|passwd|pwd|secret|api[_-]?key|token)\b\s*[:=]\s*\S{6,}/gi,
];

/** 出网前脱敏；保留键名，只替换命中的整段。 */
export function scrubCompactionText(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[SECRET]");
  return out;
}

/** 跨 delta 保留尾部，避免 `sk-` 被拆成两次 flush。 */
class StreamingScrubber {
  #pending = "";

  push(text: string): string {
    this.#pending += text;
    if (this.#pending.length <= SCRUB_HOLD_BACK_CHARS) return "";
    let cut = this.#pending.length - SCRUB_HOLD_BACK_CHARS;
    const newline = this.#pending.lastIndexOf("\n", cut);
    const space = this.#pending.lastIndexOf(" ", cut);
    const boundary = Math.max(newline, space);
    if (boundary > 0) cut = boundary + 1;
    const head = this.#pending.slice(0, cut);
    this.#pending = this.#pending.slice(cut);
    return scrubCompactionText(head);
  }

  flush(): string {
    const out = scrubCompactionText(this.#pending);
    this.#pending = "";
    return out;
  }
}

interface PartState {
  readonly messageID: string;
  readonly partID: string;
  readonly attemptId: string;
  readonly chunk: number;
  readonly retry: number;
  readonly part: "reasoning" | "content";
  readonly perspective?: string;
  readonly scrubber: StreamingScrubber;
  buffer: string;
  timer: ReturnType<typeof setTimeout> | null;
  registered: boolean;
  chunkPublished: boolean;
}

export class CompactionStreamPublisher {
  readonly #hub: CompactionStreamPublisherOptions["hub"];
  readonly #sessionID: string;
  readonly #flushIntervalMs: number;
  readonly #flushMaxBytes: number;
  readonly #parts = new Map<string, PartState>();
  readonly #reasons = new Map<string, CompactionReason>();
  #perspective: string | undefined;

  constructor(options: CompactionStreamPublisherOptions) {
    this.#hub = options.hub;
    this.#sessionID = sanitizeId(options.sessionID);
    this.#flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.#flushMaxBytes = options.flushMaxBytes ?? DEFAULT_FLUSH_MAX_BYTES;
  }

  handle(event: CompactionWorkerEvent): void {
    switch (event.type) {
      case "started":
        this.#perspective = undefined;
        this.#reasons.set(event.attemptId, event.reason);
        this.#hub.publish("session.compaction.started", this.#sessionID, {
          attemptId: event.attemptId,
          reason: event.reason,
        });
        return;
      case "delta":
        this.#handleDelta(event);
        return;
      case "retrying":
        this.flushAll();
        this.#hub.publish("session.compaction.retry", this.#sessionID, {
          attemptId: event.attemptId,
          retry: event.retry,
          delayMs: event.delayMs,
          errorClass: event.errorClass,
          error: event.error.message,
          ...(event.perspective === undefined ? {} : { perspective: event.perspective }),
        });
        return;
      case "succeeded": {
        const source = this.#reasons.get(event.attemptId) ?? "fallback";
        this.#endAttempt(event.attemptId);
        this.#hub.publish("session.compacted", this.#sessionID, {
          attemptId: event.attemptId,
          coveredCount: event.coveredCount,
          source,
        });
        return;
      }
      case "noop":
        this.#endAttempt(event.attemptId);
        return;
      case "failed":
        this.#endAttempt(event.attemptId);
        this.#hub.publish("session.compaction_failed", this.#sessionID, {
          attemptId: event.attemptId,
          error: { code: "compaction_failed", message: event.error.message },
          errorClass: event.errorClass,
          attemptsUsed: event.attemptsUsed,
          ...(event.perspective === undefined ? {} : { perspective: event.perspective }),
        });
        return;
      case "aborted":
        this.#endAttempt(event.attemptId);
        this.#hub.publish("session.compaction.aborted", this.#sessionID, {
          attemptId: event.attemptId,
          abortReason: event.abortReason,
          attemptsUsed: event.attemptsUsed,
        });
        return;
    }
  }

  /** 立即 flush 所有在途 part（终态/测试用）。 */
  flushAll(): void {
    for (const state of this.#parts.values()) this.#flushPart(state);
  }

  #handleDelta(event: Extract<CompactionWorkerEvent, { type: "delta" }>): void {
    const perspective = event.perspective;
    if (perspective !== this.#perspective) {
      this.flushAll();
      this.#perspective = perspective;
    }
    const safeAttempt = sanitizeId(event.attemptId);
    const messageID = `cmp_${safeAttempt}`;
    const perspectiveSegment = perspective === undefined ? "" : `_p${sanitizeId(perspective)}`;
    const partID = `${messageID}${perspectiveSegment}_c${event.chunk}_r${event.retry}_${event.part}`;
    let state = this.#parts.get(partID);
    if (state === undefined) {
      state = {
        messageID,
        partID,
        attemptId: event.attemptId,
        chunk: event.chunk,
        retry: event.retry,
        part: event.part,
        ...(perspective === undefined ? {} : { perspective }),
        scrubber: new StreamingScrubber(),
        buffer: "",
        timer: null,
        registered: false,
        chunkPublished: false,
      };
      this.#parts.set(partID, state);
    }
    if (state.part === "reasoning" && !state.registered) {
      state.registered = true;
      this.#hub.publish("message.part.updated", this.#sessionID, {
        messageID,
        part: {
          id: partID,
          sessionID: this.#sessionID,
          messageID,
          type: "reasoning",
        },
      });
    }
    if (!state.chunkPublished) {
      state.chunkPublished = true;
      this.#hub.publish("session.compaction.chunk", this.#sessionID, {
        attemptId: state.attemptId,
        chunk: state.chunk,
        retry: state.retry,
        part: state.part,
        ...(state.perspective === undefined ? {} : { perspective: state.perspective }),
      });
    }
    const safe = state.scrubber.push(event.delta);
    if (safe.length > 0) {
      state.buffer += safe;
      this.#schedule(state);
    }
    if (Buffer.byteLength(state.buffer, "utf8") >= this.#flushMaxBytes) this.#flushPart(state);
  }

  #schedule(state: PartState): void {
    if (state.timer !== null || state.buffer.length === 0) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      this.#flushPart(state);
    }, this.#flushIntervalMs);
  }

  #flushPart(state: PartState): void {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const tail = state.scrubber.flush();
    if (tail.length > 0) state.buffer += tail;
    if (state.buffer.length === 0) return;
    const delta = state.buffer;
    state.buffer = "";
    this.#hub.publish("message.part.delta", this.#sessionID, {
      messageID: state.messageID,
      partID: state.partID,
      field: "text",
      delta,
    });
  }

  #endAttempt(attemptId: string): void {
    for (const [partID, state] of this.#parts) {
      if (state.attemptId !== attemptId) continue;
      this.#flushPart(state);
      this.#parts.delete(partID);
    }
    this.#reasons.delete(attemptId);
    this.#perspective = undefined;
  }
}
