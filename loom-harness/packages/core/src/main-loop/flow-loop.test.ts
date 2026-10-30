/**
 * L8 converge 分阶段开关 + flow 工具挂载面验收。
 *
 * 钉三件事：
 *   (1) converge:"disabled" 不暴露 converge 工具、不挂 converge 钩子，flow 照常终止；
 *   (2) converge:"disabled" 且无 flow 终态时自然停，不合成强制收束回执；
 *   (3) flow 缺席时缺省开关逐字节旧行为（converge 收束照常 converged）。
 */

import { describe, expect, it } from "vitest";
import { FORCE_MARK, MemorySessionStore } from "../index.js";
import { MemoryFlowStore } from "../flow/memory-store.js";
import type { Hook } from "../hook.js";
import { createFakeModel, type FakeAssistantResponse } from "../testing.js";
import { MainSessionLoop } from "./loop.js";
import type { MainSessionLoopOptions } from "./types.js";

function quietSink(): void {
  /* 吞掉默认 console 输出，保持测试输出干净 */
}

function flowCommitTurn(args: Record<string, unknown>): FakeAssistantResponse {
  return { content: [{ type: "toolCall", name: "flow_commit", arguments: args }] };
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

function captureToolNames(): { hook: Hook; names: () => readonly string[] } {
  let captured: readonly string[] = [];
  return {
    hook: {
      name: "capture-tool-names",
      onSessionStart(_input, ctx) {
        captured = [...ctx.config.toolNames];
      },
    },
    names: () => captured,
  };
}

function allText(messages: ReadonlyArray<{ content: unknown }>): string {
  return messages
    .flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.map((b) =>
            typeof b === "object" && b !== null && "text" in b
              ? String((b as { text: unknown }).text)
              : "",
          )
        : typeof m.content === "string"
          ? [m.content]
          : [],
    )
    .join("\n");
}

describe("L8 converge 分阶段开关 + flow 挂载面", () => {
  it("(1) converge disabled：不暴露 converge 工具/钩子，flow 终局照常", async () => {
    const flowStore = new MemoryFlowStore();
    const model = createFakeModel([
      flowCommitTurn({ subject_name: "L8 验收", state: "waiting_user" }),
    ]);
    const capture = captureToolNames();
    const loop = makeLoop(model, {
      flow: { store: flowStore },
      converge: "disabled",
      extraHooks: [capture.hook],
    });

    const result = await loop.start("flow 接管终止");

    expect(capture.names()).toEqual(["flow_commit", "flow_list", "flow_get"]);
    expect(capture.names()).not.toContain("converge");
    expect(result.type).toBe("flowEnded");
    if (result.type !== "flowEnded") throw new Error("unreachable");
    expect(result.flow.state).toBe("waiting_user");
    expect(String(result.summary.abortReason)).toMatch(/^flow:waiting_user:flow_/);
    expect(loop.outcomes(), "converge 钩子未挂，账本恒空").toEqual([]);
    model.teardown();
  });

  it("(2) converge disabled 且无 flow：自然停，不合成强制收束回执", async () => {
    const model = createFakeModel([textTurn("L8 自然停")]);
    const capture = captureToolNames();
    const loop = makeLoop(model, {
      converge: "disabled",
      extraHooks: [capture.hook],
    });

    const result = await loop.start("只聊一句");

    expect(capture.names()).toEqual([]);
    expect(result.type).toBe("naturalStop");
    if (result.type !== "naturalStop") throw new Error("unreachable");
    expect(result.summary.reason).toBe("done");
    expect(result.runs).toBe(1);
    expect(result.autoContinuationsUsed).toBe(0);
    expect(model.getCalls()).toHaveLength(1);
    expect(loop.outcomes()).toEqual([]);
    expect(loop.events().filter((e) => e.type === "loop-forced")).toEqual([]);
    const text = allText(loop.messages);
    expect(text).not.toContain(FORCE_MARK);
    expect(text).not.toContain("会话尚未收束");
    model.teardown();
  });

  it("(3) flow 缺席 + 缺省 converge：converge 收束逐字节旧行为", async () => {
    const store = new MemorySessionStore();
    const sessionId = "l8-default-converge";
    const model = createFakeModel([
      convergeTurn("带收束的答复", { status: "已完成" }),
    ]);
    const capture = captureToolNames();
    const loop = makeLoop(model, {
      store,
      sessionId,
      extraHooks: [capture.hook],
    });

    const result = await loop.start("汇报并收束");

    expect(capture.names()).toEqual(["converge"]);
    expect(result.type).toBe("converged");
    expect(model.getCalls()).toHaveLength(1);
    model.teardown();
  });
});
