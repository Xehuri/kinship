/**
 * FlowGate 验收：槽双匹配（session + turn）、terminal 终止、active 放行、
 * 无提交 unset（no_commit / run_end_no_commit）、store 失败 fail-open、runOutcome 复位。
 * 直接调用 hook（不经过 kernel），以便精确控制 turn 与 store 故障。
 */

import { describe, expect, it } from "vitest";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import { createTestContext } from "../testing.js";
import type { HookContext, HookResult } from "../hook.js";
import type { ToolExecResult } from "../types.js";
import {
  FLOW_COMMIT_SLOT,
  FlowCommitTool,
  FlowGate,
  MemoryFlowStore,
  type FlowCommitInput,
  type FlowCommitOptions,
  type FlowCommitResult,
  type FlowDefaultOptions,
  type FlowStore,
  type FlowSubject,
  type FlowUnsetInput,
  type FlowUnsetRecord,
} from "./index.js";

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const SIGNAL = new AbortController().signal;

interface UnsetCapture {
  readonly sessionId: string;
  readonly input: FlowUnsetInput;
}

/** 委托真实 MemoryFlowStore，同时捕获 appendUnset 并可注入失败。 */
class RecordingStore implements FlowStore {
  readonly unsets: UnsetCapture[] = [];
  failUnset = false;

  constructor(private readonly inner: FlowStore) {}

  list(sessionId: string): Promise<readonly FlowSubject[]> {
    return this.inner.list(sessionId);
  }

  get(subjectId: string): Promise<FlowSubject | null> {
    return this.inner.get(subjectId);
  }

  findByName(
    sessionId: string,
    subjectName: string,
  ): Promise<FlowSubject | null> {
    return this.inner.findByName(sessionId, subjectName);
  }

  ensureDefault(
    sessionId: string,
    options?: FlowDefaultOptions,
  ): Promise<FlowSubject | null> {
    return this.inner.ensureDefault(sessionId, options);
  }

  commit(
    sessionId: string,
    input: FlowCommitInput,
    options: FlowCommitOptions,
  ): Promise<FlowCommitResult> {
    return this.inner.commit(sessionId, input, options);
  }

  async appendUnset(
    sessionId: string,
    input: FlowUnsetInput,
  ): Promise<FlowUnsetRecord> {
    this.unsets.push({ sessionId, input });
    if (this.failUnset) throw new Error("flow store down");
    return this.inner.appendUnset(sessionId, input);
  }

  listSessionIds(): Promise<readonly string[]> {
    return this.inner.listSessionIds();
  }

  earliestPending(
    sessionId: string,
    now?: number,
  ): Promise<FlowSubject | null> {
    return this.inner.earliestPending(sessionId, now);
  }
}

const USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(stopReason: StopReason = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: USAGE,
    stopReason,
    timestamp: NOW,
  };
}

function toolOk(): ToolExecResult {
  return { content: [{ type: "text", text: "ok" }] };
}

interface TurnOptions {
  readonly turnIdx?: number;
  readonly stopReason?: StopReason;
  readonly toolResults?: readonly ToolExecResult[];
}

interface GateHarness {
  readonly gate: FlowGate;
  readonly store: RecordingStore;
  readonly ctx: HookContext;
  readonly setTurnIdx: (idx: number) => void;
  readonly commit: (
    args: Record<string, unknown>,
  ) => Promise<ToolExecResult>;
  readonly start: () => Promise<HookResult | void>;
  readonly finish: (opts?: TurnOptions) => Promise<HookResult | void>;
}

function harness(
  opts: { sessionId?: string; turnIdx?: number } = {},
): GateHarness {
  let nextId = 0;
  const inner = new MemoryFlowStore({
    now: () => NOW,
    idFactory: () => `flow_${(nextId++).toString(16).padStart(12, "0")}`,
  });
  const store = new RecordingStore(inner);
  const handle = createTestContext({
    sessionId: opts.sessionId ?? "s1",
    turnIdx: opts.turnIdx ?? 0,
  });
  const gate = new FlowGate({ store });
  const tool = FlowCommitTool({ store });
  const [hook] = gate.buildHooks();
  if (
    hook === undefined ||
    hook.onTurnEnd === undefined ||
    hook.onSessionStart === undefined
  ) {
    throw new Error("flow gate hook missing required callbacks");
  }
  const onTurnEnd = hook.onTurnEnd.bind(hook);
  const onSessionStart = hook.onSessionStart.bind(hook);

  return {
    gate,
    store,
    ctx: handle.ctx,
    setTurnIdx: handle.setTurnIdx,
    commit: (args) => tool.execute(args, handle.ctx, SIGNAL),
    start: async () => onSessionStart({ source: "run" }, handle.ctx),
    finish: async (turnOpts: TurnOptions = {}) => {
      const input = {
        turnIdx: turnOpts.turnIdx ?? handle.ctx.turnIdx,
        assistantMessage: assistant(turnOpts.stopReason),
        toolResults: [...(turnOpts.toolResults ?? [])],
      };
      return onTurnEnd(input, handle.ctx);
    },
  };
}

