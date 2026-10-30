/**
 * 主会话自动唤醒接线验收：autoWakeEnabled / now 经 MainSessionLoopOptions →
 * ConvergenceGate → ConvergenceTool，让主会话 converge 回执携带 nextWakeAt。
 * 覆盖六条路径：倒计时 / 清除 / 未携带 / 禁用后拒收再收束 / 自然停受理 / 强制收束。
 */

import { describe, expect, it } from "vitest";
import { nextWakeAtOf, type Message } from "../index.js";
import { createFakeModel, type FakeAssistantResponse } from "../testing.js";
import { MainSessionLoop } from "./loop.js";
import type { MainSessionLoopOptions } from "./types.js";
import type { Limits } from "../convergence/limits.js";

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);

function quietSink(): void {
  /* 吞掉默认 console 输出，保持测试输出干净 */
}

function textOf(m: { content: unknown }): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((b) =>
        typeof b === "object" && b !== null && "text" in b
          ? String((b as { text: unknown }).text)
          : "",
      )
      .join("");
  }
  return "";
}

function allText(messages: ReadonlyArray<Message>): string {
  return messages.map((m) => textOf(m)).join("\n");
}

function convergeTurn(
  text: string,
  args: Record<string, unknown>,
): FakeAssistantResponse {
  return {
    content: [
      { type: "text", text },
      { type: "toolCall", name: "converge", arguments: args },
    ],
  };
}

const textTurn = (t: string): FakeAssistantResponse => ({
  content: [{ type: "text", text: t }],
});

function makeLoop(
  model: ReturnType<typeof createFakeModel>,
  opts: Partial<Omit<MainSessionLoopOptions, "model">> = {},
): MainSessionLoop {
  return MainSessionLoop.create({
    model,
    logSink: quietSink,
    consoleSink: quietSink,
    ...opts,
  });
}

describe("主会话自动唤醒接线（autoWakeEnabled / now）", () => {
  it("(a) 注入 now + wake=10m：converged 回执 nextWakeAt = now + 600_000", async () => {
    const model = createFakeModel([
      convergeTurn("带唤醒的收束", { status: "已完成", wake: "10m" }),
    ]);
    const loop = makeLoop(model, { now: () => NOW });

    const result = await loop.start("巡检后十分钟再唤醒");

    expect(result.type).toBe("converged");
    if (result.type !== "converged") throw new Error("unreachable");
    expect(nextWakeAtOf(result.receipt)).toBe(NOW + 600_000);
    model.teardown();
  });

  it("(b) wake=none：converged 回执 nextWakeAt 显式为 null", async () => {
    const model = createFakeModel([
      convergeTurn("清除唤醒", { status: "已完成", wake: "none" }),
    ]);
    const loop = makeLoop(model, { now: () => NOW });

    const result = await loop.start("清除自动唤醒");

    expect(result.type).toBe("converged");
    if (result.type !== "converged") throw new Error("unreachable");
    expect(nextWakeAtOf(result.receipt)).toBeNull();
    model.teardown();
  });

  it("(c) 不带 wake：converged 回执 nextWakeAt 键缺席（undefined）", async () => {
    const model = createFakeModel([
      convergeTurn("不设置唤醒", { status: "已完成" }),
    ]);
    const loop = makeLoop(model, { now: () => NOW });

    const result = await loop.start("普通收束");

    expect(result.type).toBe("converged");
    if (result.type !== "converged") throw new Error("unreachable");
    expect(nextWakeAtOf(result.receipt)).toBeUndefined();
    expect("nextWakeAt" in result.receipt).toBe(false);
    model.teardown();
  });

  it("(d) autoWakeEnabled:false：带 wake 首轮拒收，第二轮无 wake 收束且回执无唤醒", async () => {
    const model = createFakeModel([
      convergeTurn("第一次带唤醒", { status: "已完成", wake: "10m" }),
      convergeTurn("第二次不带唤醒", { status: "已完成" }),
    ]);
    const loop = makeLoop(model, { autoWakeEnabled: false, now: () => NOW });

    const result = await loop.start("禁用自动唤醒后收束");

    expect(result.type).toBe("converged");
    if (result.type !== "converged") throw new Error("unreachable");
    expect(allText(loop.messages)).toContain("自动唤醒已禁用");
    expect(model.getCalls(), "首次拒收后对话继续到第二轮").toHaveLength(2);
    expect(nextWakeAtOf(result.receipt)).toBeUndefined();
    model.teardown();
  });

  it("(e) convergenceEnforced:false：自然停受理路同样携带 nextWakeAt", async () => {
    const model = createFakeModel([
      convergeTurn("自然停模式带唤醒", { status: "已完成", wake: "10m" }),
    ]);
    const loop = makeLoop(model, { convergenceEnforced: false, now: () => NOW });

    const result = await loop.start("自然停模式下收束");

    expect(result.type).toBe("converged");
    if (result.type !== "converged") throw new Error("unreachable");
    expect(nextWakeAtOf(result.receipt)).toBe(NOW + 600_000);
    expect(model.getCalls(), "受理即终结").toHaveLength(1);
    model.teardown();
  });

  it("(f) 强制收束路：forceEnded 的合成回执不携带 nextWakeAt", async () => {
    const limits: Limits = {
      nudgeLimit: 5,
      escalateSameError: 3,
      turnHardCap: 1,
      autoContinuations: 0,
    };
    const model = createFakeModel([textTurn("纯文本空转")]);
    const loop = makeLoop(model, { limits, now: () => NOW });

    const result = await loop.start("只说不收束");

    expect(result.type).toBe("forceEnded");
    if (result.type !== "forceEnded") throw new Error("unreachable");
    expect(result.cause).toBe("turn-hard-cap");
    expect(nextWakeAtOf(result.receipt)).toBeUndefined();
    model.teardown();
  });
});
