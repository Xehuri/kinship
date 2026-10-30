/**
 * T19 压缩例程测试（docs/02 §T19 TDD：watermark/micro-first/pointer-reread 先行）。
 * 硬验收项：
 *  1. watermark 下永不重压（evaluate=none、compact 零动作零写入）；
 *  2. 先 micro 后 full（micro 够用就不花 summarize 的钱；清不动才升级 full）；
 *  3. boundary 含摘要 + 被裁范围 + 重读指针；溢出原文按指针回读得到原始消息；
 *  4. 撕裂重放不二次裁（boundary.test.ts 的 projectThroughBoundaries）；
 *  5. 压缩前后 assembly prefixHash 不变、只有增量段变（T18 断言）；
 *  6. 阈值 Limits 注入、热载现读；Summarizer 可注入 fake（绝不触真模型）。
 */

import { describe, it, expect } from "vitest";
import type { Message } from "./test-helpers.js";
import { MemorySink, chars4Counter, textOf, tr, user } from "./test-helpers.js";
import { createTestContext } from "../testing.js";
import { DEFAULT_COMPACTION_LIMITS, assertValidCompactionLimits } from "./limits.js";
import type { CompactionLimits } from "./limits.js";
import {
  BoundaryLedger,
  BOUNDARY_SUMMARY_MARK,
  MemoryArchive,
  makeBoundaryKey,
  parseBoundarySummaryText,
} from "./boundary.js";
import { CompactionRoutine, jsonlOverflowArchive } from "./routine.js";

/** 小窗口测试阈值（一切 token 按 chars4 估算，量级与真实 200k 窗口同构）。 */
function testLimits(patch: Partial<CompactionLimits> = {}): CompactionLimits {
  const l: CompactionLimits = {
    ...DEFAULT_COMPACTION_LIMITS,
    contextWindow: 1000,
    watermarkRatio: 0.85, // 850
    fullRatio: 0.95, // 950
    microTargetRatio: 0.5, // 500
    keepRecent: 4,
    microKeepRecent: 2,
    ...patch,
  };
  return l;
}

function makeRoutine(opts: {
  limits?: CompactionLimits;
  summarizeCalls?: { n: number };
  compactable?: readonly string[];
} = {}) {
  const limits = opts.limits ?? testLimits();
  const sink = new MemorySink();
  const archive = jsonlOverflowArchive(new MemoryArchive());
  const calls = opts.summarizeCalls ?? { n: 0 };
  const traces: Array<{ pre: number; post: number; tier: string; cache: string | null }> = [];
  const routine = new CompactionRoutine({
    limits,
    ledger: new BoundaryLedger(sink),
    archive,
    tokenCounter: chars4Counter,
    compactableTools: opts.compactable ?? ["read"],
    summarize: (early) => {
      calls.n += 1;
      return `SUMMARY(${String(early.length)})`;
    },
    onTrace: (info) => {
      traces.push({ pre: info.preTokens, post: info.postTokens, tier: info.tier, cache: info.cacheBreakpoint });
    },
  });
  return { routine, sink, archive, calls, traces, limits };
}

describe("evaluate：watermark 档位（D21 触发=85% 水位）", () => {
  it("水位之下恒 none；水位~full 之间 micro；超 fullRatio 才规划 full", () => {
    const { routine } = makeRoutine();
    expect(routine.evaluate(850).tier).toBe("none"); // 恰在水位=不压（<=）
    expect(routine.evaluate(851).tier).toBe("micro");
    expect(routine.evaluate(950).tier).toBe("micro");
    expect(routine.evaluate(951).tier).toBe("full");
  });

  it("Limits 热载现读：改 watermarkRatio 即刻影响下一次 evaluate（不快照）", () => {
    const { routine, limits } = makeRoutine();
    expect(routine.evaluate(851).tier).toBe("micro");
    limits.watermarkRatio = 0.9; // 热载：水位抬到 900
    expect(routine.evaluate(851).tier).toBe("none");
  });

  it("非法 Limits 构造即抛（阈值契约守门）", () => {
    expect(() => assertValidCompactionLimits(testLimits({ watermarkRatio: 1.5 }))).toThrow();
    expect(() => assertValidCompactionLimits(testLimits({ fullRatio: 0.8 }))).toThrow();
    expect(() => assertValidCompactionLimits(testLimits({ microTargetRatio: 0.9 }))).toThrow();
    const { limits } = makeRoutine();
    limits.keepRecent = 0;
    expect(() =>
      new CompactionRoutine({
        limits,
        ledger: new BoundaryLedger(new MemorySink()),
        archive: jsonlOverflowArchive(new MemoryArchive()),
        summarize: () => "S",
      }),
    ).toThrow(/invalid compaction Limits/);
  });
});

