/**
 * W37 task_cancel 单测 —— 模型面后台任务取消工具（委托纪律）。
 * Given: 假账本口 TaskCancelSource（get/cancel 两方法，镜像 kernel.getSub/cancelSub 语义：
 *        未知=false、running 才命中并记原因、终态=false 零改动）
 * When:  在飞取消 / 未知 id / 终态 id / 空参 / 取消竞态（cancel 时刚盖棺）
 * Then:  accepted → 文本含 cancel_requested 受理 + GET /tasks 指引，cancel 恰好一次；
 *        未知 → not_found 诚实文案（不 throw、绝不触 cancel——单缝不双消）；
 *        终态 → 诚实终态行（零改动：cancel 不被调用）；
 *        竞态 → 复查账本后按实况整形（terminal=终态文案 / 消失=vanilla 诚实）。
 * 委托纪律实锤：本文件断言的是「source 被怎么调」，工具内绝不改账本形状（无第二实现）。
 */

import { describe, expect, it } from "vitest";
import type { SubTaskRecord } from "../kernel/types.js";
import type { RunState } from "../run-engine/types.js";
import { createTaskCancelTool, type TaskCancelSource } from "./task-cancel.js";

/** 造一条账本记录（只填工具消费面；其余键占位不影响语义）。 */
function rec(taskId: string, state: RunState, cancelRequested: string | null = null): SubTaskRecord {
  return {
    kind: "sub",
    taskId,
    agentType: "general",
    parentSessionId: "ses_parent0000000000",
    task: "t",
    depth: 1,
    row: {
      run_id: taskId,
      workflow: "subagent.general",
      attempt: 1,
      trigger: "manual",
      parent_run: null,
      session_id: "ses_child00000000000",
    },
    state,
    dispatchedAt: 1,
    terminalAt: state === "running" ? null : 2,
    terminal: null,
    error: null,
    crashed: false,
    cancelRequested,
  } as unknown as SubTaskRecord;
}

/**
 * 假账本口：语义镜像 SpawnKernel.cancelSub（kernel.ts:409-419）——
 * 仅 running 命中（记原因、返 true）；未知/终态 = false 零改动。
 */
function fakeSource(records: Map<string, SubTaskRecord>) {
  const cancelCalls: Array<{ taskId: string; reason: string | undefined }> = [];
  const source: TaskCancelSource = {
    get: (taskId) => records.get(taskId),
    cancel: (taskId, reason) => {
      cancelCalls.push({ taskId, reason });
      const r = records.get(taskId);
      if (r === undefined || r.state !== "running") return false;
      records.set(taskId, { ...r, cancelRequested: reason ?? "cancel requested" });
      return true;
    },
  };
  return { source, cancelCalls };
}

const ctxStub = { sessionId: "ses_main000000000000" } as never;

function textOf(content: Array<{ type: string; text?: string }>): string {
  return content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
}

describe("task_cancel：在飞取消", () => {
  it("running 任务 → 受理文案（cancel_requested + GET /tasks 指引），cancel 恰好一次且带 reason", async () => {
    const id = "run_aaa0000000000001";
    const { source, cancelCalls } = fakeSource(new Map([[id, rec(id, "running")]]));
    const tool = createTaskCancelTool({ source });
    const out = await tool.execute({ task_id: id, reason: "operator stop via model" }, ctxStub, new AbortController().signal);
    const text = textOf(out.content as Array<{ type: string; text?: string }>);
    expect(text).toContain("取消请求已受理");
    expect(text).toContain(id);
    expect(text).toContain("operator stop via model");
    expect(text).toContain(`GET /tasks/${id}`);
    expect(cancelCalls).toEqual([{ taskId: id, reason: "operator stop via model" }]);
    // 账本侧可观测迁移：cancel_requested 置位、state 仍 running（协作式收尾，工具不代跳终态）。
    expect(source.get(id)!.cancelRequested).toBe("operator stop via model");
    expect(source.get(id)!.state).toBe("running");
  });

  it("reason 缺省 = \"cancel requested\"（与 HTTP /tasks/:id/cancel 路由缺省词同缝对齐）", async () => {
    const id = "run_aaa0000000000002";
    const { source, cancelCalls } = fakeSource(new Map([[id, rec(id, "running")]]));
    const tool = createTaskCancelTool({ source });
    await tool.execute({ task_id: id }, ctxStub, new AbortController().signal);
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]!.reason).toBeUndefined(); // 工具不造第二缺省词：缺省交内核签名默认值
    expect(source.get(id)!.cancelRequested).toBe("cancel requested");
  });
});

