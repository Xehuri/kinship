/**
 * T19 boundary 条目测试（撕裂重放不二次裁 / 幂等写 / 三件套形状 / 回读指针）。
 * 对应验收：boundary 含摘要+被裁范围+重读指针；撕裂重放不二次裁。
 */

import { describe, it, expect } from "vitest";
import {
  BOUNDARY_SUMMARY_MARK,
  BoundaryLedger,
  buildBoundarySummaryText,
  isBoundaryRow,
  makeBoundaryKey,
  messageRow,
  parseBoundaryRow,
  parseBoundarySummaryText,
  projectThroughBoundaries,
  serializeBoundaryRow,
  type BoundaryRecord,
} from "./boundary.js";
import { MemorySink, tr, user, textOf } from "./test-helpers.js";
import type { Message } from "./test-helpers.js";

const rec = (over: Partial<BoundaryRecord> = {}): BoundaryRecord => ({
  key: makeBoundaryKey("s1", 5),
  sessionId: "s1",
  summaryText: buildBoundarySummaryText("SUM", {
    trimmedFromSeq: 0,
    trimmedThroughSeq: 5,
    trimmedCount: 6,
    rereadPointer: "overflow://s1/s1_5.jsonl",
  }),
  trimmedFromSeq: 0,
  trimmedThroughSeq: 5,
  trimmedCount: 6,
  rereadPointer: "overflow://s1/s1_5.jsonl",
  preTokens: 1000,
  postTokens: 300,
  cacheBreakpoint: "sha256:abc",
  at: 123,
  ...over,
});

describe("boundary 三件套形状", () => {
  it("摘要块恒含：标记 + 被裁范围行 + 重读指针行 + 摘要正文", () => {
    const parsed = parseBoundarySummaryText(rec().summaryText);
    expect(parsed).not.toBeNull();
    expect(parsed!.fromSeq).toBe(0);
    expect(parsed!.throughSeq).toBe(5);
    expect(parsed!.count).toBe(6);
    expect(parsed!.pointer).toBe("overflow://s1/s1_5.jsonl");
    expect(rec().summaryText).toContain("SUM");
  });

  it("非 boundary 文本解析为 null（不误认）", () => {
    expect(parseBoundarySummaryText("hello world")).toBeNull();
  });

  it("行序列化/解析往返保真；形状校验挡住残缺行", () => {
    const a = rec();
    const b = parseBoundaryRow(serializeBoundaryRow(a));
    expect(b).toEqual(a);
    expect(isBoundaryRow(serializeBoundaryRow(a))).toBe(true);
    expect(isBoundaryRow({ t: "compaction_boundary", key: "x" })).toBe(false);
  });
});

describe("BoundaryLedger 幂等写", () => {
  it("同 key 二次 write = duplicate，L0 仅一行", () => {
    const sink = new MemorySink();
    const ledger = new BoundaryLedger(sink);
    expect(ledger.write(rec())).toBe("written");
    expect(ledger.write(rec())).toBe("duplicate");
    expect(sink.rows.filter((r) => r["t"] === "compaction_boundary")).toHaveLength(1);
  });

  it("不同 key（推进 throughSeq）正常追加第二条", () => {
    const sink = new MemorySink();
    const ledger = new BoundaryLedger(sink);
    expect(ledger.write(rec())).toBe("written");
    const r2 = rec({ key: makeBoundaryKey("s1", 9), trimmedThroughSeq: 9 });
    expect(ledger.write(r2)).toBe("written");
    expect(ledger.last()!.key).toBe(r2.key);
  });

  it("尾行撕裂（形状残缺的最后一行）容忍丢弃；last() 仍是完整的前一条", () => {
    const sink = new MemorySink();
    const ledger = new BoundaryLedger(sink);
    ledger.write(rec());
    // 模拟崩溃：撕裂的 boundary 残行直接落进 L0（JSON 截断后 parse 出的残缺对象）
    sink.rows.push({ t: "compaction_boundary", key: "s1@6" });
    expect(ledger.readAll()).toHaveLength(1);
    expect(ledger.last()!.key).toBe(rec().key);
  });
});

describe("projectThroughBoundaries：撕裂重放不二次裁", () => {
  const rows = (): { readonly [key: string]: unknown }[] => [
    messageRow(user("m0")),
    messageRow(tr("read", "m1")),
    serializeBoundaryRow(rec()),
    messageRow(user("after1")),
    messageRow(user("after2")),
  ];

  it("单条 boundary：裁掉前缀、以 summary 接续、后续消息保留", () => {
    const p = projectThroughBoundaries(rows());
    expect(p.messages.map(textOf)).toEqual([
      rec().summaryText,
      "after1",
      "after2",
    ]);
    expect(p.applied).toHaveLength(1);
    expect(p.duplicateCount).toBe(0);
  });

  it("同一 boundary 行重放两次（撕裂/补封重复投递）：只裁一次，第二次跳过", () => {
    const doubled = [...rows(), serializeBoundaryRow(rec())];
    const p = projectThroughBoundaries(doubled);
    // 若不幂等：第二裁会把 summary+after1 全丢掉，只剩 summary —— 静默数据丢失
    expect(p.messages.map(textOf)).toEqual([rec().summaryText, "after1", "after2"]);
    expect(p.duplicateCount).toBe(1);
    expect(p.applied).toHaveLength(1);
  });

  it("两条不同 boundary 顺序应用：第二条替换其前的一切（含第一条 summary）", () => {
    const r2 = rec({
      key: makeBoundaryKey("s1", 9),
      trimmedFromSeq: 6,
      trimmedThroughSeq: 9,
      summaryText: buildBoundarySummaryText("SUM2", {
        trimmedFromSeq: 6,
        trimmedThroughSeq: 9,
        trimmedCount: 4,
        rereadPointer: "overflow://s1/s1_9.jsonl",
      }),
    });
    const p = projectThroughBoundaries([...rows(), messageRow(user("m6")), serializeBoundaryRow(r2)]);
    // 语义同内核 resume 的 compaction_boundary（对照 plugins resume.test.ts）：
    // 第二条 boundary 在其行位置裁掉前缀（first summary + after1/after2/m6），只接续自己的 summary。
    expect(p.messages.map(textOf)).toEqual([r2.summaryText]);
    expect(p.applied.map((b) => b.key)).toEqual([rec().key, r2.key]);
    expect(p.lastBoundary!.key).toBe(r2.key);
  });

  it("无 boundary 的历史原样投影", () => {
    const p = projectThroughBoundaries([messageRow(user("a")), messageRow(user("b"))]);
    expect(p.messages.map(textOf)).toEqual(["a", "b"]);
    expect(p.lastBoundary).toBeNull();
  });

  it("投影入口对残缺 boundary 行响亮抛错（中段损坏不容忍——区别于 ledger 读尾行容忍）", () => {
    expect(() => projectThroughBoundaries([{ t: "compaction_boundary", key: "x" }])).toThrow(
      /bad boundary row/,
    );
  });
});

describe("重读指针语义（D21：read 按需读回，不自动塞回）", () => {
  it("boundary 摘要文本自带 pointer 行；装配方从文本即可解析指针", () => {
    const text = rec().summaryText;
    expect(text.startsWith(BOUNDARY_SUMMARY_MARK)).toBe(true);
    const parsed = parseBoundarySummaryText(text)!;
    expect(parsed.pointer).toBe(rec().rereadPointer);
  });
});