describe("FlowGate 终止判别", () => {
  it("active 提交不终止、不记 unset，runOutcome 为 null", async () => {
    const h = harness();
    const committed = await h.commit({ subject_name: "甲", state: "active" });
    expect(committed.isError).toBeUndefined();

    const result = await h.finish({
      stopReason: "toolUse",
      toolResults: [toolOk()],
    });

    expect(result).toBeUndefined();
    expect(h.store.unsets).toHaveLength(0);
    expect(h.gate.runOutcome()).toBeNull();
  });

  it("waiting_user / waiting_event / closed 均以 flow:<state>:<subject_id> 终止", async () => {
    for (const state of ["waiting_user", "waiting_event", "closed"] as const) {
      const h = harness();
      const committed = await h.commit({
        subject_name: `S-${state}`,
        state,
      });
      expect(committed.isError).toBeUndefined();
      const subjectId =
        h.ctx.state.get(FLOW_COMMIT_SLOT)?.subject_id ?? "missing";

      const result = await h.finish({
        stopReason: "toolUse",
        toolResults: [toolOk()],
      });

      expect(result).toEqual({
        continue: false,
        stopReason: `flow:${state}:${subjectId}`,
      });
      expect(h.gate.runOutcome()).toEqual({
        subject_id: subjectId,
        subject_name: `S-${state}`,
        state,
        next_decision_at: null,
      });
      expect(h.store.unsets).toHaveLength(0);
    }
  });

  it("上一 turn 的过期槽不终止本 turn，并记一条 no_commit", async () => {
    const h = harness({ turnIdx: 0 });
    await h.commit({ subject_name: "甲", state: "waiting_user" });
    h.setTurnIdx(1);

    const result = await h.finish({
      stopReason: "toolUse",
      toolResults: [toolOk()],
    });

    expect(result).toBeUndefined();
    expect(h.gate.runOutcome()).toBeNull();
    expect(h.store.unsets).toEqual([
      {
        sessionId: "s1",
        input: {
          turn_idx: 1,
          reason: "no_commit",
          had_tool_results: true,
        },
      },
    ]);
  });

  it("别的 session 的槽不终止本 session，并记一条 unset", async () => {
    const h = harness({ sessionId: "s1", turnIdx: 0 });
    h.ctx.state.set(FLOW_COMMIT_SLOT, {
      session_id: "s2",
      subject_id: "flow_000000000001",
      subject_name: "别处",
      state: "waiting_user",
      next_decision_at: null,
      version: 1,
      turn_idx: 0,
    });

    const result = await h.finish({
      turnIdx: 0,
      stopReason: "toolUse",
      toolResults: [toolOk()],
    });

    expect(result).toBeUndefined();
    expect(h.gate.runOutcome()).toBeNull();
    expect(h.store.unsets).toHaveLength(1);
    expect(h.store.unsets[0]?.sessionId).toBe("s1");
    expect(h.store.unsets[0]?.input.turn_idx).toBe(0);
  });
});

describe("FlowGate unset 审计", () => {
  it("同一 turn 无提交只记一条 no_commit（重复派发不重复落账）", async () => {
    const h = harness();
    await h.finish({ stopReason: "toolUse", toolResults: [toolOk()] });
    await h.finish({ stopReason: "toolUse", toolResults: [toolOk()] });

    expect(h.store.unsets).toEqual([
      {
        sessionId: "s1",
        input: {
          turn_idx: 0,
          reason: "no_commit",
          had_tool_results: true,
        },
      },
    ]);
  });

  it("无工具结果且 assistant 终局的回合记 run_end_no_commit", async () => {
    const h = harness();
    await h.finish({ stopReason: "stop" });

    expect(h.store.unsets).toEqual([
      {
        sessionId: "s1",
        input: {
          turn_idx: 0,
          reason: "run_end_no_commit",
          had_tool_results: false,
        },
      },
    ]);
  });

  it("active 提交的 turn 不记，下一 turn 无提交照常记", async () => {
    const h = harness();
    await h.commit({ subject_name: "甲", state: "active" });
    await h.finish({ stopReason: "toolUse", toolResults: [toolOk()] });
    expect(h.store.unsets).toHaveLength(0);

    h.setTurnIdx(1);
    await h.finish({ stopReason: "stop" });
    expect(h.store.unsets).toEqual([
      {
        sessionId: "s1",
        input: {
          turn_idx: 1,
          reason: "run_end_no_commit",
          had_tool_results: false,
        },
      },
    ]);
  });

  it("store 失败 fail-open：不抛错、不终止，run 继续", async () => {
    const h = harness();
    h.store.failUnset = true;

    const result = await h.finish({
      stopReason: "toolUse",
      toolResults: [toolOk()],
    });

    expect(result).toBeUndefined();
    expect(h.gate.runOutcome()).toBeNull();
    expect(h.store.unsets).toHaveLength(1);
  });
});

describe("FlowGate run 生命周期", () => {
  it("session start 清槽与 runOutcome，上一 run 的终态不会泄漏到下一 run", async () => {
    const h = harness();
    await h.commit({ subject_name: "甲", state: "waiting_user" });
    const terminal = await h.finish({
      stopReason: "toolUse",
      toolResults: [toolOk()],
    });
    expect(terminal).toEqual({
      continue: false,
      stopReason: `flow:waiting_user:${h.gate.runOutcome()?.subject_id ?? ""}`,
    });
    expect(h.gate.runOutcome()).not.toBeNull();
    expect(h.ctx.state.get(FLOW_COMMIT_SLOT)).not.toBeNull();

    await h.start();

    expect(h.gate.runOutcome()).toBeNull();
    expect(h.ctx.state.get(FLOW_COMMIT_SLOT)).toBeNull();
  });
});
