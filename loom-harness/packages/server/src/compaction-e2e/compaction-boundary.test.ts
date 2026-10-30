/**
 * T37 压缩边界端到端测试（docs/02 §T37；docs/01 D6/D21 装配纪律 + D20 增量读）。
 *
 * 端到端管线（组件全真、仅模型假）：真 CompactionRoutine(T19) + 真 BoundaryLedger
 * 幂等写 + 真 SessionShards/StateLayout(T08) JSONL 分片落盘 + 真 assemble(T18) 增量
 * 装配 + 生产默认 token 计数器（defaultTokenCounter）；假面只有 Summarizer（确定性
 * fake，绝不触真模型/网络）与 HookContext 视图（createTestContext，plugins 测试惯例）。
 *
 * 五条硬验收（任务 EXPECTED OUTCOME）：
 *  1. 长历史多轮（10 turn）→ 水位触发分档正确：水位下永不重压 / micro 先行救回即止
 *     （不花 summarize）/ 救不动才 full；
 *  2. full 的 boundary+summary 三件套落盘进真 L0（行位置/键/范围/指针重放可验）；
 *  3. 压缩前后 assembly 段0-2 字节恒定、prefixHash 全程稳定（D6 缓存前缀不变量）；
 *  4. 重读指针进下轮增量段 + 按指针回读得到被裁**原文**（D21「read 按需读回」）；
 *  5. dir 索引增量读：装配每轮 openedShards 有界（O(增量)）、游标推进零重放，
 *     readAfter(0) 才等价整目录读。
 * 附：崩溃重放幂等——重开实例 + 同输入重跑 = duplicate、零新模型调用、盘上行数不变。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Message } from "@axeuh/loom-core";
import {
  BOUNDARY_SUMMARY_MARK,
  jsonlOverflowArchive,
  parseBoundaryRow,
  parseBoundarySummaryText,
  projectThroughBoundaries,
  type BoundaryRecord,
} from "@axeuh/loom-core/compaction";
import {
  boundaryRowsOnDisk,
  FileArchiveSink,
  incrementText,
  replayLastCompact,
  runScenario,
  SCENARIO_STEPS,
  SESSION_ID,
  textOf,
  TURNS_PER_SHARD,
  turnMessages,
  type E2EScenario,
} from "./e2e-harness.js";

let root: string;
let s: E2EScenario;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "t37-e2e-"));
  s = await runScenario(root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 按 boundary 指针经真档案通道回读被裁原文（D21「溢出原文留档，read 按需读回」）。 */
function rereadOriginals(b: BoundaryRecord): readonly Message[] | null {
  const archive = jsonlOverflowArchive(new FileArchiveSink(join(s.root, "overflow")));
  return archive.load(b.rereadPointer);
}

describe("验收1：长历史多轮 → 水位触发分档（先 micro 后 full，D21 分级压缩先行）", () => {
  it("水位之下永不重压：头两轮 decision/executed 均 none、零动作零写入", () => {
    const wm = s.records[0]!.compact.decision.watermarkTokens;
    for (const r of s.records.slice(0, 2)) {
      expect(r.compact.preTokens).toBeLessThanOrEqual(wm);
      expect(r.compact.decision.tier).toBe("none");
      expect(r.compact.executed).toBe("none");
      expect(r.compact.boundary).toBeNull();
      expect(r.compact.writeOutcome).toBeNull();
      expect(r.boundaryRowIndex).toBeNull();
    }
  });

  it("跨水位即触发 full：boundary 键=会话@throughSeq、首裁从 0 起、幂等首写", () => {
    const r3 = s.records[2]!;
    expect(r3.compact.preTokens).toBeGreaterThan(r3.compact.decision.watermarkTokens);
    expect(r3.compact.decision.tier).toBe("full");
    expect(r3.compact.executed).toBe("full");
    expect(r3.compact.writeOutcome).toBe("written");
    const b = r3.boundary!;
    expect(b.key).toBe(`${SESSION_ID}@4`);
    expect(b.trimmedFromSeq).toBe(0);
    expect(b.trimmedThroughSeq).toBe(4);
    expect(b.postTokens).toBeLessThan(b.preTokens);
  });

  it("micro 先行：白名单清理够用时 executed=micro 即止；即便规划 full 也不花 summarize 的钱", () => {
    const r7 = s.records[6]!;
    expect(r7.compact.decision.tier).toBe("micro");
    expect(r7.compact.executed).toBe("micro");
    expect(r7.compact.boundary).toBeNull();
    for (const turn of [8, 9]) {
      const r = s.records[turn - 1]!;
      expect(r.compact.decision.tier).toBe("full"); // mail 大输出灌入使体积超 fullRatio → 规划 full
      expect(r.compact.executed).toBe("micro"); // 旧白名单 read 输出被清 → 回落到水位下
      expect(r.compact.boundary).toBeNull();
      expect(r.boundaryRowIndex).toBeNull();
    }
    // 10 轮共 5 条 boundary（turn 3-6 连压 + turn 10 收口）；summarize 恰 5 次 = 每 boundary 一次。
    expect(s.boundaries.map((b) => b.key)).toEqual([
      `${SESSION_ID}@4`,
      `${SESSION_ID}@8`,
      `${SESSION_ID}@12`,
      `${SESSION_ID}@16`,
      `${SESSION_ID}@29`,
    ]);
    expect(s.summarizeCalls).toBe(5);
  });

  it("每次 full 落 trace：pre/post token 与缓存断点对齐 boundary 记录（D21 压缩落轨迹）", () => {
    for (const b of s.boundaries) {
      expect(b.cacheBreakpoint).toMatch(/^sha256:/);
      const t = s.traces.find((x) => x.boundaryKey === b.key);
      expect(t).toBeDefined();
      expect(t!.preTokens).toBe(b.preTokens);
      expect(t!.postTokens).toBe(b.postTokens);
      expect(t!.cacheBreakpoint).toBe(b.cacheBreakpoint);
    }
  });
});

