/**
 * ServeRunTrace 单测（trace run_end/nudge 生产接线，T21 Tracer 真落盘）：
 *   - 全周期：begin→nudge×N→finish 行序与字段（kind 分布出现 nudge/run_end）；
 *   - 终态映射：done→ok、partial→error、failed→error、cancel→cancelled、crashed→error；
 *   - 非终态不调写；重复 finish 幂等只留一行；未登记 run 合成盖棺不丢行；
 *   - 未知 sessionId 的 nudge fail-soft；FIFO 逐出后 finish 仍落行。
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { localDateKey, parseTraceJsonl, type TraceRecord } from "@axeuh/loom-core";
import type { RunRecord, RunRow } from "@axeuh/loom-core/run-engine";
import type { NudgeObservation } from "@axeuh/loom-core";

import { createServeRunTrace, type ServeRunTrace } from "./run-trace.js";

let workDir = "";
let warns: Array<Record<string, unknown>> = [];
let trace: ServeRunTrace;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "loom-run-trace-"));
  warns = [];
  trace = createServeRunTrace({
    stateRoot: workDir,
    log: (level, msg, fields) => warns.push({ level, msg, ...fields }),
  });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const hex = (c: string): string => c.repeat(16);

function mkRecord(row: RunRow, over: Partial<RunRecord> = {}): RunRecord {
  return {
    row,
    state: "done",
    dispatchedAt: 1,
    terminalAt: 2,
    terminal: null,
    error: null,
    crashed: false,
    cancelRequested: null,
    ...over,
  };
}

function readToday(): TraceRecord[] {
  const path = join(workDir, "trace", `${localDateKey(Date.now())}.jsonl`);
  return parseTraceJsonl(readFileSync(path, "utf8"));
}

function nudgeOf(runId: string, n: number): NudgeObservation {
  return { sessionId: mkSessionOf(runId), turnIdx: 1, reason: "text-only", nudgeCount: n };
}

function mkSessionOf(runId: string): string {
  return runId.replace(/^run_/, "ses_");
}

describe("ServeRunTrace：trace 观测面收尾", () => {
  it("全周期：nudge 行在前、run_end 盖棺在后，字段含 reason/nudgeCount/totals/终态", () => {
    const row: RunRow = {
      run_id: `run_${hex("b")}`,
      workflow: "w-obs",
      attempt: 1,
      trigger: "manual",
      parent_run: null,
      session_id: `ses_${hex("c")}`,
    };
    trace.beginRun(row);
    trace.noteNudge({ sessionId: row.session_id, turnIdx: 0, reason: "text-only", nudgeCount: 1 });
    trace.noteNudge({ sessionId: row.session_id, turnIdx: 1, reason: "fields", nudgeCount: 2 });
    trace.finishRun(mkRecord(row, { state: "done" }));

    const recs = readToday();
    expect(recs.map((r) => r.kind)).toEqual(["nudge", "nudge", "run_end"]);
    const [n1, n2] = recs as [
      Extract<TraceRecord, { kind: "nudge" }>,
      Extract<TraceRecord, { kind: "nudge" }>,
      TraceRecord,
    ];
    expect(n1.runId).toBe(row.run_id);
    expect(n1.event).toBe("text-only");
    expect(n1.detail).toBe("nudgeCount=1");
    expect(n2.event).toBe("fields");
    expect(n2.detail).toBe("nudgeCount=2");
    const end = recs[2] as Extract<TraceRecord, { kind: "run_end" }>;
    expect(end.status).toBe("ok");
    expect(end.workflow).toBe("w-obs");
    expect(end.sessionId).toBe(row.session_id);
    expect(end.totals).toEqual({ input: 0, output: 0, cacheRead: 0, spans: 0 });
    expect(end.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("终态映射：partial→error、failed→error、failed+cancel→cancelled、crashed→error；非终态零行", () => {
    const cases: Array<[Partial<RunRecord>, string]> = [
      [{ state: "partial" }, "run_" + hex("1")],
      [{ state: "failed" }, "run_" + hex("2")],
      [{ state: "failed", cancelRequested: "user stop" }, "run_" + hex("3")],
      [{ state: "failed", crashed: true }, "run_" + hex("4")],
      [{ state: "running" }, "run_" + hex("5")],
    ];
    for (const [over, runId] of cases) {
      const row: RunRow = {
        run_id: runId,
        workflow: "w",
        attempt: 1,
        trigger: "manual",
        parent_run: null,
        session_id: runId.replace(/^run_/, "ses_"),
      };
      trace.beginRun(row);
      trace.finishRun(mkRecord(row, over));
    }
    const ends = readToday().filter((r) => r.kind === "run_end");
    expect(ends.map((e) => (e as { status: string }).status)).toEqual([
      "error",
      "error",
      "cancelled",
      "error",
    ]);
  });

  it("重复 finishRun 幂等：只留一行 run_end（第二条被 TraceError 吞掉留 warn）", () => {
    const row: RunRow = {
      run_id: `run_${hex("d")}`,
      workflow: "w",
      attempt: 1,
      trigger: "manual",
      parent_run: null,
      session_id: `ses_${hex("e")}`,
    };
    trace.beginRun(row);
    trace.finishRun(mkRecord(row, { state: "done" }));
    trace.finishRun(mkRecord(row, { state: "failed" }));
    const ends = readToday().filter((r) => r.kind === "run_end");
    expect(ends).toHaveLength(1);
    expect((ends[0] as { status: string }).status).toBe("ok");
    expect(warns.some((w) => String(w["msg"]).includes("duplicate") || String(w["msg"]).includes("failed"))).toBe(true);
  });

  it("未登记 run 也盖棺（逐出/漏 begin 回落合成）：恰一行 run_end", () => {
    const row: RunRow = {
      run_id: `run_${hex("f")}`,
      workflow: "w",
      attempt: 1,
      trigger: "manual",
      parent_run: null,
      session_id: `ses_${hex("0")}`,
    };
    trace.finishRun(mkRecord(row, { state: "failed", crashed: true }));
    trace.finishRun(mkRecord(row, { state: "failed", crashed: true }));
    const recs = readToday();
    expect(recs.filter((r) => r.kind === "run_end")).toHaveLength(1);
  });

  it("未知 sessionId 的 nudge：fail-soft 留 warn，不写行不抛错", () => {
    expect(() => trace.noteNudge(nudgeOf("run_" + hex("9"), 1))).not.toThrow();
    expect(warns).toHaveLength(1);
    expect(() => readToday()).toThrow(); // 什么都没写（文件不存在）
  });

  it("W16-F4 usage 透传：record.usage 实测终局 → run_end totals 对齐；缺席回落 span 累加（=0）", () => {
    const row: RunRow = {
      run_id: `run_${hex("a1")}`,
      workflow: "w-usage",
      attempt: 1,
      trigger: "manual",
      parent_run: null,
      session_id: `ses_${hex("a2")}`,
    };
    const usage = {
      input: 197,
      output: 18,
      cacheRead: 5,
      cacheWrite: 0,
      totalTokens: 220,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    trace.beginRun(row);
    trace.finishRun(mkRecord(row, { state: "done", usage }));
    const end = readToday().find((r) => r.kind === "run_end") as Extract<TraceRecord, { kind: "run_end" }>;
    expect(end.totals).toEqual({ input: 197, output: 18, cacheRead: 5, spans: 0 });

    // 崩溃形/无 usage：totals 回落 span 累加（现网簿记面从不经 tracker close ⇒ 如实 0）。
    const row2: RunRow = { ...row, run_id: `run_${hex("b3")}`, session_id: `ses_${hex("b4")}` };
    trace.beginRun(row2);
    trace.finishRun(mkRecord(row2, { state: "failed", crashed: true }));
    const ends = readToday().filter((r) => r.kind === "run_end") as Array<Extract<TraceRecord, { kind: "run_end" }>>;
    expect(ends[1]!.totals).toEqual({ input: 0, output: 0, cacheRead: 0, spans: 0 });
  });
});
