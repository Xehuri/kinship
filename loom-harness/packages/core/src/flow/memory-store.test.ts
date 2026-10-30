/**
 * MemoryFlowStore 行为验收：查询隔离、ensureDefault、可选字段落地、
 * 时间边界、关闭语义、字段保持、运行时枚举防御、session 枚举。
 */

import { describe, expect, it } from "vitest";
import {
  FLOW_LIMITS,
  FlowConflictError,
  FlowLimitError,
  FlowValidationError,
  MemoryFlowStore,
  type FlowCommitInput,
  type FlowSubject,
  type FlowUnsetRecord,
} from "./index.js";

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);

interface Harness {
  readonly store: MemoryFlowStore;
  readonly clock: { now: number };
}

function harness(start = NOW): Harness {
  let nextId = 0;
  const clock = { now: start };
  const store = new MemoryFlowStore({
    now: () => clock.now,
    idFactory: () => `flow_${(nextId++).toString(16).padStart(12, "0")}`,
  });
  return { store, clock };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection but the promise resolved");
}

describe("查询与 session 隔离", () => {
  it("list/get/findByName 只命中各自 session", async () => {
    const { store } = harness();
    const a = await store.commit("s1", { subject_name: "A", state: "active" }, { turn_idx: 1 });
    const b = await store.commit("s2", { subject_name: "B", state: "active" }, { turn_idx: 1 });

    expect(await store.list("s1")).toEqual([a.subject]);
    expect(await store.list("s2")).toEqual([b.subject]);
    expect(await store.get(a.subject.subject_id)).toBe(a.subject);
    expect(await store.get("flow_ffffffffffff")).toBeNull();
    expect(await store.findByName("s1", "B")).toBeNull();
    expect(await store.findByName("s2", "B")).toBe(b.subject);
    expect(await store.findByName("s2", "不存在")).toBeNull();
  });

  it("listSessionIds 合并主体 session 与仅有 unset 的 session，不重复", async () => {
    const { store } = harness();
    await store.appendUnset("s2", {
      turn_idx: 1,
      reason: "no_commit",
      had_tool_results: false,
    });
    await store.commit("s1", { subject_name: "A", state: "active" }, { turn_idx: 1 });
    await store.appendUnset("s1", {
      turn_idx: 2,
      reason: "run_end_no_commit",
      had_tool_results: true,
    });
    expect(await store.listSessionIds()).toEqual(["s1", "s2"]);
  });
});

describe("ensureDefault", () => {
  it("空 session 创建「主线」（无 last_commit），重复调用返回同一行", async () => {
    const { store } = harness();
    const first = await store.ensureDefault("s1");
    expect(first).not.toBeNull();
    expect(first).toMatchObject({
      subject_name: "主线",
      state: "active",
      focus: "foreground",
      kind: "thread",
      version: 1,
      created_at: NOW,
      updated_at: NOW,
      last_commit: null,
    });
    const second = await store.ensureDefault("s1", { now: NOW + 10_000 });
    expect(second?.subject_id).toBe(first?.subject_id);
    expect(second?.updated_at).toBe(NOW);
    expect(await store.list("s1")).toHaveLength(1);
  });

  it("已有其他主体但没有「主线」时返回 null，不建默认行", async () => {
    const { store } = harness();
    await store.commit("s1", { subject_name: "甲", state: "active" }, { turn_idx: 1 });
    expect(await store.ensureDefault("s1")).toBeNull();
    expect(await store.list("s1")).toHaveLength(1);
  });
});

