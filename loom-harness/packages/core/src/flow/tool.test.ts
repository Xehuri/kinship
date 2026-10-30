/**
 * flow_commit 工具验收：默认/显式创建、CAS 成功与冲突、closed 拒绝、槽形状。
 * 直接调用 execute（TypeBox 校验在真实内核里前置），断言模型可见输出与共享槽。
 */

import { describe, expect, it } from "vitest";
import { createTestContext } from "../testing.js";
import {
  FLOW_COMMIT_SLOT,
  FLOW_COMMIT_TOOL_NAME,
  FLOW_TOOL_NAME,
  FlowCommitTool,
  FlowTool,
  MemoryFlowContinuationStore,
  MemoryFlowStore,
  type FlowCommitSlot,
} from "./index.js";
import type { ToolExecResult } from "../types.js";

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const SIGNAL = new AbortController().signal;

interface Harness {
  readonly store: MemoryFlowStore;
  readonly ctx: ReturnType<typeof createTestContext>;
  readonly tool: ReturnType<typeof FlowCommitTool>;
}

function harness(sessionId = "s1"): Harness {
  let nextId = 0;
  const store = new MemoryFlowStore({
    now: () => NOW,
    idFactory: () => `flow_${(nextId++).toString(16).padStart(12, "0")}`,
  });
  const ctx = createTestContext({ sessionId, turnIdx: 0 });
  return { store, ctx, tool: FlowCommitTool({ store }) };
}

function textOf(result: ToolExecResult): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join(" ")
    .trim();
}

function slotOf(h: Harness): FlowCommitSlot | null {
  return h.ctx.ctx.state.get(FLOW_COMMIT_SLOT) ?? null;
}