describe("验收2：boundary+summary 三件套落盘进真 L0（重放可验）", () => {
  it("5 条 boundary 行落在预期 turn 下标；盘上行 parse 回来与内存记录全等", () => {
    expect(
      s.records.filter((r) => r.boundaryRowIndex !== null).map((r) => r.boundaryRowIndex),
    ).toEqual([9, 13, 17, 21, 34]);
    const rows = s.shards.readAfter(0).rows;
    for (const r of s.records) {
      if (r.boundaryRowIndex === null) continue;
      expect(parseBoundaryRow(rows[r.boundaryRowIndex]!)).toEqual(r.boundary);
    }
  });

  it("摘要块恒含三件套：标记 + trimmed_seq 范围行 + overflow 指针行 + 摘要正文", () => {
    for (const b of s.boundaries) {
      expect(b.summaryText.startsWith(BOUNDARY_SUMMARY_MARK)).toBe(true);
      const parsed = parseBoundarySummaryText(b.summaryText)!;
      expect(parsed.fromSeq).toBe(b.trimmedFromSeq);
      expect(parsed.throughSeq).toBe(b.trimmedThroughSeq);
      expect(parsed.count).toBe(b.trimmedCount);
      expect(parsed.pointer).toBe(b.rereadPointer);
      expect(b.summaryText).toContain("SUM#");
      expect(b.rereadPointer.startsWith(`overflow://${SESSION_ID}/`)).toBe(true);
    }
  });

  it("新实例从盘重建 boundary 序列（无内存真源）；投影幂等：按 key 只裁一次", () => {
    expect(boundaryRowsOnDisk(s).map((b) => b.key)).toEqual(s.boundaries.map((b) => b.key));
    const p = projectThroughBoundaries(s.shards.readAfter(0).rows);
    expect(p.applied.map((b) => b.key)).toEqual(s.boundaries.map((b) => b.key));
    expect(p.duplicateCount).toBe(0);
    expect(p.lastBoundary!.key).toBe(`${SESSION_ID}@29`);
  });

  it("边界接续不变量：后一条 boundary 的 fromSeq = 前一条 throughSeq+1", () => {
    for (let i = 1; i < s.boundaries.length; i += 1) {
      expect(s.boundaries[i]!.trimmedFromSeq).toBe(s.boundaries[i - 1]!.trimmedThroughSeq + 1);
    }
  });

  it("收口 live 视图 = 末条 boundary summary 接续 keepRecent 尾巴（seq 坐标连续）", () => {
    const last = s.boundaries[s.boundaries.length - 1]!;
    expect(s.finalLiveSeq).toBe(last.trimmedThroughSeq + 1);
    expect(textOf(s.finalLive[0]!)).toBe(last.summaryText);
    // keepRecent=4：summary + 最近 4 条尾巴。
    expect(s.finalLive.length).toBe(5);
  });
});

describe("验收3：压缩前后 assembly 段0-2 字节恒定、prefixHash 全程稳定（D6 缓存前缀）", () => {
  it("10 轮装配（含 5 次压缩）：稳定段逐字节全等、prefixHash 唯一、fullHash 逐轮互异", () => {
    const first = s.records[0]!.assembly;
    expect(new Set(s.records.map((r) => r.assembly.prefixHash))).toEqual(new Set([first.prefixHash]));

    for (const r of s.records) {
      for (const name of ["system", "memory", "workflow"] as const) {
        const a = r.assembly.segments.find((x) => x.name === name)!;
        const base = first.segments.find((x) => x.name === name)!;
        expect(Buffer.from(a.bytes).equals(Buffer.from(base.bytes))).toBe(true);
      }
      expect(r.assembly.segments.map((x) => x.stable)).toEqual([true, true, true, false]);
    }
    expect(new Set(s.records.map((r) => r.assembly.fullHash)).size).toBe(s.records.length);
  });

  it("装配零降级（memory/workflow 注入源全真可读，压缩不触碰稳定段）", () => {
    for (const r of s.records) {
      expect(r.assembly.degrades).toEqual([]);
    }
  });
});

