/**
 * T18 装配器测试（docs/02 §T18 TDD：byte-prefix-hash stability first）。
 * 三条硬不变量：
 *  1. 同输入双跑 → 前缀（段0..2）字节全等、prefixHash 全等；
 *  2. 增量纬线变化 → prefixHash 不变、fullHash 变、只有段3字节变；
 *  3. fail-soft：memory 缺失/IO 坏/内容坏 → 占位降级 + 类型化 degrade，装配不崩。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assemble,
  resolveMemorySources,
  renderAssemblyPrefix,
  MISSING_PLACEHOLDER,
  UNREADABLE_PLACEHOLDER,
} from "./assembler.js";
import { canonicalRow, createFsAssemblyReader, type ShardSourceLike } from "./fs-reader.js";
import type { Assembly, AssemblyPlan, AssemblyReader } from "./types.js";

function bytesOf(a: Assembly, name: string): Uint8Array {
  const seg = a.segments.find((s) => s.name === name);
  if (seg === undefined) throw new Error(`segment ${name} missing`);
  return seg.bytes;
}

function eqBytes(x: Uint8Array, y: Uint8Array): boolean {
  return Buffer.from(x).equals(Buffer.from(y));
}

/** 可控历史源：SessionShards 的测试替身（readAfter 语义 + openedShards 上报）。 */
class FakeShards implements ShardSourceLike {
  readonly rows: Record<string, unknown>[] = [];
  readAfter(startTurn: number): { rows: readonly Record<string, unknown>[]; openedShards: number } {
    const rows = this.rows.slice(startTurn);
    return { rows, openedShards: rows.length > 0 ? 1 : 0 };
  }
  turnCount(): number {
    return this.rows.length;
  }
}