describe("compact：先 micro 后 full（D21 分级微压缩先行）", () => {
  it("水位下零动作：view 原样、不调 summarize、不写 boundary", async () => {
    const { routine, calls, sink } = makeRoutine();
    const msgs: Message[] = [user("a".repeat(40)), tr("read", "b".repeat(40))];
    const { ctx } = createTestContext();
    const r = await routine.compact({ sessionId: "s1", messages: msgs, ctx });
    expect(r.decision.tier).toBe("none");
    expect(r.executed).toBe("none");
    expect(r.view).toBe(msgs); // 原样返回（同一引用）
    expect(calls.n).toBe(0);
    expect(sink.rows).toHaveLength(0);
  });

  it("planned full 但 micro 已救回：白名单大输出被清、降到水位下即停，summarize 绝不跑", async () => {
    const { routine, calls, traces } = makeRoutine();
    // 4 条巨大 read（各 ~750 tok，chars4）+ 2 条微小 read：micro 清巨大条即降到水位下。
    const msgs: Message[] = [
      user("task"),
      ...Array.from({ length: 4 }, (_, i) => tr("read", `R${String(i)}_` + "x".repeat(3000), `c${String(i)}`)),
      ...Array.from({ length: 2 }, (_, i) => tr("read", `S${String(i)}_tiny`, `s${String(i)}`)),
    ];
    const { ctx } = createTestContext();
    const r = await routine.compact({ sessionId: "s1", messages: msgs, ctx });
    expect(r.decision.tier).toBe("full"); // 体积超 fullRatio → 规划 full
    expect(r.executed).toBe("micro"); // 但 micro 已救回来 → 不花钱
    expect(calls.n).toBe(0);
    expect(r.postTokens).toBeLessThanOrEqual(r.decision.watermarkTokens);
    expect(textOf(r.view[2]!)).not.toContain("R1_"); // 旧巨大结果被占位
    expect(textOf(msgs[2]!)).toContain("R1_"); // 原数组不被改动（copy-on-write）
    expect(textOf(r.view[r.view.length - 1]!)).toContain("S1_tiny"); // 尾部原文保留
    expect(traces).toHaveLength(1);
    expect(traces[0]!.tier).toBe("full"); // trace 记录的是规划档位
    expect(traces[0]!.pre).toBeGreaterThan(traces[0]!.post);
  });

  it("micro 规划档（水位~full 之间）：清理生效即止，summarize 绝不跑", async () => {
    const { routine, calls } = makeRoutine();
    // 总体积落在 (850, 950]：规划 micro；巨大条被清后回到水位下。
    const msgs: Message[] = [
      user("task"),
      ...Array.from({ length: 2 }, (_, i) => tr("read", `H${String(i)}_` + "x".repeat(870), `h${String(i)}`)),
      ...Array.from({ length: 2 }, (_, i) => tr("read", `M${String(i)}_` + "y".repeat(870), `m${String(i)}`)),
      ...Array.from({ length: 2 }, (_, i) => tr("read", `T${String(i)}_tiny`, `t${String(i)}`)),
    ];
    const { ctx } = createTestContext();
    const r = await routine.compact({ sessionId: "s1b", messages: msgs, ctx });
    expect(r.decision.tier).toBe("micro");
    expect(r.executed).toBe("micro");
    expect(calls.n).toBe(0);
    expect(r.boundary).toBeNull();
  });

  it("micro 救不动（非白名单）→ 升级 full：总结+boundary+归档指针", async () => {
    const { routine, calls, sink, archive, traces } = makeRoutine({ compactable: ["read"] });
    const msgs: Message[] = [
      user("q1"),
      tr("mail_send", "M1_" + "y".repeat(2000)), // 非白名单：micro 清不动
      tr("mail_send", "M2_" + "y".repeat(2000)),
      user("q2"),
      tr("mail_send", "M3_" + "y".repeat(2000)),
      user("q3"),
      tr("mail_send", "M4_" + "y".repeat(100)),
      user("q4"),
    ];
    const { ctx } = createTestContext();
    const r = await routine.compact({ sessionId: "s2", messages: msgs, ctx });
    expect(r.decision.tier).toBe("full");
    expect(r.executed).toBe("full");
    expect(calls.n).toBe(1); // 单次 Summarizer 调用（fake，不触真模型）
    expect(r.writeOutcome).toBe("written");
    expect(r.boundary).not.toBeNull();

    // boundary 三件套：摘要 + 被裁范围 + 重读指针
    const rec = r.boundary!;
    expect(rec.summaryText.startsWith(BOUNDARY_SUMMARY_MARK)).toBe(true);
    const parsed = parseBoundarySummaryText(rec.summaryText);
    expect(parsed).not.toBeNull();
    expect(parsed!.fromSeq).toBe(0);
    expect(parsed!.throughSeq).toBe(msgs.length - 1 - 4); // trimmed = 全部 - keepRecent(4)
    expect(parsed!.count).toBe(msgs.length - 4);
    expect(rec.summaryText).toContain("SUMMARY(");
    expect(parsed!.pointer).toBe(rec.rereadPointer);

    // 溢出原文按指针可回读，且拿到的是**原始**消息（非 micro 占位版）
    const loaded = archive.load(rec.rereadPointer);
    expect(loaded).not.toBeNull();
    expect(loaded!.map(textOf)).toEqual(msgs.slice(0, msgs.length - 4).map(textOf));

    // view = [boundary 摘要块, ...tail(keepRecent)]；tail 原样
    expect(r.view).toHaveLength(1 + 4);
    expect(r.view.slice(1).map(textOf)).toEqual(msgs.slice(msgs.length - 4).map(textOf));
    // L0 里确实落了一条 boundary 行
    expect(sink.rows.filter((row) => row["t"] === "compaction_boundary")).toHaveLength(1);
    // trace 带前后 token + 缓存断点（full 落 boundary 时断点非空）
    expect(traces[traces.length - 1]!.cache).toContain("sha256:");
  });

  it("裁无可裁（消息数 ≤ keepRecent）：full 只带 micro 成果，绝不产生空 boundary", async () => {
    const { routine, calls, sink } = makeRoutine({ limits: testLimits({ keepRecent: 10 }) });
    const msgs: Message[] = [
      tr("mail_send", "z".repeat(4000)),
      tr("mail_send", "w".repeat(4000)),
    ];
    const { ctx } = createTestContext();
    const r = await routine.compact({ sessionId: "s3", messages: msgs, ctx });
    expect(calls.n).toBe(0);
    expect(r.boundary).toBeNull();
    expect(sink.rows).toHaveLength(0);
  });
});