describe("flow_commit 创建", () => {
  it("工具名符合 provider 的 ^[a-zA-Z0-9_-]+$ 约束", () => {
    expect(FLOW_COMMIT_TOOL_NAME).toBe("flow_commit");
    expect(FLOW_COMMIT_TOOL_NAME).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it("零主体 session 的匿名提交创建默认「主线」，并写完整共享槽", async () => {
    const h = harness();
    expect(await h.store.list("s1")).toHaveLength(0);

    const result = await h.tool.execute({ state: "active" }, h.ctx.ctx, SIGNAL);

    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({
      __flow: {
        subject_name: "主线",
        state: "active",
        focus: "foreground",
        version: 1,
        next_decision_at: null,
        created: true,
        turn_idx: 0,
      },
    });

    const slot = slotOf(h);
    expect(slot).toEqual({
      session_id: "s1",
      subject_id: slot?.subject_id,
      subject_name: "主线",
      state: "active",
      next_decision_at: null,
      version: 1,
      turn_idx: 0,
    });
    expect(slot?.subject_id).toMatch(/^flow_[0-9a-f]{12}$/);
    expect(Object.keys(slot ?? {})).toHaveLength(7);

    const stored = await h.store.list("s1");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.last_commit).toEqual({ turn_idx: 0, at: NOW });
  });

  it("显式 subject_name 创建，并把可选字段与解析后的时间写进槽和台账", async () => {
    const h = harness();
    const result = await h.tool.execute(
      {
        subject_name: "论文",
        kind: "task",
        title: "写第三章",
        description: "把实验补齐",
        notes_append: ["先跑基线"],
        notes_ref: "notes/paper.md",
        state: "active",
        focus: "background",
        next_decision_at: "1h",
        soft_deadline: "2h",
        due_at: "3h",
        timezone: "Asia/Shanghai",
        schedule: "daily 09:00",
      },
      h.ctx.ctx,
      SIGNAL,
    );

    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({
      __flow: {
        subject_name: "论文",
        state: "active",
        focus: "background",
        next_decision_at: NOW + 3_600_000,
        created: true,
      },
    });

    const slot = slotOf(h);
    expect(slot).toMatchObject({
      subject_name: "论文",
      state: "active",
      next_decision_at: NOW + 3_600_000,
      version: 1,
      turn_idx: 0,
    });
    const stored = await h.store.findByName("s1", "论文");
    expect(stored).toMatchObject({
      kind: "task",
      title: "写第三章",
      description: "把实验补齐",
      notes: ["先跑基线"],
      notes_ref: "notes/paper.md",
      focus: "background",
      soft_deadline: NOW + 7_200_000,
      due_at: NOW + 10_800_000,
      timezone: "Asia/Shanghai",
      schedule: "daily 09:00",
    });
  });
});

describe("flow_commit 更新与拒绝", () => {
  it("CAS 成功：subject_id + expected_version 推进版本，槽跟随本回合", async () => {
    const h = harness();
    const created = await h.tool.execute(
      { subject_name: "甲", state: "active" },
      h.ctx.ctx,
      SIGNAL,
    );
    expect(created.isError).toBeUndefined();
    const subjectId = slotOf(h)?.subject_id;
    expect(subjectId).toBeDefined();

    h.ctx.setTurnIdx(1);
    const updated = await h.tool.execute(
      {
        subject_id: subjectId,
        expected_version: 1,
        state: "waiting_user",
        notes_append: ["等回复"],
      },
      h.ctx.ctx,
      SIGNAL,
    );

    expect(updated.isError).toBeUndefined();
    expect(updated.details).toMatchObject({
      __flow: { subject_id: subjectId, state: "waiting_user", version: 2 },
    });
    expect(slotOf(h)).toEqual({
      session_id: "s1",
      subject_id: subjectId,
      subject_name: "甲",
      state: "waiting_user",
      next_decision_at: null,
      version: 2,
      turn_idx: 1,
    });
    expect((await h.store.get(subjectId ?? ""))?.notes).toEqual(["等回复"]);
  });

  it("只给 subject_name 的更新：自动解析 id 与当前版本，字段真正落库", async () => {
    const h = harness();
    await h.tool.execute(
      { subject_name: "甲", state: "active" },
      h.ctx.ctx,
      SIGNAL,
    );
    const subjectId = slotOf(h)?.subject_id ?? "";
    expect(subjectId).toMatch(/^flow_[0-9a-f]{12}$/);

    h.ctx.setTurnIdx(1);
    const updated = await h.tool.execute(
      {
        subject_name: "甲",
        state: "waiting_user",
        next_decision_at: "30m",
        notes_append: ["等回复"],
      },
      h.ctx.ctx,
      SIGNAL,
    );

    expect(updated.isError).toBeUndefined();
    expect(updated.details).toMatchObject({
      __flow: {
        subject_id: subjectId,
        state: "waiting_user",
        version: 2,
        next_decision_at: NOW + 1_800_000,
      },
    });
    expect(textOf(updated)).toContain(subjectId);
    expect(textOf(updated)).toContain("下次决策 2026-10-23T20:30:00.000+08:00");

    expect(await h.store.get(subjectId)).toMatchObject({
      subject_name: "甲",
      state: "waiting_user",
      version: 2,
      next_decision_at: NOW + 1_800_000,
      notes: ["等回复"],
    });
    expect(slotOf(h)).toMatchObject({
      subject_id: subjectId,
      subject_name: "甲",
      state: "waiting_user",
      next_decision_at: NOW + 1_800_000,
      version: 2,
      turn_idx: 1,
    });
  });

  it("匿名更新命中既有默认「主线」：版本推进并写入 next_decision_at", async () => {
    const h = harness();
    await h.tool.execute({ state: "active" }, h.ctx.ctx, SIGNAL);
    const subjectId = slotOf(h)?.subject_id ?? "";

    h.ctx.setTurnIdx(1);
    const updated = await h.tool.execute(
      { state: "waiting_user", next_decision_at: "30m" },
      h.ctx.ctx,
      SIGNAL,
    );

    expect(updated.isError).toBeUndefined();
    expect(updated.details).toMatchObject({
      __flow: {
        subject_id: subjectId,
        subject_name: "主线",
        state: "waiting_user",
        version: 2,
        next_decision_at: NOW + 1_800_000,
      },
    });
    expect((await h.store.get(subjectId))?.next_decision_at).toBe(
      NOW + 1_800_000,
    );
    expect(slotOf(h)).toMatchObject({ version: 2, turn_idx: 1 });
  });

  it.each([
    ["30s", 30_000],
    ["45秒", 45_000],
  ] as const)("倒计时支持秒单位：%s 落库为 now + %i ms", async (spec, delta) => {
    const h = harness();
    await h.tool.execute({ state: "active" }, h.ctx.ctx, SIGNAL);
    const subjectId = slotOf(h)?.subject_id ?? "";

    h.ctx.setTurnIdx(1);
    const updated = await h.tool.execute(
      { state: "waiting_user", next_decision_at: spec },
      h.ctx.ctx,
      SIGNAL,
    );

    expect(updated.isError).toBeUndefined();
    expect(updated.details).toMatchObject({
      __flow: {
        subject_id: subjectId,
        state: "waiting_user",
        version: 2,
        next_decision_at: NOW + delta,
      },
    });
    expect((await h.store.get(subjectId))?.next_decision_at).toBe(NOW + delta);
    expect(slotOf(h)).toMatchObject({
      next_decision_at: NOW + delta,
      version: 2,
      turn_idx: 1,
    });
  });

  it("name-only 路径上显式的 stale expected_version 仍返回 conflict，台账不动", async () => {
    const h = harness();
    await h.tool.execute(
      { subject_name: "甲", state: "active" },
      h.ctx.ctx,
      SIGNAL,
    );
    const subjectId = slotOf(h)?.subject_id ?? "";

    h.ctx.setTurnIdx(1);
    const result = await h.tool.execute(
      { subject_name: "甲", expected_version: 99, state: "waiting_user" },
      h.ctx.ctx,
      SIGNAL,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/conflict/);
    expect((await h.store.get(subjectId))?.state).toBe("active");
    expect((await h.store.get(subjectId))?.version).toBe(1);
  });

  it("CAS 冲突：模型看到 conflict 错误，槽与台账都不被覆盖", async () => {
    const h = harness();
    await h.tool.execute(
      { subject_name: "甲", state: "active" },
      h.ctx.ctx,
      SIGNAL,
    );
    const subjectId = slotOf(h)?.subject_id ?? "";
    const before = slotOf(h);

    h.ctx.setTurnIdx(1);
    const result = await h.tool.execute(
      { subject_id: subjectId, expected_version: 5, state: "waiting_user" },
      h.ctx.ctx,
      SIGNAL,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/conflict/);
    expect(textOf(result)).toContain(subjectId);
    expect(slotOf(h)).toEqual(before);
    expect((await h.store.get(subjectId))?.version).toBe(1);
    expect((await h.store.get(subjectId))?.state).toBe("active");
  });

  it("closed 拒绝：关闭后的任何提交返回 closed 错误，版本停在关闭时", async () => {
    const h = harness();
    await h.tool.execute(
      { subject_name: "甲", state: "active" },
      h.ctx.ctx,
      SIGNAL,
    );
    const subjectId = slotOf(h)?.subject_id ?? "";

    h.ctx.setTurnIdx(1);
    const closed = await h.tool.execute(
      {
        subject_id: subjectId,
        expected_version: 1,
        state: "closed",
        close_reason: "完成",
      },
      h.ctx.ctx,
      SIGNAL,
    );
    expect(closed.isError).toBeUndefined();
    expect(slotOf(h)).toMatchObject({ state: "closed", version: 2 });

    h.ctx.setTurnIdx(2);
    const rejected = await h.tool.execute(
      { subject_id: subjectId, expected_version: 2, state: "active" },
      h.ctx.ctx,
      SIGNAL,
    );

    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toMatch(/closed/);
    expect(slotOf(h)).toMatchObject({
      state: "closed",
      version: 2,
      turn_idx: 1,
    });
    expect((await h.store.get(subjectId))?.version).toBe(2);
  });

  it("state 完全来自输入：active 提交不会被工具自动改成 waiting_user", async () => {
    const h = harness();
    const result = await h.tool.execute(
      { subject_name: "甲", state: "active" },
      h.ctx.ctx,
      SIGNAL,
    );
    expect(result.isError).toBeUndefined();
    expect(slotOf(h)?.state).toBe("active");
    expect((await h.store.findByName("s1", "甲"))?.state).toBe("active");
  });
});

interface ContinuationHarness {
  readonly store: MemoryFlowContinuationStore;
  readonly ctx: ReturnType<typeof createTestContext>;
  readonly tool: ReturnType<typeof FlowTool>;
}

function continuationHarness(sessionId = "s1"): ContinuationHarness {
  const store = new MemoryFlowContinuationStore({ now: () => NOW });
  const ctx = createTestContext({ sessionId, turnIdx: 0 });
  return { store, ctx, tool: FlowTool({ store }) };
}

describe("flow 简化持续记录动作", () => {
  it("工具名符合 provider 的 ^[a-zA-Z0-9_-]+$ 约束", () => {
    expect(FLOW_TOOL_NAME).toBe("flow");
    expect(FLOW_TOOL_NAME).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it("wait -> resume -> close 走完整生命周期", async () => {
    const h = continuationHarness();

    const waited = await h.tool.execute(
      {
        action: "wait",
        id: "c1",
        source: { plan_date: "2026-10-28", checkpoint_id: "c1" },
        waiting_on: "材料照片就绪",
        next_at: "30m",
        close_condition: "照片上传",
        reason: "计划创建时登记",
      },
      h.ctx.ctx,
      SIGNAL,
    );
    expect(waited.isError).toBeUndefined();
    expect(waited.details).toMatchObject({
      __flow: {
        action: "wait",
        ok: true,
        continuation: {
          id: "c1",
          state: "waiting",
          waiting_on: "材料照片就绪",
          next_at: NOW + 1_800_000,
          close_condition: "照片上传",
          reason: "计划创建时登记",
          last_update: NOW,
        },
      },
    });

    const resumed = await h.tool.execute(
      { action: "resume", id: "c1", reason: "检查点到了" },
      h.ctx.ctx,
      SIGNAL,
    );
    expect(resumed.isError).toBeUndefined();
    expect(resumed.details).toMatchObject({
      __flow: {
        action: "resume",
        ok: true,
        continuation: {
          id: "c1",
          state: "active",
          waiting_on: null,
          next_at: null,
          reason: "检查点到了",
        },
      },
    });

    const closed = await h.tool.execute(
      { action: "close", id: "c1", reason: "已完成" },
      h.ctx.ctx,
      SIGNAL,
    );
    expect(closed.isError).toBeUndefined();
    expect(closed.details).toMatchObject({
      __flow: {
        action: "close",
        ok: true,
        continuation: {
          id: "c1",
          state: "closed",
          waiting_on: null,
          next_at: null,
          reason: "已完成",
        },
      },
    });
    expect((await h.store.list("s1")).map((row) => row.state)).toEqual([
      "closed",
    ]);
  });

  it("read 返回单条记录；缺失时返回 isError not-found", async () => {
    const h = continuationHarness();
    await h.tool.execute(
      {
        action: "wait",
        id: "c2",
        source: { checkpoint_id: "c2" },
        waiting_on: "家人回复",
        next_at: "1h",
      },
      h.ctx.ctx,
      SIGNAL,
    );

    const read = await h.tool.execute(
      { action: "read", id: "c2" },
      h.ctx.ctx,
      SIGNAL,
    );
    expect(read.isError).toBeUndefined();
    expect(read.details).toMatchObject({
      __flow: {
        action: "read",
        ok: true,
        continuation: {
          id: "c2",
          state: "waiting",
          waiting_on: "家人回复",
          next_at: NOW + 3_600_000,
        },
      },
    });
    expect(textOf(read)).toContain("c2");

    const missing = await h.tool.execute(
      { action: "read", id: "nope" },
      h.ctx.ctx,
      SIGNAL,
    );
    expect(missing.isError).toBe(true);
    expect(missing.details).toMatchObject({
      __flow: { action: "read", ok: false, error: "FlowContinuationNotFoundError" },
    });
  });

  it("同一条目第二次 wait（换 id）返回 isError conflict，不产生第二行", async () => {
    const h = continuationHarness();
    const first = await h.tool.execute(
      {
        action: "wait",
        id: "flw_01",
        source: { checkpoint_id: "c1" },
        waiting_on: "照片就绪",
        next_at: "30m",
      },
      h.ctx.ctx,
      SIGNAL,
    );
    expect(first.isError).toBeUndefined();

    const duplicate = await h.tool.execute(
      {
        action: "wait",
        id: "flw_02",
        source: { checkpoint_id: "c1" },
        waiting_on: "照片就绪",
        next_at: "1h",
      },
      h.ctx.ctx,
      SIGNAL,
    );
    expect(duplicate.isError).toBe(true);
    expect(duplicate.details).toMatchObject({
      __flow: {
        action: "wait",
        ok: false,
        error: "FlowContinuationConflictError",
      },
    });
    expect((await h.store.list("s1")).map((row) => row.id)).toEqual([
      "flw_01",
    ]);
  });

  it("close 缺少 reason 返回 isError validation，记录保持原状态", async () => {
    const h = continuationHarness();
    await h.tool.execute(
      {
        action: "wait",
        id: "c3",
        waiting_on: "等消息",
        next_at: "10m",
      },
      h.ctx.ctx,
      SIGNAL,
    );

    const rejected = await h.tool.execute(
      { action: "close", id: "c3" },
      h.ctx.ctx,
      SIGNAL,
    );
    expect(rejected.isError).toBe(true);
    expect(rejected.details).toMatchObject({
      __flow: {
        action: "close",
        ok: false,
        error: "FlowValidationError",
      },
    });
    expect((await h.store.read("s1", "c3")).state).toBe("waiting");
  });

  it("next_at 非法时返回 isError validation，且不写入记录", async () => {
    const h = continuationHarness();
    const rejected = await h.tool.execute(
      {
        action: "wait",
        id: "c4",
        waiting_on: "等消息",
        next_at: "not-a-time",
      },
      h.ctx.ctx,
      SIGNAL,
    );
    expect(rejected.isError).toBe(true);
    expect(rejected.details).toMatchObject({
      __flow: {
        action: "wait",
        ok: false,
        error: "FlowValidationError",
      },
    });
    expect(await h.store.list("s1")).toEqual([]);
  });

  it("wait 缺少 waiting_on 或 next_at 时返回 isError validation", async () => {
    const h = continuationHarness();
    const missingWaitingOn = await h.tool.execute(
      { action: "wait", id: "c5", next_at: "30m" },
      h.ctx.ctx,
      SIGNAL,
    );
    expect(missingWaitingOn.isError).toBe(true);

    const missingNextAt = await h.tool.execute(
      { action: "wait", id: "c5", waiting_on: "等消息" },
      h.ctx.ctx,
      SIGNAL,
    );
    expect(missingNextAt.isError).toBe(true);
    expect(await h.store.list("s1")).toEqual([]);
  });

  it("closed 记录拒绝再次 wait/resume/close", async () => {
    const h = continuationHarness();
    await h.tool.execute(
      {
        action: "wait",
        id: "c6",
        waiting_on: "等消息",
        next_at: "30m",
      },
      h.ctx.ctx,
      SIGNAL,
    );
    await h.tool.execute(
      { action: "close", id: "c6", reason: "完成" },
      h.ctx.ctx,
      SIGNAL,
    );

    for (const args of [
      {
        action: "wait",
        id: "c6",
        waiting_on: "再等",
        next_at: "1h",
      },
      { action: "resume", id: "c6" },
      { action: "close", id: "c6", reason: "再关一次" },
    ] as const) {
      const result = await h.tool.execute(args, h.ctx.ctx, SIGNAL);
      expect(result.isError).toBe(true);
      expect(result.details).toMatchObject({
        __flow: { error: "FlowContinuationConflictError" },
      });
    }
  });
});
