/**
 * rebaseAssemblyPrefix —— 只重建稳定前缀，保留上一份装配的增量段。
 *
 * 契约：
 *   - system/memory/workflow 用新 plan 重渲染（与 assemble 同一字节生产者）；
 *   - increment 字节/行数/分片数原样保留（不读历史、不合成空增量）；
 *   - prefixHash/fullHash 与同 plan 的 assemble 全等（分隔符布局同一份）；
 *   - degrades = 新 memory + 新 workflow + 上一份 increment 降级；
 *   - memorySourceCount 取新 plan。
 */

import { describe, expect, it } from "vitest";
import { assemble, rebaseAssemblyPrefix, resolveMemorySources, renderAssemblyPrefix } from "./assembler.js";
import type {
  Assembly,
  AssemblyPlan,
  AssemblyReader,
  HistoryIncrement,
  MemorySource,
} from "./types.js";

class StableReader implements AssemblyReader {
  constructor(
    private readonly files: Readonly<Record<string, string | null>>,
    private readonly rows: readonly string[] = [],
    private readonly historyThrows = false,
  ) {}

  readText(path: string): string | null {
    return this.files[path] ?? null;
  }

  readHistoryIncrement(from: number): HistoryIncrement {
    if (this.historyThrows) throw new Error("shard read failed");
    const lines = this.rows.slice(from);
    return { lines, openedShards: lines.length > 0 ? 1 : 0 };
  }

  historyLength(): number {
    return this.rows.length;
  }
}

function bytesOf(assembly: Assembly, name: string): Uint8Array {
  const segment = assembly.segments.find((s) => s.name === name);
  if (segment === undefined) throw new Error(`segment ${name} missing`);
  return segment.bytes;
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

function planFor(reader: AssemblyReader, systemPrompt: string, paths: readonly string[]): AssemblyPlan {
  const { sources } = resolveMemorySources(reader, paths);
  return {
    systemPrompt,
    memorySources: sources,
    workflows: [
      { name: "daily-review", prompt: `${systemPrompt}-workflow-A` },
      { name: "data-check", prompt: `${systemPrompt}-workflow-B` },
    ],
  };
}

function memorySource(path: string, content: string): MemorySource {
  return { source: path, content, degrade: null };
}

describe("rebaseAssemblyPrefix", () => {
  it("rebuilds stable segments from the new plan and preserves the increment", () => {
    const reader = new StableReader(
      {
        "AGENTS.md": "# 一级记忆\n旧内容。",
        "memory/self/SELF-INDEX.md": "# SELF-INDEX\n旧索引。",
      },
      ["row-1", "row-2", "row-3"],
    );
    const oldPlan = planFor(reader, "OLD-SYSTEM", ["AGENTS.md", "memory/self/SELF-INDEX.md"]);
    const previous = assemble(oldPlan, reader, {
      historyCursor: 0,
      currentMessage: "第一轮",
      reminders: ["提醒A"],
    });

    const newPlan: AssemblyPlan = {
      systemPrompt: "NEW-SYSTEM",
      memorySources: [memorySource("AGENTS.md", "# 一级记忆\n新内容。")],
      workflows: [{ name: "daily-review", prompt: "新工作流" }],
    };

    const rebased = rebaseAssemblyPrefix(previous, newPlan);
    const fresh = assemble(newPlan, reader, {
      historyCursor: 0,
      currentMessage: "第一轮",
      reminders: ["提醒A"],
    });

    expect(rebased.segments.map((s) => s.name)).toEqual(["system", "memory", "workflow", "increment"]);
    for (const name of ["system", "memory", "workflow"] as const) {
      expect(eqBytes(bytesOf(rebased, name), bytesOf(fresh, name))).toBe(true);
      expect(eqBytes(bytesOf(rebased, name), bytesOf(previous, name))).toBe(false);
    }
    expect(eqBytes(bytesOf(rebased, "increment"), bytesOf(previous, "increment"))).toBe(true);
    expect(bytesOf(rebased, "increment").length).toBeGreaterThan(0);

    expect(rebased.prefixHash).toBe(fresh.prefixHash);
    expect(rebased.fullHash).toBe(fresh.fullHash);
    expect(rebased.prefixHash).not.toBe(previous.prefixHash);
    expect(rebased.memorySourceCount).toBe(1);
    expect(rebased.incrementRows).toBe(previous.incrementRows);
    expect(rebased.openedShards).toBe(previous.openedShards);
    expect(rebased.degrades).toEqual([]);
  });

  it("composes degrades from new memory, new workflow and the previous increment only", () => {
    const reader = new StableReader({}, ["row-1"], true);
    const oldPlan: AssemblyPlan = {
      systemPrompt: "OLD",
      memorySources: [memorySource("memory/ok.md", "ok")],
      workflows: [],
    };
    const previous = assemble(oldPlan, reader, { historyCursor: 0 });
    expect(previous.degrades).toEqual([
      { segment: "increment", source: "history", reason: "unreadable", detail: "Error: shard read failed" },
    ]);

    const newPlan: AssemblyPlan = {
      systemPrompt: "NEW",
      memorySources: [
        {
          source: "memory/missing.md",
          content: "[assembly: source missing, degraded]",
          degrade: {
            segment: "memory",
            source: "memory/missing.md",
            reason: "missing",
            detail: null,
          },
        },
      ],
      workflows: [{ name: "data-check", prompt: null }],
    };

    const rebased = rebaseAssemblyPrefix(previous, newPlan);

    expect(rebased.degrades).toEqual([
      newPlan.memorySources[0]?.degrade,
      { segment: "workflow", source: "data-check", reason: "missing", detail: null },
      { segment: "increment", source: "history", reason: "unreadable", detail: "Error: shard read failed" },
    ]);
    expect(rebased.incrementRows).toBe(1);
    expect(rebased.openedShards).toBe(0);
    expect(eqBytes(bytesOf(rebased, "increment"), bytesOf(previous, "increment"))).toBe(true);
  });

  it("renders the same prefix bytes as renderAssemblyPrefix for the new plan", () => {
    const reader = new StableReader({ "AGENTS.md": "memory body" });
    const previous = assemble(
      { systemPrompt: "OLD", memorySources: [], workflows: [] },
      reader,
      { historyCursor: 0 },
    );
    const newPlan = planFor(reader, "NEW-SYSTEM", ["AGENTS.md"]);

    const rebased = rebaseAssemblyPrefix(previous, newPlan);

    expect(Buffer.from(bytesOf(rebased, "system")).toString("utf8")).toContain("NEW-SYSTEM");
    expect(
      renderAssemblyPrefix(newPlan),
    ).toBe(
      [
        Buffer.from(bytesOf(rebased, "system")).toString("utf8"),
        Buffer.from(bytesOf(rebased, "memory")).toString("utf8"),
        Buffer.from(bytesOf(rebased, "workflow")).toString("utf8"),
      ].join("\n"),
    );
  });
});