describe("可选字段落地", () => {
  it("创建时应用 kind/title/description/focus/notes/ref/timezone/schedule/parent", async () => {
    const { store } = harness();
    const parent = await store.commit(
      "s1",
      { subject_name: "父", state: "active" },
      { turn_idx: 1 },
    );
    const dueAt = Date.UTC(2026, 9, 25, 12, 0, 0);
    const child = await store.commit(
      "s1",
      {
        subject_name: "子",
        kind: "task",
        title: "重构音频链路",
        description: "把重采样移到内核",
        focus: "parked",
        notes_append: ["第一条"],
        notes_ref: "notes/child.md",
        state: "waiting_event",
        next_decision_at: "30m",
        soft_deadline: "2026-10-24T12:00:00Z",
        due_at: dueAt,
        timezone: "Asia/Shanghai",
        schedule: "daily 09:00",
        parent_id: parent.subject.subject_id,
      },
      { turn_idx: 2 },
    );
    expect(child.subject).toMatchObject({
      kind: "task",
      title: "重构音频链路",
      description: "把重采样移到内核",
      focus: "parked",
      notes: ["第一条"],
      notes_ref: "notes/child.md",
      state: "waiting_event",
      next_decision_at: NOW + 30 * 60_000,
      soft_deadline: Date.UTC(2026, 9, 24, 12, 0, 0),
      due_at: dueAt,
      timezone: "Asia/Shanghai",
      schedule: "daily 09:00",
      parent_id: parent.subject.subject_id,
      created_at: NOW,
      updated_at: NOW,
    });
  });

  it("更新缺省的字段全部保持不变", async () => {
    const { store } = harness();
    const created = await store.commit(
      "s1",
      {
        subject_name: "保持",
        kind: "task",
        title: "标题",
        description: "描述",
        focus: "background",
        notes_append: ["n"],
        notes_ref: "notes/keep.md",
        state: "active",
        timezone: "UTC",
        schedule: "weekly",
        next_decision_at: "1h",
        due_at: "2026-10-25T12:00:00Z",
      },
      { turn_idx: 1 },
    );
    const updated = await store.commit(
      "s1",
      {
        subject_id: created.subject.subject_id,
        state: "waiting_user",
        expected_version: 1,
      },
      { turn_idx: 2 },
    );
    expect(updated.subject).toMatchObject({
      kind: "task",
      title: "标题",
      description: "描述",
      focus: "background",
      notes: ["n"],
      notes_ref: "notes/keep.md",
      timezone: "UTC",
      schedule: "weekly",
      next_decision_at: NOW + 3_600_000,
      due_at: Date.UTC(2026, 9, 25, 12, 0, 0),
      state: "waiting_user",
      version: 2,
    });
  });
});

describe("时间边界", () => {
  it("next_decision_at 下界/上界钳制，null 清空", async () => {
    const { store, clock } = harness();
    const created = await store.commit(
      "s1",
      { subject_name: "时钟", state: "active", next_decision_at: "1s" },
      { turn_idx: 1 },
    );
    expect(created.subject.next_decision_at).toBe(NOW + FLOW_LIMITS.minWakeLeadMs);

    clock.now = NOW + 60_000;
    const far = await store.commit(
      "s1",
      {
        subject_id: created.subject.subject_id,
        state: "active",
        expected_version: 1,
        next_decision_at: "40d",
      },
      { turn_idx: 2 },
    );
    expect(far.subject.next_decision_at).toBe(clock.now + FLOW_LIMITS.maxWakeHorizonMs);

    const cleared = await store.commit(
      "s1",
      {
        subject_id: created.subject.subject_id,
        state: "active",
        expected_version: 2,
        next_decision_at: null,
      },
      { turn_idx: 3 },
    );
    expect(cleared.subject.next_decision_at).toBeNull();
  });

  it("due_at/soft_deadline 拒绝过去，失败不改版本", async () => {
    const { store } = harness();
    const created = await store.commit(
      "s1",
      { subject_name: "死线", state: "active" },
      { turn_idx: 1 },
    );
    const error = await captureError(
      store.commit(
        "s1",
        {
          subject_id: created.subject.subject_id,
          state: "active",
          expected_version: 1,
          due_at: "2026-10-23T11:00:00Z",
        },
        { turn_idx: 2 },
      ),
    );
    expect(error).toBeInstanceOf(FlowValidationError);
    expect((error as FlowValidationError).field).toBe("due_at");

    const softError = await captureError(
      store.commit(
        "s1",
        {
          subject_id: created.subject.subject_id,
          state: "active",
          expected_version: 1,
          soft_deadline: "2026-10-23T12:00:00Z",
        },
        { turn_idx: 2 },
      ),
    );
    expect(softError).toBeInstanceOf(FlowValidationError);
    expect((softError as FlowValidationError).field).toBe("soft_deadline");
    expect((await store.get(created.subject.subject_id))?.version).toBe(1);
  });

  it("非法时区拒绝，null 清空", async () => {
    const { store } = harness();
    await expect(
      store.commit(
        "s1",
        { subject_name: "坏时区", state: "active", timezone: "Mars/Base" },
        { turn_idx: 1 },
      ),
    ).rejects.toBeInstanceOf(FlowValidationError);

    const created = await store.commit(
      "s1",
      { subject_name: "好时区", state: "active", timezone: "Asia/Shanghai" },
      { turn_idx: 1 },
    );
    const cleared = await store.commit(
      "s1",
      {
        subject_id: created.subject.subject_id,
        state: "active",
        expected_version: 1,
        timezone: null,
      },
      { turn_idx: 2 },
    );
    expect(cleared.subject.timezone).toBeNull();
  });
});

