// T31 serve 装配 —— run 观测面收尾（T21 Tracer 的生产调用方，trace-wiring 的 A/B 半边）。
//
// 口径：
//   - beginRun：引擎 expected fsync 后调用，tracer.startRun 用账本 run_id/session_id/workflow
//     开跟踪器；该 run 当日 trace 分片（run 开始时刻本地日期，T21 契约）由此钉死。
//   - noteNudge：gate 每条 nudged outcome 实时落一行 kind:"nudge"
//     （event=reason，detail 带 nudgeCount 累计值）。
//   - finishRun：引擎终态盖棺处落一行 kind:"run_end"，终态映射与账本一致：
//     done→ok；partial→error（RunStatus 词表无 partial，不完整从严、绝不报成 ok）；
//     failed 且 cancelRequested→cancelled；其余 failed/crashed→error。
//     totals W16-F4 口径：record.usage（执行端口自内核 RunSummary 透传的实测终局）为真源，
//     缺席（崩溃形）回落 tracker span 累加。
//   - tracker 保留（finish 不删）→ 重复 finishRun 天然幂等（第二次触发 TraceError 被吞）；
//     注册表 FIFO 上限逐出，长跑不留无界 map。
//   - 一切写失败/用法错只 warn——观测面反噬执行路径 = 缺陷（tool/assembly-trace 同纪律）。

import {
  Tracer,
  type NudgeObservation,
  type RunStatus,
  type RunTracker,
} from "@axeuh/loom-core";
import type { RunRecord, RunRow } from "@axeuh/loom-core/run-engine";

type TraceLog = (level: "warn" | "error", msg: string, fields: Record<string, unknown>) => void;

/** 跟踪中的 run 数上限（FIFO 逐出；被逐出 run 的盖棺走合成回落，绝不静默丢行）。 */
const MAX_TRACKED_RUNS = 256;

export interface ServeRunTrace {
  /** run 开跑登记（引擎 onRunStarted 接线点）。 */
  beginRun(row: Pick<RunRow, "run_id" | "session_id" | "workflow">): void;
  /** 催办实时落行（gate onNudge → side-session-port → 引擎装配透传）。 */
  noteNudge(ev: NudgeObservation): void;
  /** 终态盖棺落行（引擎 onRunTerminal 接线点；非终态记录忽略）。 */
  finishRun(record: RunRecord): void;
}

// 引擎终态 → T21 RunStatus 词表的穷尽映射（cancelRequested 是真源，与账本 failed 行并存不冲突）。
function statusOf(record: RunRecord): RunStatus | null {
  switch (record.state) {
    case "done":
      return "ok";
    case "partial":
      return "error";
    case "failed":
      return record.cancelRequested !== null ? "cancelled" : "error";
    case "queued":
    case "admitted":
    case "running":
      return null;
    default: {
      const unreachable: never = record.state;
      throw new Error(`statusOf: unhandled run state ${String(unreachable)}`);
    }
  }
}

export function createServeRunTrace(opts: {
  readonly stateRoot: string;
  readonly log?: TraceLog;
}): ServeRunTrace {
  const tracer = new Tracer({ stateRoot: opts.stateRoot });
  /** run_id → {tracker, session_id}（Map 迭代序 = 插入序，逐出取首位）。 */
  const trackers = new Map<string, { tracker: RunTracker; sessionId: string }>();
  /** session_id → run_id（nudge 观察只带 sessionId，join 回账本身份靠此索引）。 */
  const bySession = new Map<string, string>();

  function evictOldest(): void {
    if (trackers.size < MAX_TRACKED_RUNS) return;
    const oldest = trackers.keys().next();
    if (oldest.done) return;
    const entry = trackers.get(oldest.value);
    trackers.delete(oldest.value);
    if (entry !== undefined && bySession.get(entry.sessionId) === oldest.value) {
      bySession.delete(entry.sessionId);
    }
  }

  function register(row: Pick<RunRow, "run_id" | "session_id" | "workflow">): RunTracker {
    evictOldest();
    const tracker = tracer.startRun({
      runId: row.run_id,
      sessionId: row.session_id,
      workflow: row.workflow,
    });
    trackers.set(row.run_id, { tracker, sessionId: row.session_id });
    bySession.set(row.session_id, row.run_id);
    return tracker;
  }

  return {
    beginRun(row) {
      if (trackers.has(row.run_id)) return;
      try {
        register(row);
      } catch (err) {
        opts.log?.("warn", "loom run trace begin failed", {
          run_id: row.run_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    noteNudge(ev) {
      const runId = bySession.get(ev.sessionId);
      const entry = runId === undefined ? undefined : trackers.get(runId);
      if (entry === undefined || runId === undefined) {
        opts.log?.("warn", "loom nudge trace has no tracker (evicted or main-session)", {
          sessionId: ev.sessionId,
          reason: ev.reason,
          nudgeCount: ev.nudgeCount,
        });
        return;
      }
      try {
        entry.tracker.nudge(ev.reason, { detail: `nudgeCount=${String(ev.nudgeCount)}` });
      } catch (err) {
        opts.log?.("warn", "loom nudge trace write failed", {
          run_id: runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    finishRun(record) {
      const status = statusOf(record);
      if (status === null) return;
      const runId = record.row.run_id;
      try {
        if (!trackers.has(runId)) {
          // 被逐出/未登记也要盖棺：合成开跑+收尾（startedAt≈endedAt，durationMs 如实近零）。
          register(record.row);
        }
        const entry = trackers.get(runId);
        if (entry === undefined) return;
        // W16-F4 totals 取数口：record.usage（内核 RunSummary 实测终局）优先；缺席回落 span 累加。
        const u = record.usage;
        entry.tracker.finishRun(
          status,
          u === undefined ? undefined : { input: u.input, output: u.output, cacheRead: u.cacheRead },
        );
        // 保留条目做幂等锚（重复 finishRun 触发 TraceError 被本 catch 吞掉，只留一行）。
      } catch (err) {
        opts.log?.("warn", "loom run_end trace write failed or duplicate", {
          run_id: runId,
          status,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
