/**
 * T21 trace/span 审计测试。
 * 验收（docs/02 §T21）：一次 full-run 产出全阶段 span、必需字段齐、
 * assembly 行数常量性（D20）、日期分文件、坏行容忍、临时目录写测毕清理。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Tracer,
  TraceError,
  localDateKey,
  parseTraceJsonl,
  readTraceFile,
  groupByRun,
  spansOnly,
  SPAN_STAGES,
  TRACE_ID_PATTERN,
} from "./index.js";
import type { RunSpan, TraceNudge, TraceRecord, TraceRunEnd } from "./index.js";

// 假时钟：每次读数 +10ms，duration 可精确断言。
function fakeClock(start: number): () => number {
  let t = start;
  return () => {
    const cur = t;
    t += 10;
    return cur;
  };
}

// 构造 fake full-run：queued→admitted→assembly→turn[0]→tool[0]→turn[1]→summary→delivered
// 含 nudge、failure/retry、cache-read 命中、模型 provider、工具级粒度、assembly 行数。
function driveFullRun(tracer: Tracer, sessionId: string, assemblyRowCount: number): RunSpan[] {
  const run = tracer.startRun({ sessionId, workflow: "loom-default" });

  const q = run.openSpan("queued");
  run.closeSpan(q);

  const ad = run.openSpan("admitted");
  run.closeSpan(ad, { attrs: { schedule_paused: false } });

  const asm = run.openSpan("assembly");
  run.closeSpan(asm, { assemblyRowCount });

  const t0 = run.openSpan("turn", { index: 0 });
  run.nudge("steer", { spanId: t0, detail: "user injected steering" });
  run.closeSpan(t0, {
    index: 0,
    tokens: { input: 100, output: 20, cacheRead: 0 },
    model: { provider: "eflowcode", modelId: "qwen3.8-flash" },
    failure: { reason: "upstream 5xx", retryable: true },
    retry: { reason: "upstream 5xx", attempt: 2 },
  });

  const tl = run.openSpan("tool", { index: 0, parentSpanId: t0, name: "bash" });
  run.closeSpan(tl, { index: 0 });

  const t1 = run.openSpan("turn", { index: 1, parentSpanId: t0 });
  run.closeSpan(t1, {
    index: 1,
    tokens: { input: 80, output: 30, cacheRead: 64 },
    model: { provider: "eflowcode" },
  });

  const su = run.openSpan("summary");
  run.closeSpan(su, { tokens: { input: 40, output: 8, cacheRead: 0 } });

  const dv = run.openSpan("delivered");
  run.closeSpan(dv);

  run.finishRun("ok");
  return [...run.spans];
}

describe("T21 Tracer · full-run span 链", () => {
  let stateRoot: string;

  beforeEach(() => {
    stateRoot = mkdtempSync(join(tmpdir(), "loom-trace-"));
  });

  afterEach(() => {
    rmSync(stateRoot, { recursive: true, force: true });
  });

  it("fake full-run 产出全阶段 span，顺序与骨架一致", () => {
    const tracer = new Tracer({ stateRoot, clock: fakeClock(1000) });
    const spans = driveFullRun(tracer, "ses_deadbeefdeadbeef", 42);

    expect(spans.map((s) => s.stage)).toEqual(["queued", "admitted", "assembly", "turn", "tool", "turn", "summary", "delivered"]);
    for (const stage of SPAN_STAGES) {
      expect(spans.map((s) => s.stage)).toContain(stage);
    }
  });

  it("每个 span 行带 start/end/durationMs 且 duration=end-start", () => {
    const tracer = new Tracer({ stateRoot, clock: fakeClock(1000) });
    const spans = driveFullRun(tracer, "ses_0000000000000000", 7);
    for (const s of spans) {
      expect(typeof s.start).toBe("number");
      expect(typeof s.end).toBe("number");
      expect(s.durationMs).toBe(s.end - s.start);
      expect(s.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("token in/out、cache-read 命中、model provider 字段齐", () => {
    const tracer = new Tracer({ stateRoot, clock: fakeClock(1000) });
    const spans = driveFullRun(tracer, "ses_0000000000000000", 7);
    const t0 = spans.find((s) => s.stage === "turn" && s.index === 0);
    expect(t0?.tokens).toEqual({ input: 100, output: 20, cacheRead: 0 });
    expect(t0?.model?.provider).toBe("eflowcode");

    const t1 = spans.find((s) => s.stage === "turn" && s.index === 1);
    expect(t1?.tokens?.cacheRead).toBe(64); // cache-read 命中
  });

  it("failure/retry reason 记录在 span 上", () => {
    const tracer = new Tracer({ stateRoot, clock: fakeClock(1000) });
    const spans = driveFullRun(tracer, "ses_0000000000000000", 7);
    const t0 = spans.find((s) => s.stage === "turn" && s.index === 0);
    expect(t0?.failure?.reason).toBe("upstream 5xx");
    expect(t0?.retry).toEqual({ reason: "upstream 5xx", attempt: 2 });
  });

  it("nudge 事件独立成行、关联 spanId", () => {
    const tracer = new Tracer({ stateRoot, clock: fakeClock(1000), dateKey: "2026-10-08" });
    const spans = driveFullRun(tracer, "ses_0000000000000000", 7);
    const recs = readTraceFile(stateRoot, "2026-10-08");
    const nudges = recs.filter((r): r is TraceNudge => r.kind === "nudge");
    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.event).toBe("steer");
    expect(nudges[0]?.spanId).toBe(spans.find((s) => s.stage === "turn" && s.index === 0)?.spanId);
  });

  it("工具级粒度：tool span 记名字、index、parentSpanId 指向所属 turn", () => {
    const tracer = new Tracer({ stateRoot, clock: fakeClock(1000) });
    const spans = driveFullRun(tracer, "ses_0000000000000000", 7);
    const tool = spans.find((s) => s.stage === "tool");
    expect(tool?.name).toBe("bash");
    expect(tool?.index).toBe(0);
    const t0 = spans.find((s) => s.stage === "turn" && s.index === 0);
    expect(tool?.parentSpanId).toBe(t0?.spanId);
  });

  it("span id / run id 无连字符且符合前端 id 白名单（D31/D34 同族）", () => {
    const tracer = new Tracer({ stateRoot, clock: fakeClock(1000) });
    const spans = driveFullRun(tracer, "ses_0000000000000000", 7);
    for (const s of spans) {
      expect(s.spanId).toMatch(TRACE_ID_PATTERN);
      expect(s.runId).toMatch(TRACE_ID_PATTERN);
      expect(s.spanId).not.toContain("-");
    }
  });

  it("finishRun 写 run_end 聚合：status、totals 含 cacheRead 与 span 数", () => {
    const tracer = new Tracer({ stateRoot, clock: fakeClock(1000), dateKey: "2026-10-08" });
    driveFullRun(tracer, "ses_0000000000000000", 7);
    const recs = readTraceFile(stateRoot, "2026-10-08");
    const ends = recs.filter((r): r is TraceRunEnd => r.kind === "run_end");
    expect(ends).toHaveLength(1);
    const end = ends[0];
    expect(end?.status).toBe("ok");
    expect(end?.totals).toEqual({ input: 220, output: 58, cacheRead: 64, spans: 8 });
    expect(end?.durationMs).toBe((end?.endedAt ?? 0) - (end?.startedAt ?? 0));
  });

  it("落盘 JSONL：一行一条 JSON，8 span + 1 nudge + 1 run_end 共 10 行", () => {
    const tracer = new Tracer({ stateRoot, clock: fakeClock(1000) });
    driveFullRun(tracer, "ses_0000000000000000", 7);
    const lines = readFileSync(join(tracer.traceDir, `${localDateKey(1000)}.jsonl`), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(10);
    const recs: TraceRecord[] = lines.map((l) => JSON.parse(l) as TraceRecord);
    expect(recs.every((r) => r.runId === recs[0]?.runId)).toBe(true);
  });
});

describe("T21 D20 assembly 常量性", () => {
  it("前缀未变的两次 run，assemblyRowCount 一致且都落盘", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-trace-a-"));
    try {
      const tracer = new Tracer({ stateRoot: root, clock: fakeClock(5000) });
      const first = driveFullRun(tracer, "ses_1111111111111111", 137);
      const second = driveFullRun(tracer, "ses_1111111111111111", 137);
      const a1 = first.find((s) => s.stage === "assembly");
      const a2 = second.find((s) => s.stage === "assembly");
      expect(a1?.assemblyRowCount).toBe(137);
      expect(a2?.assemblyRowCount).toBe(a1?.assemblyRowCount); // 常量性证明
      const rows = spansOnly(readTraceFile(root, localDateKey(5000))).filter((s) => s.stage === "assembly");
      expect(rows.map((r) => r.assemblyRowCount)).toEqual([137, 137]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("T21 JSONL 日期分文件 / 坏行容忍", () => {
  it("dateKey 覆盖可分日：不同 dateKey 各成一文件", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-trace-d-"));
    try {
      const t1 = new Tracer({ stateRoot: root, clock: fakeClock(1000), dateKey: "2026-10-07" });
      const t2 = new Tracer({ stateRoot: root, clock: fakeClock(1000), dateKey: "2026-10-08" });
      driveFullRun(t1, "ses_3333333333333333", 1);
      driveFullRun(t2, "ses_3333333333333333", 1);
      expect(existsSync(join(root, "trace", "2026-10-07.jsonl"))).toBe(true);
      expect(existsSync(join(root, "trace", "2026-10-08.jsonl"))).toBe(true);
      expect(readTraceFile(root, "2026-10-07")).toHaveLength(10);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("读侧跳过撕裂坏行，合法行不受影响", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-trace-t-"));
    try {
      const tracer = new Tracer({ stateRoot: root, clock: fakeClock(1000), dateKey: "2026-10-08" });
      const run = tracer.startRun({ sessionId: "ses_4444444444444444" });
      const sp = run.openSpan("queued");
      run.closeSpan(sp);
      run.finishRun("ok");

      const path = join(root, "trace", "2026-10-08.jsonl");
      // 模拟崩溃现场：半行（截断 JSON）+ 空行 + 未知 kind + 含连字符 runId
      appendFileSync(path, '{"kind":"span","runId":"run_555', "utf8");
      appendFileSync(path, "\n\n", "utf8");
      appendFileSync(path, '{"kind":"bogus"}\n', "utf8");
      appendFileSync(path, '{"kind":"span","runId":"has-dash","stage":"queued","spanId":"x","start":1,"end":2}\n', "utf8");

      const recs = readTraceFile(root, "2026-10-08");
      expect(recs.filter((r) => r.kind === "span")).toHaveLength(1); // 只有合法 span 行存活
      expect(recs.filter((r) => r.kind === "run_end")).toHaveLength(1);
      const text = readFileSync(path, "utf8");
      expect(parseTraceJsonl(text)).toHaveLength(recs.length);
      expect(spansOnly(recs)).toHaveLength(1);
      expect(groupByRun(recs).size).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("T21 RunTracker 契约", () => {
  it("closeSpan 未知 id 抛 TraceError", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-trace-c-"));
    try {
      const tracer = new Tracer({ stateRoot: dir, clock: fakeClock(1000) });
      const run = tracer.startRun();
      expect(() => run.closeSpan("spn_0000000000000000")).toThrow(TraceError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finishRun 后写入拒绝；重复 finishRun 拒绝；显式 runId 含连字符拒绝", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-trace-c2-"));
    try {
      const tracer = new Tracer({ stateRoot: dir, clock: fakeClock(1000) });
      const run = tracer.startRun();
      run.finishRun("cancelled");
      expect(() => run.openSpan("queued")).toThrow(TraceError);
      expect(() => run.finishRun("ok")).toThrow(TraceError);
      expect(() => tracer.startRun({ runId: "run-bad" })).toThrow(TraceError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("未 close 的 span 不进 run_end totals（open 泄漏不计）", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-trace-c3-"));
    try {
      const tracer = new Tracer({ stateRoot: dir, clock: fakeClock(1000) });
      const run = tracer.startRun();
      run.openSpan("turn");
      const end = run.finishRun("error");
      expect(end.totals.spans).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
