/**
 * T19 × T18 交界测试：压缩前后 assembly prefixHash 仅增量段变化（任务硬验收项）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { Message } from "./test-helpers.js";
import { MemorySink, chars4Counter, tr, user } from "./test-helpers.js";
import { createTestContext } from "../testing.js";
import { DEFAULT_COMPACTION_LIMITS, type CompactionLimits } from "./limits.js";
import { BoundaryLedger, MemoryArchive, serializeBoundaryRow } from "./boundary.js";
import { CompactionRoutine, jsonlOverflowArchive } from "./routine.js";
import { assemble, resolveMemorySources } from "../assembly/assembler.js";
import { createFsAssemblyReader } from "../assembly/fs-reader.js";

function testLimits(): CompactionLimits {
  return {
    ...DEFAULT_COMPACTION_LIMITS,
    contextWindow: 1000,
    watermarkRatio: 0.85,
    fullRatio: 0.95,
    microTargetRatio: 0.5,
    keepRecent: 4,
    microKeepRecent: 2,
  };
}

describe("压缩 × 装配（T18 断言：压缩前后 prefixHash 不变、只有增量段变）", () => {
  it("boundary 替换历史前缀后：稳定段字节全等、prefixHash 全等、fullHash 变", async () => {
    const root = mkdtempSync(join(tmpdir(), "compaction-t19-"));
    try {
      mkdirSync(join(root, "ai"), { recursive: true });
      writeFileSync(join(root, "AGENTS.md"), "# 记忆\n稳定正文。\n");
      writeFileSync(join(root, "ai/injection.yaml"), "layers: [memory]\n");
      const { sources } = resolveMemorySources(
        createFsAssemblyReader({ workspaceRoot: root, shards: null }),
        ["AGENTS.md"],
      );
      const plan = {
        systemPrompt: "你是 loom 主会话。",
        memorySources: sources,
        workflows: [{ name: "daily", prompt: "复盘模板" }],
      };

      const rawMsgs: Message[] = Array.from({ length: 12 }, (_, i) =>
        i % 2 === 0 ? user(`u${String(i)}_` + "c".repeat(60)) : tr("mail_send", `r${String(i)}_` + "x".repeat(2400), `c${String(i)}`),
      );
      const before = new MemorySink();
      for (const m of rawMsgs) before.appendTurn({ t: "message", message: m });
      const a1 = assemble(plan, createFsAssemblyReader({ workspaceRoot: root, shards: before }), { historyCursor: 0 });

      const routine = new CompactionRoutine({
        limits: testLimits(),
        ledger: new BoundaryLedger(new MemorySink()),
        archive: jsonlOverflowArchive(new MemoryArchive()),
        tokenCounter: chars4Counter,
        compactableTools: ["read"],
        summarize: (early) => `SUMMARY(${String(early.length)})`,
      });
      const { ctx } = createTestContext();
      const r = await routine.compact({ sessionId: "s5", messages: rawMsgs, ctx });
      expect(r.executed).toBe("full");

      const after = new MemorySink();
      after.appendTurn(serializeBoundaryRow(r.boundary!));
      for (const m of r.view.slice(1)) after.appendTurn({ t: "message", message: m });
      const a2 = assemble(plan, createFsAssemblyReader({ workspaceRoot: root, shards: after }), { historyCursor: 0 });

      for (const name of ["system", "memory", "workflow"] as const) {
        const seg1 = a1.segments.find((s) => s.name === name)!;
        const seg2 = a2.segments.find((s) => s.name === name)!;
        expect(Buffer.from(seg1.bytes).equals(Buffer.from(seg2.bytes))).toBe(true);
      }
      expect(a2.prefixHash).toBe(a1.prefixHash);
      expect(a2.fullHash).not.toBe(a1.fullHash);
      expect(a2.incrementRows).toBeLessThan(a1.incrementRows);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