describe("task_cancel：未知 id —— 不 throw、绝不触 cancel（单缝不双消）", () => {
  it("账本无此条 → not_found 诚实文案（含 task_id 来源指引）", async () => {
    const { source, cancelCalls } = fakeSource(new Map());
    const tool = createTaskCancelTool({ source });
    const out = await tool.execute({ task_id: "run_nosuch000000000" }, ctxStub, new AbortController().signal);
    const text = textOf(out.content as Array<{ type: string; text?: string }>);
    expect(text).toContain("不存在");
    expect(text).toContain("background=true");
    expect(cancelCalls).toHaveLength(0);
    expect(out.isError, "诚实回文本非异常：会话继续").not.toBe(true);
  });

  it("空/坏 task_id → 同族诚实文案，零 cancel 触点", async () => {
    const { source, cancelCalls } = fakeSource(new Map());
    const tool = createTaskCancelTool({ source });
    for (const args of [{ task_id: "" }, { task_id: "   " }, {}, { task_id: 42 }]) {
      const out = await tool.execute(args, ctxStub, new AbortController().signal);
      expect(textOf(out.content as Array<{ type: string; text?: string }>)).toContain("task_id");
    }
    expect(cancelCalls).toHaveLength(0);
  });
});

describe("task_cancel：已终态 —— 诚实终态行，零状态改动", () => {
  for (const state of ["done", "partial", "failed"] as const) {
    it(`status=${state} → 终态文案且 cancel 绝不被调用（账本逐字节不动）`, async () => {
      const id = `run_term0000000000${state.length.toString().padStart(3, "0")}`;
      const { source, cancelCalls } = fakeSource(new Map([[id, rec(id, state, null)]]));
      const tool = createTaskCancelTool({ source });
      const out = await tool.execute({ task_id: id }, ctxStub, new AbortController().signal);
      const text = textOf(out.content as Array<{ type: string; text?: string }>);
      expect(text).toContain("已是终态");
      expect(text).toContain(`status=${state}`);
      expect(cancelCalls).toHaveLength(0);
      const after = source.get(id)!;
      expect(after.state).toBe(state);
      expect(after.cancelRequested).toBeNull();
    });
  }
});

describe("task_cancel：取消竞态（get 后 cancel 前刚盖棺 / 记录消失）", () => {
  it("cancel 返回 false 但记录仍在且已终态 → 按终态文案整形（不谎报受理）", async () => {
    const id = "run_race000000000001";
    const map = new Map<string, SubTaskRecord>([[id, rec(id, "running")]]);
    const source: TaskCancelSource = {
      get: (taskId) => map.get(taskId),
      cancel: (taskId) => {
        // 竞态注入：cancel 时刻恰好被子自然终态盖棺
        map.set(taskId, rec(taskId, "done"));
        return false;
      },
    };
    const tool = createTaskCancelTool({ source });
    const out = await tool.execute({ task_id: id }, ctxStub, new AbortController().signal);
    const text = textOf(out.content as Array<{ type: string; text?: string }>);
    expect(text).toContain("已是终态");
    expect(text).toContain("status=done");
  });

  it("cancel 命中后记录被撤册（理论不可达兜底）→ 诚实「未受理」文案，不 throw", async () => {
    const id = "run_vanish000000000";
    const map = new Map<string, SubTaskRecord>([[id, rec(id, "running")]]);
    const source: TaskCancelSource = {
      get: (taskId) => map.get(taskId),
      cancel: (taskId) => {
        map.delete(taskId);
        return false;
      },
    };
    const tool = createTaskCancelTool({ source });
    const out = await tool.execute({ task_id: id }, ctxStub, new AbortController().signal);
    const text = textOf(out.content as Array<{ type: string; text?: string }>);
    expect(text).toContain(id);
    expect(text).not.toContain("已受理");
  });

  it("受理瞬间记录已进终态（cancel=true 后 aborter 即刻落地）→ 文案如实带当前态", async () => {
    const id = "run_fast000000000001";
    const map = new Map<string, SubTaskRecord>([[id, rec(id, "running")]]);
    const source: TaskCancelSource = {
      get: (taskId) => map.get(taskId),
      cancel: (taskId) => {
        map.set(taskId, { ...rec(taskId, "failed", "stop"), terminalAt: 9 });
        return true;
      },
    };
    const tool = createTaskCancelTool({ source });
    const out = await tool.execute({ task_id: id, reason: "stop" }, ctxStub, new AbortController().signal);
    const text = textOf(out.content as Array<{ type: string; text?: string }>);
    expect(text).toContain("取消请求已受理");
    expect(text).toContain("failed");
  });
});

describe("task_cancel：工具形状（面装配前置契约）", () => {
  it("name/description/parameters 形状：task_id 必填 + reason 可选；isConcurrencySafe=true", () => {
    const { source } = fakeSource(new Map());
    const tool = createTaskCancelTool({ source });
    expect(tool.name).toBe("task_cancel");
    expect(tool.description).toContain("中止");
    expect(tool.description).toContain("background");
    // 副会话/本会话纪律口径进描述（模型选型面，见工单 MUST DO）
    expect(tool.description).toContain("不承接");
    const params = tool.parameters as unknown as {
      properties: Record<string, unknown>;
      required: readonly string[];
    };
    expect(Object.keys(params.properties).sort()).toEqual(["reason", "task_id"]);
    expect(params.required).toContain("task_id");
    expect(tool.isConcurrencySafe?.({} as never)).toBe(true);
    expect(tool.isReadOnly, "有副作用：绝不标只读").not.toBe(true);
  });
});
