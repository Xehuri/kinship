/**
 * L6 flow 事件投影：tool-end 的 details.__flow → session.idle.flow；旧 convergence 读取器保留。
 */

import { describe, expect, it } from "vitest";
import type { ToolExecResult } from "@axeuh/loom-core";

import { newProjectionState, projectEvent } from "./index.js";
import type { FrameDraft } from "./index.js";

const SID = "ses_flow_project";
const SUMMARY = { turns: 1, continuations: 0, reason: "aborted", usage: {} } as never;

const FLOW_CALL = {
  type: "toolCall",
  id: "tc_flow",
  name: "flow_commit",
  arguments: {},
} as never;

function toolEnd(
  state: ReturnType<typeof newProjectionState>,
  details: unknown,
  call: unknown = FLOW_CALL,
): FrameDraft[] {
  const result: ToolExecResult = { content: [{ type: "text", text: "ok" }], details };
  return projectEvent(state, SID, {
    type: "tool-end",
    call: call as never,
    result,
    durationMs: 1,
  });
}

function idle(frames: readonly FrameDraft[]): FrameDraft {
  const frame = frames.find((d) => d.type === "session.idle");
  if (frame === undefined) throw new Error("no session.idle frame");
  return frame;
}

describe("flow 事件投影", () => {
  it("tool-end details.__flow 在 session.idle 带出 flow 控制值", () => {
    const state = newProjectionState();
    toolEnd(state, {
      __flow: {
        subject_id: "flow_0123456789ab",
        subject_name: "主线",
        state: "waiting_user",
        next_decision_at: 1_766_000_000_000,
        version: 2,
        created: false,
        turn_idx: 3,
      },
    });
    const frame = idle(projectEvent(state, SID, { type: "session-end", summary: SUMMARY }));

    expect(frame.properties.flow).toEqual({
      subject_id: "flow_0123456789ab",
      subject_name: "主线",
      state: "waiting_user",
      next_decision_at: 1_766_000_000_000,
    });
  });

  it("拒收结果 committed:false 不产生 flow 字段", () => {
    const state = newProjectionState();
    toolEnd(state, { __flow: { committed: false, error: "FlowConflictError" } });
    const frame = idle(projectEvent(state, SID, { type: "session-end", summary: SUMMARY }));
    expect(frame.properties.flow).toBeUndefined();
  });

  it("session-start 复位 flow；历史 __convergence 读取器仍工作", () => {
    const state = newProjectionState();
    toolEnd(
      state,
      { __convergence: { converged: true, receipt: { status: "已完成" } } },
      { type: "toolCall", id: "tc_conv", name: "converge", arguments: {} } as never,
    );
    toolEnd(state, {
      __flow: {
        subject_id: "flow_0123456789ab",
        subject_name: "主线",
        state: "active",
        next_decision_at: null,
      },
    });

    const before = idle(projectEvent(state, SID, { type: "session-end", summary: SUMMARY }));
    expect(before.properties.flow).toMatchObject({ state: "active" });
    expect(before.properties.convergence).toEqual({ status: "已完成", converged: true });

    projectEvent(state, SID, { type: "session-start", resumed: false } as never);
    const after = idle(projectEvent(state, SID, { type: "session-end", summary: SUMMARY }));
    expect(after.properties.flow).toBeUndefined();
  });
});