describe("关闭语义", () => {
  it("关闭时写 closed_at/close_reason 并清空 next_decision_at", async () => {
    const { store, clock } = harness();
    const created = await store.commit(
      "s1",
      { subject_name: "甲", state: "active", next_decision_at: "1h" },
      { turn_idx: 1 },
    );
    clock.now += 1_000;
    const closed = await store.commit(
      "s1",
      {
        subject_id: created.subject.subject_id,
        state: "closed",
        expected_version: 1,
        close_reason: "完成",
        next_decision_at: "2h",
      },
      { turn_idx: 2 },
    );
    expect(closed.subject.closed_at).toBe(NOW + 1_000);
    expect(closed.subject.close_reason).toBe("完成");
    expect(closed.subject.next_decision_at).toBeNull();
  });

  it("非 closed 提交携带非空 close_reason 拒绝", async () => {
    const { store } = harness();
    const created = await store.commit(
      "s1",
      { subject_name: "甲", state: "active" },
      { turn_idx: 1 },
    );
    const error = await captureError(
      store.commit(
        "s1",
        {
          subject_id: created.subject.subject_id,
          state: "waiting_user",
          expected_version: 1,
          close_reason: "未完成",
        },
        { turn_idx: 2 },
      ),
    );
    expect(error).toBeInstanceOf(FlowValidationError);
    expect((error as FlowValidationError).field).toBe("close_reason");
    expect((await store.get(created.subject.subject_id))?.version).toBe(1);
  });
});

describe("parent_id 与运行时防御", () => {
  it("parent_id 不能指向自身，非法 id 拒绝", async () => {
    const { store } = harness();
    const created = await store.commit(
      "s1",
      { subject_name: "甲", state: "active" },
      { turn_idx: 1 },
    );
    const selfError = await captureError(
      store.commit(
        "s1",
        {
          subject_id: created.subject.subject_id,
          state: "active",
          expected_version: 1,
          parent_id: created.subject.subject_id,
        },
        { turn_idx: 2 },
      ),
    );
    expect(selfError).toBeInstanceOf(FlowValidationError);
    expect((selfError as FlowValidationError).field).toBe("parent_id");

    await expect(
      store.commit(
        "s1",
        {
          subject_id: created.subject.subject_id,
          state: "active",
          expected_version: 1,
          parent_id: "not-a-subject-id",
        },
        { turn_idx: 2 },
      ),
    ).rejects.toBeInstanceOf(FlowValidationError);
  });

  it("运行时非法的 state/focus/kind/expected_version 拒绝", async () => {
    const { store } = harness();
    const cases: FlowCommitInput[] = [
      { state: "paused" } as unknown as FlowCommitInput,
      { state: "active", focus: "front" } as unknown as FlowCommitInput,
      { state: "active", kind: "epic" } as unknown as FlowCommitInput,
      { subject_name: "甲", state: "active", expected_version: 0 } as unknown as FlowCommitInput,
    ];
    for (const input of cases) {
      await expect(store.commit("s1", input, { turn_idx: 1 })).rejects.toBeInstanceOf(
        FlowValidationError,
      );
    }
    expect(await store.list("s1")).toHaveLength(0);
  });
});

