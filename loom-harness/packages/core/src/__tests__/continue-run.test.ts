/**
 * T5 — MainSessionLoop.continueRun()：失败回合重放必须从既有转录续跑（不追加用户消息、
 * 不重跑工具），并与 start() 共用同一活动互斥闸。
 */

import { describe, expect, it } from "vitest";
import {
  MemorySessionStore,
  Type,
  type HarnessTool,
  type Message,
} from "../index.js";
import { createFakeModel, type FakeAssistantResponse } from "../testing.js";
import { MainSessionLoop } from "../main-loop/loop.js";

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

function userTexts(messages: ReadonlyArray<Message>): string[] {
  return messages.filter((m) => m.role === "user").map(textOf);
}

const TRANSIENT_ERROR: FakeAssistantResponse = {
  content: [],
  stopReason: "error",
  errorMessage: "503 system cpu overloaded",
};

function makeLoop(
  model: ReturnType<typeof createFakeModel>,
  opts: { store?: MemorySessionStore; sessionId?: string } = {},
): MainSessionLoop {
  return MainSessionLoop.create({
    model,
    convergenceEnforced: false,
    llmErrorRetries: 0,
    consoleSink: quietSink,
    logSink: quietSink,
    ...(opts.store === undefined ? {} : { store: opts.store }),
    ...(opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }),
  });
}

describe("T5 MainSessionLoop.continueRun()", () => {
  it("failed start then continueRun: re-invokes the LLM with no second user message", async () => {
    const store = new MemorySessionStore();
    const sessionId = "t5_continue_single_user";
    const model = createFakeModel([
      TRANSIENT_ERROR,
      { content: [{ type: "text", text: "重放完成" }] },
    ]);
    const loop = makeLoop(model, { store, sessionId });

    const failed = await loop.start("原始问题");
    expect(failed.type).toBe("error");

    const replayed = await loop.continueRun();
    expect(replayed.type).toBe("naturalStop");

    const calls = model.getCalls();
    expect(calls).toHaveLength(2);
    expect(userTexts(calls[0]!.messages)).toEqual(["原始问题"]);
    expect(userTexts(calls[1]!.messages)).toEqual(["原始问题"]);
    expect(userTexts(loop.messages)).toEqual(["原始问题"]);

    const persisted = await store.getPathToLeaf(sessionId);
    const persistedUsers = persisted.filter(
      (stored) =>
        stored.entry.kind === "message" && stored.entry.message.role === "user",
    );
    expect(persistedUsers).toHaveLength(1);
    model.teardown();
  });

  it("concurrent continueRun/start throw while another run is active", async () => {
    const model = createFakeModel([
      { content: [{ type: "text", text: "慢" }], delayMs: 50 },
      { content: [{ type: "text", text: "续跑" }] },
      { content: [{ type: "text", text: "不应到达" }] },
    ]);
    const loop = makeLoop(model);

    const first = loop.start("第一问");
    await expect(loop.continueRun()).rejects.toThrow(/already in progress/);
    await first;

    const continuation = loop.continueRun();
    await expect(loop.start("第二问")).rejects.toThrow(/already in progress/);
    await continuation;

    expect(model.getCalls()).toHaveLength(2);
    expect(userTexts(loop.messages)).toEqual(["第一问"]);
    model.teardown();
  });

  it("reuses the existing transcript and never re-executes tools", async () => {
    let executions = 0;
    const tool: HarnessTool = {
      name: "count",
      description: "count executions",
      parameters: Type.Object({}),
      isReadOnly: true,
      isConcurrencySafe: () => true,
      async execute() {
        executions += 1;
        return { content: [{ type: "text", text: "counted" }] };
      },
    };
    const model = createFakeModel([
      { content: [{ type: "toolCall", name: "count", arguments: {} }] },
      TRANSIENT_ERROR,
      { content: [{ type: "text", text: "工具后重放完成" }] },
    ]);
    const loop = MainSessionLoop.create({
      model,
      tools: [tool],
      convergenceEnforced: false,
      llmErrorRetries: 0,
      consoleSink: quietSink,
      logSink: quietSink,
    });

    const failed = await loop.start("带工具的问题");
    expect(failed.type).toBe("error");
    expect(executions).toBe(1);

    const replayed = await loop.continueRun();
    expect(replayed.type).toBe("naturalStop");
    expect(executions).toBe(1);

    const calls = model.getCalls();
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(userTexts(call.messages)).toEqual(["带工具的问题"]);
    }
    expect(calls[0]!.messages.filter((m) => m.role === "toolResult")).toHaveLength(0);
    expect(calls[1]!.messages.filter((m) => m.role === "toolResult")).toHaveLength(1);
    expect(calls[2]!.messages.filter((m) => m.role === "toolResult")).toHaveLength(1);
    model.teardown();
  });
});
