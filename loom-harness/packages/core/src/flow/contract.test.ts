/**
 * Flow 契约验收：默认主体、重名幂等、CAS、closed、版本单调、限额、notes、待决策、unset。
 * 全部通过公开的 FlowStore 面驱动，不读私有字段。
 */

import { describe, expect, it } from "vitest";
import {
  FLOW_LIMITS,
  FlowClosedError,
  FlowConflictError,
  FlowLimitError,
  FlowValidationError,
  MemoryFlowStore,
  type FlowCommitInput,
  type FlowUnsetInput,
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

describe("默认主体", () => {
  it("零主体 session 的匿名提交创建「主线」并带完整默认字段", async () => {
    const { store } = harness();
    const result = await store.commit("s1", { state: "active" }, { turn_idx: 3 });
    expect(result.created).toBe(true);
    expect(result.subject).toMatchObject({
      schema: 1,
      subject_name: "主线",
      session_id: "s1",
      kind: "thread",
      title: "主线",
      description: "",
      notes: [],
      notes_ref: null,
      state: "active",
      focus: "foreground",
      version: 1,
      created_at: NOW,
      updated_at: NOW,
      next_decision_at: null,
      soft_deadline: null,
      due_at: null,
      timezone: null,
      schedule: null,
      parent_id: null,
      closed_at: null,
      close_reason: null,
      last_commit: { turn_idx: 3, at: NOW },
    });
    expect(result.subject.subject_id).toMatch(/^flow_[0-9a-f]{12}$/);
    expect(await store.list("s1")).toHaveLength(1);
  });

  it("再次匿名提交命中「主线」但原样返回，不推进版本", async () => {
    const { store, clock } = harness();
    const first = await store.commit("s1", { state: "active" }, { turn_idx: 1 });
    clock.now += 5_000;
    const second = await store.commit("s1", { state: "waiting_user" }, { turn_idx: 2 });
    expect(second.created).toBe(false);
    expect(second.subject.subject_id).toBe(first.subject.subject_id);
    expect(second.subject.state).toBe("active");
    expect(second.subject.version).toBe(1);
    expect(second.subject.updated_at).toBe(NOW);
    expect(second.subject.last_commit?.turn_idx).toBe(1);
  });

  it("已有其他主体时匿名提交拒绝，而不是偷偷创建「主线」", async () => {
    const { store } = harness();
    await store.commit("s1", { subject_name: "甲", state: "active" }, { turn_idx: 1 });
    const error = await captureError(
      store.commit("s1", { state: "active" }, { turn_idx: 2 }),
    );
    expect(error).toBeInstanceOf(FlowValidationError);
    expect((error as FlowValidationError).field).toBe("subject_name");
    expect(await store.list("s1")).toHaveLength(1);
  });
});

describe("重名与 CAS", () => {
  it("同名创建返回既有行（created:false），不改状态/版本/更新时间", async () => {
    const { store, clock } = harness();
    const first = await store.commit(
      "s1",
      { subject_name: "甲", state: "active" },
      { turn_idx: 1 },
    );
    clock.now += 10_000;
    const duplicate = await store.commit(
      "s1",
      { subject_name: "甲", state: "waiting_user", expected_version: 99 },
      { turn_idx: 2 },
    );
    expect(duplicate.created).toBe(false);
    expect(duplicate.subject).toBe(first.subject);
    expect(duplicate.subject.state).toBe("active");
    expect(duplicate.subject.version).toBe(1);
    expect(duplicate.subject.updated_at).toBe(NOW);
  });

  it("重名后模型可按 subject_id + expected_version 重试并成功", async () => {
    const { store, clock } = harness();
    const first = await store.commit(
      "s1",
      { subject_name: "甲", state: "active" },
      { turn_idx: 1 },
    );
    await store.commit("s1", { subject_name: "甲", state: "waiting_user" }, { turn_idx: 2 });
    clock.now += 1_000;
    const retry = await store.commit(
      "s1",
      {
        subject_id: first.subject.subject_id,
        subject_name: "甲",
        state: "waiting_user",
        expected_version: 1,
      },
      { turn_idx: 3 },
    );
    expect(retry.created).toBe(false);
    expect(retry.subject.version).toBe(2);
    expect(retry.subject.state).toBe("waiting_user");
    expect(retry.subject.last_commit).toEqual({ turn_idx: 3, at: clock.now });
  });

  it("更新缺 expected_version 直接拒绝", async () => {
    const { store } = harness();
    const created = await store.commit(
      "s1",
      { subject_name: "甲", state: "active" },
      { turn_idx: 1 },
    );
    await expect(
      store.commit(
        "s1",
        { subject_id: created.subject.subject_id, state: "waiting_user" },
        { turn_idx: 2 },
      ),
    ).rejects.toBeInstanceOf(FlowValidationError);
  });

  it("版本不符抛 FlowConflictError(expected/actual) 且不覆盖", async () => {
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
          expected_version: 5,
        },
        { turn_idx: 2 },
      ),
    );
    expect(error).toBeInstanceOf(FlowConflictError);
    if (error instanceof FlowConflictError) {
      expect(error.subject_id).toBe(created.subject.subject_id);
      expect(error.expected).toBe(5);
      expect(error.actual).toBe(1);
    }
    const stored = await store.get(created.subject.subject_id);
    expect(stored?.version).toBe(1);
    expect(stored?.state).toBe("active");
  });

  it("subject_name 不可变", async () => {
    const { store } = harness();
    const created = await store.commit(
      "s1",
      { subject_name: "原名", state: "active" },
      { turn_idx: 1 },
    );
    const error = await captureError(
      store.commit(
        "s1",
        {
          subject_id: created.subject.subject_id,
          subject_name: "新名",
          state: "active",
          expected_version: 1,
        },
        { turn_idx: 2 },
      ),
    );
    expect(error).toBeInstanceOf(FlowValidationError);
    expect((error as FlowValidationError).field).toBe("subject_name");
    expect((await store.get(created.subject.subject_id))?.subject_name).toBe("原名");
  });
});