describe("可注入限额", () => {
  it("limits 注入同时约束容量与 notes 累计字节", async () => {
    const limits = {
      ...FLOW_LIMITS,
      maxActive: 1,
      maxWaiting: 1,
      maxSubjects: 2,
      maxNotesBytes: 1000,
    };
    let nextId = 0;
    const store = new MemoryFlowStore({
      limits,
      now: () => NOW,
      idFactory: () => `flow_${(nextId++).toString(16).padStart(12, "0")}`,
    });
    const a = await store.commit(
      "s1",
      {
        subject_name: "A",
        state: "active",
        notes_append: ["a".repeat(500), "a".repeat(500)],
      },
      { turn_idx: 1 },
    );
    expect(a.subject.notes).toHaveLength(2);

    const activeError = await captureError(
      store.commit("s1", { subject_name: "B", state: "active" }, { turn_idx: 1 }),
    );
    expect(activeError).toBeInstanceOf(FlowLimitError);
    if (activeError instanceof FlowLimitError) {
      expect(activeError.limit).toBe("maxActive");
      expect(activeError.max).toBe(1);
      expect(activeError.actual).toBe(2);
    }

    await store.commit("s1", { subject_name: "B", state: "waiting_user" }, { turn_idx: 1 });

    const waitingError = await captureError(
      store.commit(
        "s1",
        { subject_id: a.subject.subject_id, state: "waiting_user", expected_version: 1 },
        { turn_idx: 2 },
      ),
    );
    expect(waitingError).toBeInstanceOf(FlowLimitError);
    if (waitingError instanceof FlowLimitError) {
      expect(waitingError.limit).toBe("maxWaiting");
      expect(waitingError.max).toBe(1);
      expect(waitingError.actual).toBe(2);
    }

    const subjectsError = await captureError(
      store.commit("s1", { subject_name: "C", state: "closed" }, { turn_idx: 1 }),
    );
    expect(subjectsError).toBeInstanceOf(FlowLimitError);
    if (subjectsError instanceof FlowLimitError) {
      expect(subjectsError.limit).toBe("maxSubjects");
      expect(subjectsError.max).toBe(2);
      expect(subjectsError.actual).toBe(3);
    }

    const notesError = await captureError(
      store.commit(
        "s1",
        {
          subject_id: a.subject.subject_id,
          state: "active",
          expected_version: 1,
          notes_append: ["b"],
        },
        { turn_idx: 2 },
      ),
    );
    expect(notesError).toBeInstanceOf(FlowLimitError);
    if (notesError instanceof FlowLimitError) {
      expect(notesError.limit).toBe("maxNotesBytes");
      expect(notesError.max).toBe(1000);
      expect(notesError.actual).toBe(1001);
    }

    expect(await store.list("s1")).toHaveLength(2);
    expect((await store.get(a.subject.subject_id))?.notes).toHaveLength(2);
  });
});

