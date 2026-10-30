/**
 * L4 flow 终局接线 —— 终态判别与落盘改标验收。
 *
 * 钉五件事：
 *   (1) waiting_user / waiting_event 提交 → flowEnded，run 当轮终止，落盘 terminal 保持 aborted；
 *   (2) closed 提交 → flowEnded，落盘 terminal 改标 done；
 *   (3) active 提交 → 不产生 flow 终局，run 继续到自然停；
 *   (4) 同轮 converge + flow 双终止：flow 钩子在前，stopReason 归 flow（不被 converge 抢占）；
 *   (5) flow 未接线 → converge/naturalStop 旧行为逐字节不变。
 */

import { describe, expect, it } from "vitest";
import { MemorySessionStore, type StoredEntry } from "../index.js";
import { MemoryFlowStore } from "../flow/memory-store.js";
import { createFakeModel, type FakeAssistantResponse } from "../testing.js";
import type { Hook } from "../hook.js";
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

function terminalEntriesOf(
  entries: ReadonlyArray<StoredEntry>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const node of entries) {
    if (node.entry.kind === "terminal") {
      out.push(node.entry.result as unknown as Record<string, unknown>);
    }
  }
  return out;
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

describe("L4 flow 终局（MainSessionLoop.flowEnded）", () => {
  it.each(["waiting_user", "waiting_event"] as const)(
    "(1) state=%s：flowEnded 当轮终止，落盘 terminal 保持 aborted",
    async (state) => {
      const flowStore = new MemoryFlowStore({ now: () => 1_700_000_000_000 });
      const sessionStore = new MemorySessionStore();
      const sessionId = `flow-terminal-${state}`;
      const model = createFakeModel([
        flowCommitTurn({
          subject_name: "等待验收",
          state,
          next_decision_at: "1h",
        }),
        textTurn("不该被消费的续轮"),
      ]);
      const loop = makeLoop(model, {
        flow: { store: flowStore },
        store: sessionStore,
        sessionId,
      });

      const result = await loop.start("提交等待状态");

      expect(result.type).toBe("flowEnded");
      if (result.type !== "flowEnded") throw new Error("unreachable");
      expect(result.flow.state).toBe(state);
      expect(result.flow.subject_name).toBe("等待验收");
      expect(result.flow.next_decision_at).toBeTypeOf("number");
      expect(result.summary.reason).toBe("aborted");
      expect(String(result.summary.abortReason)).toMatch(
        new RegExp(`^flow:${state}:flow_[0-9a-f]{12}$`),
      );
      expect(result.runs).toBe(1);
      expect(result.autoContinuationsUsed).toBe(0);
      expect(model.getCalls(), "flow terminal 当轮终止，无续轮").toHaveLength(1);

      const terminals = terminalEntriesOf(await sessionStore.getPathToLeaf(sessionId));
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.["reason"], "waiting 是等待而非完成").toBe("aborted");

      const subjects = await flowStore.list(loop.id);
      expect(subjects).toHaveLength(1);
      expect(subjects[0]?.state).toBe(state);
      model.teardown();
    },
  );

  it("(2) state=closed：flowEnded 且落盘 terminal 改标 done", async () => {
    const flowStore = new MemoryFlowStore();
    const sessionStore = new MemorySessionStore();
    const sessionId = "flow-terminal-closed";
    const model = createFakeModel([
      flowCommitTurn({ subject_name: "闭环验收", state: "closed" }),
    ]);
    const loop = makeLoop(model, {
      flow: { store: flowStore },
      store: sessionStore,
      sessionId,
    });

    const result = await loop.start("关闭主体");

    expect(result.type).toBe("flowEnded");
    if (result.type !== "flowEnded") throw new Error("unreachable");
    expect(result.flow.state).toBe("closed");
    expect(result.summary.reason).toBe("aborted");

    const terminals = terminalEntriesOf(await sessionStore.getPathToLeaf(sessionId));
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.["reason"]).toBe("done");
    expect(String(terminals[0]?.["abortReason"])).toMatch(
      /^flow:closed:flow_[0-9a-f]{12}$/,
    );
    expect((await flowStore.list(loop.id))[0]?.state).toBe("closed");
    model.teardown();
  });

  it("(3) state=active：不产生 flow 终局，run 继续到自然停", async () => {
    const flowStore = new MemoryFlowStore();
    const model = createFakeModel([
      flowCommitTurn({ subject_name: "活跃验收", state: "active" }),
      textTurn("继续推进后的自然收尾"),
    ]);
    const loop = makeLoop(model, {
      flow: { store: flowStore },
      converge: "disabled",
    });

    const result = await loop.start("先记活跃");

    expect(result.type).toBe("naturalStop");
    expect(model.getCalls(), "active 放行，run 继续到下一 turn").toHaveLength(2);
    expect((await flowStore.list(loop.id))[0]?.state).toBe("active");
    model.teardown();
  });

  it("(4) 同轮 converge + flow 双终止：stopReason 归 flow（钩子顺序）", async () => {
    const flowStore = new MemoryFlowStore();
    const sessionStore = new MemorySessionStore();
    const sessionId = "flow-terminal-dual";
    const model = createFakeModel([
      {
        content: [
          { type: "text", text: "双通道同轮收尾" },
          { type: "toolCall", name: "converge", arguments: { status: "已完成" } },
          {
            type: "toolCall",
            name: "flow_commit",
            arguments: { subject_name: "双终止", state: "closed" },
          },
        ],
      },
    ]);
    const capture = captureToolNames();
    const loop = makeLoop(model, {
      flow: { store: flowStore },
      store: sessionStore,
      sessionId,
      extraHooks: [capture.hook],
    });

    const result = await loop.start("两个终止器同轮");

    expect(capture.names()[0], "flow_commit 前置在工具数组首位").toBe("flow_commit");
    expect(capture.names()).toContain("converge");
    expect(result.type).toBe("flowEnded");
    if (result.type !== "flowEnded") throw new Error("unreachable");
    expect(result.flow.state).toBe("closed");
    expect(String(result.summary.abortReason), "converge 不得抢占 stopReason").toMatch(
      /^flow:closed:flow_[0-9a-f]{12}$/,
    );
    const terminals = terminalEntriesOf(await sessionStore.getPathToLeaf(sessionId));
    expect(terminals[0]?.["reason"]).toBe("done");
    model.teardown();
  });

  it("(5a) flow 未接线：converge 收束旧行为不变", async () => {
    const model = createFakeModel([
      convergeTurn("带收束的答复", { status: "已完成" }),
    ]);
    const loop = makeLoop(model);

    const result = await loop.start("汇报并收束");

    expect(result.type).toBe("converged");
    expect(model.getCalls()).toHaveLength(1);
    model.teardown();
  });

  it("(5b) flow 未接线：免强制自然停旧行为不变", async () => {
    const model = createFakeModel([textTurn("自然收尾")]);
    const loop = makeLoop(model, { convergenceEnforced: false });

    const result = await loop.start("随便聊聊");

    expect(result.type).toBe("naturalStop");
    if (result.type !== "naturalStop") throw new Error("unreachable");
    expect(result.summary.reason).toBe("done");
    expect(result.runs).toBe(1);
    expect(result.autoContinuationsUsed).toBe(0);
    model.teardown();
  });
});