describe("closed 与版本", () => {
  it("closed 后拒绝任何后续提交，版本停在关闭时", async () => {
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
      },
      { turn_idx: 2 },
    );
    expect(closed.subject.state).toBe("closed");
    expect(closed.subject.closed_at).toBe(NOW + 1_000);
    expect(closed.subject.close_reason).toBe("完成");
    expect(closed.subject.next_decision_at).toBeNull();
    expect(closed.subject.version).toBe(2);

    const error = await captureError(
      store.commit(
        "s1",
        {
          subject_id: created.subject.subject_id,
          state: "active",
          expected_version: 2,
        },
        { turn_idx: 3 },
      ),
    );
    expect(error).toBeInstanceOf(FlowClosedError);
    expect((await store.get(created.subject.subject_id))?.version).toBe(2);
  });

  it("版本每次受理提交单调 +1，last_commit 跟随回合", async () => {
    const { store, clock } = harness();
    const created = await store.commit(
      "s1",
      { subject_name: "版本", state: "active" },
      { turn_idx: 1 },
    );
    let current = created.subject;
    for (let step = 1; step <= 3; step += 1) {
      clock.now += 1_000;
      const result = await store.commit(
        "s1",
        {
          subject_id: current.subject_id,
          state: step % 2 === 0 ? "waiting_user" : "active",
          expected_version: current.version,
          notes_append: [`n${step}`],
        },
        { turn_idx: step + 1 },
      );
      expect(result.subject.version).toBe(current.version + 1);
      expect(result.subject.last_commit).toEqual({ turn_idx: step + 1, at: clock.now });
      expect(result.subject.updated_at).toBe(clock.now);
      current = result.subject;
    }
    expect(current.version).toBe(4);
  });
});