describe("重启水合（initialSubjects / initialUnsets）", () => {
  const hydrated: FlowSubject = Object.freeze({
    schema: 1,
    subject_id: "flow_aaaaaaaaaaaa",
    subject_name: "恢复",
    session_id: "s1",
    kind: "task",
    title: "恢复标题",
    description: "恢复描述",
    notes: Object.freeze(["n1", "n2"]),
    notes_ref: "notes/a.md",
    state: "waiting_user",
    focus: "background",
    version: 3,
    created_at: NOW,
    updated_at: NOW + 1_000,
    next_decision_at: NOW + 60_000,
    soft_deadline: null,
    due_at: NOW + 120_000,
    timezone: "UTC",
    schedule: "daily 09:00",
    parent_id: null,
    closed_at: null,
    close_reason: null,
    last_commit: Object.freeze({ turn_idx: 7, at: NOW + 1_000 }),
  });

  const unset: FlowUnsetRecord = Object.freeze({
    schema: 1,
    session_id: "s2",
    at: NOW,
    turn_idx: 2,
    reason: "no_commit",
    had_tool_results: false,
  });

  it("装载既有行后查询与 CAS 语义不变", async () => {
    const store = new MemoryFlowStore({
      initialSubjects: [hydrated],
      now: () => NOW + 2_000,
    });
    expect(await store.list("s1")).toEqual([hydrated]);
    expect(await store.findByName("s1", "恢复")).toEqual(hydrated);
    expect(await store.get(hydrated.subject_id)).toEqual(hydrated);

    const updated = await store.commit(
      "s1",
      { subject_id: hydrated.subject_id, state: "active", expected_version: 3 },
      { turn_idx: 8 },
    );
    expect(updated.subject.version).toBe(4);
    expect(updated.subject.notes).toEqual(["n1", "n2"]);
    expect(updated.subject.last_commit).toEqual({ turn_idx: 8, at: NOW + 2_000 });

    await expect(
      store.commit(
        "s1",
        { subject_id: hydrated.subject_id, state: "active", expected_version: 3 },
        { turn_idx: 9 },
      ),
    ).rejects.toBeInstanceOf(FlowConflictError);
  });

  it("按传入顺序恢复主体（不受 created_at 排序影响）", async () => {
    const second: FlowSubject = Object.freeze({
      ...hydrated,
      subject_id: "flow_bbbbbbbbbbbb",
      subject_name: "第二",
      state: "active",
      focus: "foreground",
      version: 1,
      last_commit: null,
    });
    const store = new MemoryFlowStore({ initialSubjects: [second, hydrated] });
    expect((await store.list("s1")).map((row) => row.subject_name)).toEqual(["第二", "恢复"]);
  });

  it("恢复 unset 行时仅有审计记录的 session 仍可枚举", async () => {
    const store = new MemoryFlowStore({ initialUnsets: [unset] });
    expect(await store.listSessionIds()).toEqual(["s2"]);
    const appended = await store.appendUnset("s2", {
      turn_idx: 3,
      reason: "run_end_no_commit",
      had_tool_results: true,
      now: NOW + 1,
    });
    expect(appended.at).toBe(NOW + 1);
    expect(await store.listSessionIds()).toEqual(["s2"]);
  });

  it("非法水合行抛类型化错误，不静默丢弃", () => {
    const bad = [
      () => new MemoryFlowStore({ initialSubjects: [{ ...hydrated, schema: 2 }] }),
      () => new MemoryFlowStore({ initialSubjects: [{ ...hydrated, state: "paused" }] }),
      () => new MemoryFlowStore({ initialSubjects: [{ ...hydrated, version: 0 }] }),
      () => new MemoryFlowStore({ initialSubjects: [{ ...hydrated, notes: [1] }] }),
      () =>
        new MemoryFlowStore({
          initialSubjects: [hydrated, { ...hydrated, subject_name: "另一个" }],
        }),
      () =>
        new MemoryFlowStore({
          initialSubjects: [hydrated, { ...hydrated, subject_id: "flow_cccccccccccc" }],
        }),
      () => new MemoryFlowStore({ initialUnsets: [{ ...unset, reason: "oops" }] }),
      () => new MemoryFlowStore({ initialUnsets: [{ ...unset, schema: 2 }] }),
    ];
    for (const build of bad) {
      expect(build).toThrow(FlowValidationError);
    }
  });
});
