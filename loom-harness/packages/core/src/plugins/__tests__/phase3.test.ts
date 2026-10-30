/**
 * Phase 3 plugin tests —— cost-tracker mode + token-budget 跟
 * cost-tracker 的依赖通过 `prefers` 静默（无 warn）。forkSession 用例未移植（controller 已丢弃）。
 */

import { describe, it, expect } from "vitest";
import {
  AgentSession,
  Type,
  createUserMessage,
  type HarnessTool,
  type LlmOptions,
  type Message,
} from "../../index.js";
import { createFakeModel } from "../../testing.js";
import { costTracker, getCostStats } from "../cost-tracker.js";

const echoTool: HarnessTool = {
  name: "echo",
  description: "",
  parameters: Type.Object({}),
  async execute() {
    return { content: [{ type: "text", text: "x" }] };
  },
};

/* ──────────────── cost-tracker mode option ──────────────── */

describe("Phase 3: cost-tracker mode", () => {
  it("per-run vs lifetime: 第二次 run 后累计 vs 重置", async () => {
    const captured: Array<number> = [];
    const probeHook = {
      name: "probe",
      onTurnEnd(_input: unknown, ctx: import("../../index.js").HookContext) {
        const stats = getCostStats(ctx);
        if (stats) captured.push(stats.inputTokens);
      },
    };
    const fake = createFakeModel([
      {
        content: [{ type: "text", text: "first" }],
        usage: { input: 100, output: 50 },
      },
      {
        content: [{ type: "text", text: "second" }],
        usage: { input: 200, output: 80 },
      },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [costTracker({ mode: "lifetime" }), probeHook],
    });
    await session.run("first");
    await session.run("second");
    // lifetime 模式：第二个 turn 看到累计的 input tokens = 100 + 200 = 300
    expect(captured[0]).toBe(100);
    expect(captured[1]).toBe(300);
    fake.teardown();
  });

  it("per-run mode: 第二次 run 重置到 0", async () => {
    const captured: Array<number> = [];
    const probeHook = {
      name: "probe",
      onTurnEnd(_input: unknown, ctx: import("../../index.js").HookContext) {
        const stats = getCostStats(ctx);
        if (stats) captured.push(stats.inputTokens);
      },
    };
    const fake = createFakeModel([
      {
        content: [{ type: "text", text: "first" }],
        usage: { input: 100, output: 50 },
      },
      {
        content: [{ type: "text", text: "second" }],
        usage: { input: 200, output: 80 },
      },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [costTracker({ mode: "per-run" }), probeHook],
    });
    await session.run("first");
    await session.run("second");
    // per-run 模式：第二次 run 重置，只看到 200
    expect(captured[0]).toBe(100);
    expect(captured[1]).toBe(200);
    fake.teardown();
  });

  it("default mode === 'per-run'（向后兼容）", async () => {
    const captured: Array<number> = [];
    const probeHook = {
      name: "probe",
      onTurnEnd(_input: unknown, ctx: import("../../index.js").HookContext) {
        const stats = getCostStats(ctx);
        if (stats) captured.push(stats.inputTokens);
      },
    };
    const fake = createFakeModel([
      {
        content: [{ type: "text", text: "first" }],
        usage: { input: 100, output: 50 },
      },
      {
        content: [{ type: "text", text: "second" }],
        usage: { input: 200, output: 80 },
      },
    ]);
    const session = new AgentSession({
      model: fake,
      tools: [],
      hooks: [costTracker(), probeHook],
    });
    await session.run("first");
    await session.run("second");
    expect(captured[1]).toBe(200); // 默认 per-run
    fake.teardown();
  });
});

/* ──────────────── token-budget prefers cost-tracker (no warn) ──────────────── */

describe("Phase 3: prefers 不发 warning", () => {
  it("token-budget 用 prefers:['cost-tracker']，没注册时不 warn", async () => {
    const warnings: string[] = [];
    const fake = createFakeModel([
      { content: [{ type: "text", text: "done" }] },
    ]);
    // 用 dynamic import 避免静态依赖问题
    const { tokenBudget } = await import("../token-budget.js");
    new AgentSession({
      model: fake,
      tools: [],
      hooks: [tokenBudget({ budget: 10_000 })],
      consoleSink: (msg) => warnings.push(msg),
    });
    // 不应有 hook-deps:missing-required warning
    expect(
      warnings.filter((w) => w.includes("missing-required")).length,
    ).toBe(0);
    fake.teardown();
  });
});