describe("boundary 幂等（撕裂重放/重跑不二次压）", () => {
  it("同 key 重跑 compact：summarize 不再调、账本不再写（duplicate）", async () => {
    const { routine, calls, sink } = makeRoutine();
    const msgs: Message[] = [
      tr("mail_send", "A".repeat(2000)),
      tr("mail_send", "B".repeat(2000)),
      tr("mail_send", "C".repeat(2000)),
      user("u1"),
      tr("mail_send", "D".repeat(2000)),
      user("u2"),
      user("u3"),
      user("u4"),
    ];
    const { ctx } = createTestContext();
    const first = await routine.compact({ sessionId: "s4", messages: msgs, ctx });
    expect(first.writeOutcome).toBe("written");
    expect(calls.n).toBe(1);

    // 模拟崩溃重跑：同一输入再 compact → 幂等预检命中既有 boundary
    const again = await routine.compact({ sessionId: "s4", messages: msgs, ctx });
    expect(calls.n).toBe(1); // 不重调 Summarizer
    expect(again.writeOutcome).toBe("duplicate");
    expect(again.boundary!.key).toBe(first.boundary!.key);
    expect(sink.rows.filter((row) => row["t"] === "compaction_boundary")).toHaveLength(1);
    // 复用既有摘要块接续 tail
    expect(textOf(again.view[0]!)).toBe(first.boundary!.summaryText);
  });

  it("boundary key 纯由输入状态决定（同 sessionId+throughSeq 同 key）", () => {
    expect(makeBoundaryKey("s", 7)).toBe(makeBoundaryKey("s", 7));
    expect(makeBoundaryKey("s", 8)).not.toBe(makeBoundaryKey("s", 7));
  });
});