let root: string;
let shards: FakeShards;
let reader: AssemblyReader;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "assembly-t18-"));
  mkdirSync(join(root, "memory/self"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "# 一级记忆\n核心规则：文件是接口，不是数据库。\n");
  writeFileSync(join(root, "memory/self/SELF-INDEX.md"), "# SELF-INDEX\n索引正文\n");
  writeFileSync(join(root, "memory/bad-null.md"), "损坏\u0000内容");
  writeFileSync(join(root, "memory/bad-stamp.md"), "log 2026-10-08 14:30 entry\n");
  shards = new FakeShards();
  shards.rows.push({ role: "user", text: "第一条" });
  reader = createFsAssemblyReader({ workspaceRoot: root, shards });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function makePlan(paths: readonly string[]): AssemblyPlan {
  const { sources } = resolveMemorySources(reader, paths);
  return {
    systemPrompt: "你是 loom 主会话。",
    memorySources: sources,
    workflows: [
      { name: "daily-review", prompt: "复盘工作流模板 A" },
      { name: "data-check", prompt: "数据检查工作流模板 B" },
    ],
  };
}

describe("稳定前缀（D6 cache 布局）", () => {
  it("同输入双跑 → 前缀段字节全等、prefixHash 全等", () => {
    const plan = makePlan(["AGENTS.md", "memory/self/SELF-INDEX.md"]);
    const input = { historyCursor: 0, currentMessage: "开工" };
    const a1 = assemble(plan, reader, input);
    const a2 = assemble(plan, reader, input);

    expect(eqBytes(bytesOf(a1, "system"), bytesOf(a2, "system"))).toBe(true);
    expect(eqBytes(bytesOf(a1, "memory"), bytesOf(a2, "memory"))).toBe(true);
    expect(eqBytes(bytesOf(a1, "workflow"), bytesOf(a2, "workflow"))).toBe(true);
    expect(a1.prefixHash).toBe(a2.prefixHash);
    expect(a1.fullHash).toBe(a2.fullHash);
    expect(a1.degrades).toEqual([]);
  });

  it("清单序=注入序（W14：resolve 边界去重不重排，乱序声明的归一只在声明层做）", () => {
    const p1 = makePlan(["AGENTS.md", "memory/self/SELF-INDEX.md"]);
    const p2 = makePlan(["memory/self/SELF-INDEX.md", "AGENTS.md"]);
    const input = { historyCursor: 0 };
    const a1 = assemble(p1, reader, input);
    const a2 = assemble(p2, reader, input);
    // 装配核消费清单原序：两序前缀字节不同（若在此再排序=第二口径，把快变埋回中段）。
    expect(eqBytes(bytesOf(a1, "memory"), bytesOf(a2, "memory"))).toBe(false);
    expect(a1.prefixHash).not.toBe(a2.prefixHash);
    // 清单内重复路径：IO 边界去重保序、首次位保留，不 throw 不双份注入。
    const dup = makePlan(["AGENTS.md", "memory/self/SELF-INDEX.md", "AGENTS.md"]);
    const a3 = assemble(dup, reader, input);
    expect(a3.memorySourceCount).toBe(2);
    expect(eqBytes(bytesOf(a3, "memory"), bytesOf(a1, "memory"))).toBe(true);
  });

  it("只有增量段变化 → prefixHash 不变、fullHash 变、段0..2 字节全等", () => {
    const plan = makePlan(["AGENTS.md", "memory/self/SELF-INDEX.md"]);
    const a1 = assemble(plan, reader, { historyCursor: 0, currentMessage: "第一轮" });
    // 新历史行 + 新消息 = 增量纬线推进；游标推进到 1 ⇒ 段3 唯一变化。
    shards.rows.push({ role: "assistant", text: "第二条" });
    const a2 = assemble(plan, reader, { historyCursor: 1, currentMessage: "第二轮", nudges: ["收尾"] });

    for (const name of ["system", "memory", "workflow"] as const) {
      expect(eqBytes(bytesOf(a1, name), bytesOf(a2, name))).toBe(true);
    }
    expect(eqBytes(bytesOf(a1, "increment"), bytesOf(a2, "increment"))).toBe(false);
    expect(a2.prefixHash).toBe(a1.prefixHash);
    expect(a2.fullHash).not.toBe(a1.fullHash);
    expect(a2.incrementRows).toBe(1);
    expect(a2.openedShards).toBe(1);
    shards.rows.length = 1; // 还原全局 fixture
  });

  it("段 stable 标记 = 前三段 true、增量段 false；前缀字节是全量字节严格前缀", () => {
    const plan = makePlan(["AGENTS.md"]);
    const a = assemble(plan, reader, { historyCursor: 0, currentMessage: "x" });
    expect(a.segments.map((s) => s.stable)).toEqual([true, true, true, false]);
    const full = Buffer.concat(a.segments.map((s) => Buffer.from(s.bytes)));
    const prefix = Buffer.concat(a.segments.filter((s) => s.stable).map((s) => Buffer.from(s.bytes)));
    expect(full.subarray(0, prefix.length).equals(prefix)).toBe(true);
  });

  it("workflows 按声明序注入（不重排）", () => {
    const { sources } = resolveMemorySources(reader, ["AGENTS.md"]);
    const plan: AssemblyPlan = {
      systemPrompt: "s",
      memorySources: sources,
      workflows: [
        { name: "zeta", prompt: "Z" },
        { name: "alpha", prompt: "A" },
      ],
    };
    const text = new TextDecoder().decode(bytesOf(assemble(plan, reader, { historyCursor: 9 }), "workflow"));
    expect(text.indexOf("zeta")).toBeLessThan(text.indexOf("alpha"));
  });

  it("历史行序列化键序无关 → canonicalRow 字节稳定", () => {
    const r1 = canonicalRow({ b: 2, a: 1 });
    const r2 = canonicalRow({ a: 1, b: 2 });
    expect(r1).toBe(r2);
  });
});

// Unit B 请求面接线：主会话上送模型的 systemPrompt 由 renderAssemblyPrefix 产出，
// 与装配前缀**字节同源**——发给模型的字节就是 trace/prefixHash 声明的那份前缀。
describe("请求面接线 renderAssemblyPrefix（发模型字节 = 装配前缀声明源）", () => {
  it("sha256(渲染文本) === assemble().prefixHash（同生产者，不养第二渲染路径）", () => {
    const plan = makePlan(["AGENTS.md", "memory/self/SELF-INDEX.md"]);
    const rendered = renderAssemblyPrefix(plan);
    const hash = `sha256:${createHash("sha256").update(Buffer.from(rendered, "utf8")).digest("hex")}`;
    expect(hash).toBe(assemble(plan, reader, { historyCursor: 0, currentMessage: "x" }).prefixHash);
  });

  it("渲染 = 段0..2 顺次拼接（身份+memory+workflow 模板），增量段3 不入", () => {
    const plan = makePlan(["AGENTS.md"]);
    const rendered = renderAssemblyPrefix(plan);
    expect(rendered.startsWith("## system\n你是 loom 主会话。")).toBe(true);
    expect(rendered).toContain("### memory[0] AGENTS.md");
    expect(rendered).toContain("## workflow daily-review");
    const a = assemble(plan, reader, { historyCursor: 0, currentMessage: "开工" });
    expect(rendered).toContain(new TextDecoder().decode(bytesOf(a, "system")));
    expect(rendered).not.toContain("user: 开工"); // 易变段绝不进请求前缀
  });

  it("同 plan 双跑字节全等（纯函数 ⇒ 跨轮 systemPrompt 稳定）", () => {
    const plan = makePlan(["AGENTS.md", "memory/self/SELF-INDEX.md"]);
    expect(renderAssemblyPrefix(plan)).toBe(renderAssemblyPrefix(plan));
  });
});

describe("fail-soft（D33：注入源坏 → 占位降级，不崩）", () => {
  it("memory 文件缺失 → 占位注入 + degrade(missing)", () => {
    const { sources } = resolveMemorySources(reader, ["memory/ghost.md"]);
    const plan: AssemblyPlan = { systemPrompt: "s", memorySources: sources, workflows: [] };
    const a = assemble(plan, reader, { historyCursor: 0 });
    expect(a.degrades).toHaveLength(1);
    expect(a.degrades[0]).toMatchObject({ segment: "memory", source: "memory/ghost.md", reason: "missing" });
    expect(new TextDecoder().decode(bytesOf(a, "memory"))).toContain(MISSING_PLACEHOLDER);
  });

  it("memory 读 IO 异常 → degrade(unreadable) + 占位", () => {
    const boom: AssemblyReader = {
      ...reader,
      readText(): string | null {
        throw new Error("EIO disk died");
      },
    };
    const { sources } = resolveMemorySources(boom, ["AGENTS.md"]);
    const plan: AssemblyPlan = { systemPrompt: "s", memorySources: sources, workflows: [] };
    const a = assemble(plan, boom, { historyCursor: 0 });
    expect(a.degrades[0]).toMatchObject({ reason: "unreadable", segment: "memory", source: "AGENTS.md" });
    expect(a.degrades[0]?.detail).toContain("EIO");
    expect(new TextDecoder().decode(bytesOf(a, "memory"))).toContain(UNREADABLE_PLACEHOLDER);
  });

  it("memory 内容损坏（NUL/时分戳）→ degrade(invalid)，装配继续", () => {
    const { sources } = resolveMemorySources(reader, ["memory/bad-null.md", "memory/bad-stamp.md"]);
    const plan: AssemblyPlan = { systemPrompt: "s", memorySources: sources, workflows: [] };
    const a = assemble(plan, reader, { historyCursor: 0 });
    expect(a.degrades.map((d) => d.reason)).toEqual(["invalid", "invalid"]);
    expect(a.degrades.every((d) => d.segment === "memory")).toBe(true);
  });

  it("workflow 模板缺失 → 占位 + degrade(missing)，其余段不受染", () => {
    const { sources } = resolveMemorySources(reader, ["AGENTS.md"]);
    const plan: AssemblyPlan = {
      systemPrompt: "s",
      memorySources: sources,
      workflows: [{ name: "gone", prompt: null }],
    };
    const a = assemble(plan, reader, { historyCursor: 0 });
    expect(a.degrades).toEqual([{ segment: "workflow", source: "gone", reason: "missing", detail: null }]);
    const wfText = new TextDecoder().decode(bytesOf(a, "workflow"));
    expect(wfText).toContain("gone");
    expect(wfText).toContain(MISSING_PLACEHOLDER);
  });

  it("历史增量读抛错 → degrade(increment/unreadable)，装配不崩", () => {
    const plan = makePlan(["AGENTS.md"]);
    const broken: AssemblyReader = {
      readText: (p) => reader.readText(p),
      historyLength: () => reader.historyLength(),
      readHistoryIncrement(): never {
        throw new Error("shard index corrupt");
      },
    };
    const a = assemble(plan, broken, { historyCursor: 0, currentMessage: "hi" });
    expect(a.degrades.some((d) => d.segment === "increment" && d.reason === "unreadable")).toBe(true);
    const incText = new TextDecoder().decode(bytesOf(a, "increment"));
    expect(incText).toContain(UNREADABLE_PLACEHOLDER);
  });

  it("reader 为 null（无会话历史）→ 空增量段、零 degrade", () => {
    const plan = makePlan(["AGENTS.md"]);
    const a = assemble(plan, null, { historyCursor: 0 });
    expect(a.degrades).toEqual([]);
    expect(a.incrementRows).toBe(0);
    expect(a.openedShards).toBe(0);
    expect(bytesOf(a, "increment").length).toBe(0);
  });
});