describe("验收4：重读指针进下轮增量段；按指针回读得到被裁原文", () => {
  it("boundary 行的下一轮增量段含该 boundary 的标记与 overflow 指针行", () => {
    // turn 3 压缩把 boundary@4 落盘于行 9；turn 4 装配游标=9 → 行 9 进增量段。
    const inc4 = incrementText(s.records[3]!.assembly);
    const b = s.boundaries[0]!;
    expect(s.records[3]!.cursorBefore).toBe(9);
    expect(inc4).toContain(BOUNDARY_SUMMARY_MARK);
    expect(inc4).toContain(b.rereadPointer);
  });

  it("首条 boundary 按指针回读 = 被裁的原始消息（非 micro 占位版，逐条文本保真）", () => {
    const b = s.boundaries[0]!;
    const loaded = rereadOriginals(b);
    expect(loaded).not.toBeNull();
    // boundary@4 裁全局 seq 0-4 = turn1 三条 + turn2 前两条。
    const originals = [
      ...turnMessages(1, SCENARIO_STEPS[0]!),
      ...turnMessages(2, SCENARIO_STEPS[1]!),
    ].slice(0, 5);
    expect(loaded!.map(textOf)).toEqual(originals.map(textOf));
  });

  it("每条 boundary 指针都回读出与 trimmedCount 等量的原文档案", () => {
    for (const b of s.boundaries) {
      const loaded = rereadOriginals(b);
      expect(loaded).not.toBeNull();
      expect(loaded!.length).toBe(b.trimmedCount);
    }
  });

  it("游标推进即「不再上送」：被裁的 turn1 原文标记不在其后任一轮增量段", () => {
    // 装配读 L0 行流（原始事实永在盘上，D21 不自动塞回）；「压缩后不再进 prompt」
    // 由游标推进保证：turn2 起游标 ≥ 3，t1 行（0-2）永不落进任何后续增量段。
    for (const r of s.records.slice(1)) {
      expect(r.cursorBefore).toBeGreaterThan(2);
      expect(incrementText(r.assembly)).not.toContain("#t1#");
    }
  });
});

describe("验收5：dir 索引增量读 O(增量)（D20 读路径永不重放 L0 全量）", () => {
  it("装配每轮 openedShards ≤ 2（与历史总长无关）；增量行 = 游标推进量", () => {
    for (const r of s.records) {
      expect(r.assembly.openedShards).toBeLessThanOrEqual(2);
      expect(r.assembly.incrementRows).toBe(r.historyLenBefore - r.cursorBefore);
    }
  });

  it("游标推进零重放：每轮增量 = 本轮 flush 3 行 + 上一轮 boundary 行（0 或 1）", () => {
    let prevHadBoundary = false;
    for (const r of s.records) {
      expect(r.assembly.incrementRows).toBe(3 + (prevHadBoundary ? 1 : 0));
      prevHadBoundary = r.boundaryRowIndex !== null;
    }
  });

  it("终局目录索引：7 片全封 35 行；尾部读只开 1 片，readAfter(0) 才开满 7 片", () => {
    expect(s.shards.readIndex()).toEqual(
      Array.from({ length: 7 }, (_, i) => ({
        no: i + 1,
        file: `shard-00000${String(i + 1)}.jsonl`,
        firstTurn: i * TURNS_PER_SHARD,
        turns: TURNS_PER_SHARD,
        sealed: true,
      })),
    );
    expect(s.shards.turnCount()).toBe(35);

    const tail = s.shards.readAfter(30);
    expect(tail.rows.length).toBe(5);
    expect(tail.openedShards).toBe(1);

    const full = s.shards.readAfter(0);
    expect(full.rows.length).toBe(35);
    expect(full.openedShards).toBe(7);
  });
});

describe("崩溃重放幂等：重开实例 + 同输入重跑 = duplicate（不二次裁、不二次调模型）", () => {
  it("最后一条 boundary 的输入重放：账本不再写、Summarizer 零新调用、盘上 boundary 行数不变", async () => {
    const last = s.boundaries[s.boundaries.length - 1]!;
    const replay = await replayLastCompact(s);
    expect(replay.outcome).toBe("duplicate");
    expect(replay.boundaryKey).toBe(last.key);
    expect(replay.freshSummarizeCalls).toBe(0);
    expect(replay.viewFirstText).toBe(last.summaryText);
    expect(boundaryRowsOnDisk(s).length).toBe(5);
    expect(s.shards.turnCount()).toBe(35);
  });
});