describe("限额", () => {
  it("maxActive=10：第 11 个 active 拒绝，waiting→active 同样拒绝", async () => {
    const { store } = harness();
    for (let i = 0; i < FLOW_LIMITS.maxActive; i += 1) {
      await store.commit("s1", { subject_name: `A${i}`, state: "active" }, { turn_idx: 1 });
    }
    const waiting = await store.commit(
      "s1",
      { subject_name: "W", state: "waiting_event" },
      { turn_idx: 1 },
    );

    const createError = await captureError(
      store.commit("s1", { subject_name: "A10", state: "active" }, { turn_idx: 1 }),
    );
    expect(createError).toBeInstanceOf(FlowLimitError);
    if (createError instanceof FlowLimitError) {
      expect(createError.limit).toBe("maxActive");
      expect(createError.max).toBe(10);
      expect(createError.actual).toBe(11);
    }

    const updateError = await captureError(
      store.commit(
        "s1",
        {
          subject_id: waiting.subject.subject_id,
          state: "active",
          expected_version: 1,
        },
        { turn_idx: 2 },
      ),
    );
    expect(updateError).toBeInstanceOf(FlowLimitError);
    if (updateError instanceof FlowLimitError) {
      expect(updateError.limit).toBe("maxActive");
    }
    expect((await store.get(waiting.subject.subject_id))?.state).toBe("waiting_event");
  });

  it("maxWaiting=8：waiting_user/waiting_event 合计封顶", async () => {
    const { store } = harness();
    for (let i = 1; i <= 8; i += 1) {
      await store.commit(
        "s1",
        { subject_name: `W${i}`, state: i % 2 === 0 ? "waiting_event" : "waiting_user" },
        { turn_idx: 1 },
      );
    }
    const error = await captureError(
      store.commit("s1", { subject_name: "W9", state: "waiting_user" }, { turn_idx: 1 }),
    );
    expect(error).toBeInstanceOf(FlowLimitError);
    if (error instanceof FlowLimitError) {
      expect(error.limit).toBe("maxWaiting");
      expect(error.max).toBe(8);
      expect(error.actual).toBe(9);
    }
    expect(await store.list("s1")).toHaveLength(8);
  });

  it("maxSubjects=32：含 closed 在内行数封顶", async () => {
    const { store } = harness();
    for (let i = 0; i < FLOW_LIMITS.maxSubjects; i += 1) {
      await store.commit("s1", { subject_name: `C${i}`, state: "closed" }, { turn_idx: 1 });
    }
    const error = await captureError(
      store.commit("s1", { subject_name: "C32", state: "closed" }, { turn_idx: 1 }),
    );
    expect(error).toBeInstanceOf(FlowLimitError);
    if (error instanceof FlowLimitError) {
      expect(error.limit).toBe("maxSubjects");
      expect(error.actual).toBe(33);
    }
    expect(await store.list("s1")).toHaveLength(32);
  });
});

describe("notes 追加与边界", () => {
  it("notes_append 只追加、保序、不覆盖历史", async () => {
    const { store } = harness();
    const created = await store.commit(
      "s1",
      { subject_name: "甲", state: "active", notes_append: ["a", "b"] },
      { turn_idx: 1 },
    );
    const updated = await store.commit(
      "s1",
      {
        subject_id: created.subject.subject_id,
        state: "active",
        expected_version: 1,
        notes_append: ["c"],
      },
      { turn_idx: 2 },
    );
    expect(updated.subject.notes).toEqual(["a", "b", "c"]);
  });

  it("单条 note 超过 500 码点拒绝", async () => {
    const { store } = harness();
    const error = await captureError(
      store.commit(
        "s1",
        { subject_name: "甲", state: "active", notes_append: ["界".repeat(501)] },
        { turn_idx: 1 },
      ),
    );
    expect(error).toBeInstanceOf(FlowLimitError);
    if (error instanceof FlowLimitError) {
      expect(error.limit).toBe("maxNoteChars");
      expect(error.actual).toBe(501);
    }
  });

  it("notes 累计 UTF-8 字节超过 16384 拒绝（按字节而非码点）", async () => {
    const { store } = harness();
    const note = "界".repeat(500); // 500 码点 / 1500 字节
    const created = await store.commit(
      "s1",
      {
        subject_name: "甲",
        state: "active",
        notes_append: Array.from({ length: 10 }, () => note),
      },
      { turn_idx: 1 },
    );
    expect(created.subject.notes).toHaveLength(10);
    const error = await captureError(
      store.commit(
        "s1",
        {
          subject_id: created.subject.subject_id,
          state: "active",
          expected_version: 1,
          notes_append: [note],
        },
        { turn_idx: 2 },
      ),
    );
    expect(error).toBeInstanceOf(FlowLimitError);
    if (error instanceof FlowLimitError) {
      expect(error.limit).toBe("maxNotesBytes");
      expect(error.max).toBe(16_384);
      expect(error.actual).toBe(16_500);
    }
  });

  it("空白 note 拒绝", async () => {
    const { store } = harness();
    await expect(
      store.commit(
        "s1",
        { subject_name: "甲", state: "active", notes_append: ["   "] },
        { turn_idx: 1 },
      ),
    ).rejects.toBeInstanceOf(FlowValidationError);
  });

  it.each(["/etc/passwd", "C:\\notes\\a.md", "~/notes.md", "../escape.md", "notes/../x.md"])(
    "notes_ref %j 拒绝",
    async (ref) => {
      const { store } = harness();
      await expect(
        store.commit(
          "s1",
          { subject_name: "甲", state: "active", notes_ref: ref },
          { turn_idx: 1 },
        ),
      ).rejects.toBeInstanceOf(FlowValidationError);
      expect(await store.list("s1")).toHaveLength(0);
    },
  );

  it("工作区相对 notes_ref 可写可清空，缺省不改动", async () => {
    const { store } = harness();
    const created = await store.commit(
      "s1",
      { subject_name: "甲", state: "active", notes_ref: "notes/2026-10-23.md" },
      { turn_idx: 1 },
    );
    expect(created.subject.notes_ref).toBe("notes/2026-10-23.md");
    const kept = await store.commit(
      "s1",
      {
        subject_id: created.subject.subject_id,
        state: "waiting_user",
        expected_version: 1,
      },
      { turn_idx: 2 },
    );
    expect(kept.subject.notes_ref).toBe("notes/2026-10-23.md");
    const cleared = await store.commit(
      "s1",
      {
        subject_id: created.subject.subject_id,
        state: "waiting_user",
        expected_version: 2,
        notes_ref: null,
      },
      { turn_idx: 3 },
    );
    expect(cleared.subject.notes_ref).toBeNull();
  });
});

describe("earliestPending", () => {
  it("只挑非 closed 且有 next_decision_at 的行；overdue 视为 now 立即返回", async () => {
    const { store } = harness();
    const a = await store.commit(
      "s1",
      { subject_name: "A", state: "active", next_decision_at: "1h" },
      { turn_idx: 1 },
    );
    const b = await store.commit(
      "s1",
      { subject_name: "B", state: "waiting_user", next_decision_at: "30m" },
      { turn_idx: 1 },
    );
    await store.commit("s1", { subject_name: "C", state: "waiting_event" }, { turn_idx: 1 });
    const d = await store.commit(
      "s1",
      { subject_name: "D", state: "active", next_decision_at: "10m" },
      { turn_idx: 1 },
    );
    await store.commit(
      "s1",
      { subject_id: d.subject.subject_id, state: "closed", expected_version: 1 },
      { turn_idx: 2 },
    );
    const e = await store.commit(
      "s1",
      { subject_name: "E", state: "active", next_decision_at: "10s" },
      { turn_idx: 1 },
    );

    expect((await store.earliestPending("s1"))?.subject_id).toBe(e.subject.subject_id);
    expect((await store.earliestPending("s1", NOW + 60_000))?.subject_id).toBe(
      e.subject.subject_id,
    );

    await store.commit(
      "s1",
      { subject_id: e.subject.subject_id, state: "closed", expected_version: 1 },
      { turn_idx: 2 },
    );
    expect((await store.earliestPending("s1"))?.subject_id).toBe(b.subject.subject_id);

    await store.commit(
      "s1",
      { subject_id: b.subject.subject_id, state: "closed", expected_version: 1 },
      { turn_idx: 2 },
    );
    expect((await store.earliestPending("s1"))?.subject_id).toBe(a.subject.subject_id);

    await store.commit(
      "s1",
      { subject_id: a.subject.subject_id, state: "closed", expected_version: 1 },
      { turn_idx: 2 },
    );
    expect(await store.earliestPending("s1")).toBeNull();
    expect(await store.earliestPending("empty")).toBeNull();
  });
});

describe("appendUnset", () => {
  it("记录 schema/session/at/turn/reason/had_tool_results，追加且不产生主体", async () => {
    const { store, clock } = harness();
    const first = await store.appendUnset("s1", {
      turn_idx: 7,
      reason: "no_commit",
      had_tool_results: true,
    });
    expect(first).toEqual({
      schema: 1,
      session_id: "s1",
      at: NOW,
      turn_idx: 7,
      reason: "no_commit",
      had_tool_results: true,
    });
    clock.now += 500;
    const second = await store.appendUnset("s1", {
      turn_idx: 8,
      reason: "run_end_no_commit",
      had_tool_results: false,
    });
    expect(second.at).toBe(NOW + 500);
    expect(second.reason).toBe("run_end_no_commit");
    expect(await store.list("s1")).toHaveLength(0);
    expect(await store.listSessionIds()).toEqual(["s1"]);
  });

  it("非法 reason 拒绝", async () => {
    const { store } = harness();
    const bad = {
      turn_idx: 1,
      reason: "bogus",
      had_tool_results: false,
    } as unknown as FlowUnsetInput;
    await expect(store.appendUnset("s1", bad)).rejects.toBeInstanceOf(FlowValidationError);
  });
});
