/**
 * flow_list / flow_get 只读工具验收：空表、排序、过滤、分页、笔记切片、跨会话隔离、
 * 中文时区渲染、信封截断与只读不变量。
 */

import { describe, expect, it } from "vitest";
import type { HookContext } from "../hook.js";
import { createTestContext } from "../testing.js";
import type { HarnessTool, ToolExecResult } from "../types.js";
import { MemoryFlowStore } from "./memory-store.js";
import {
  FLOW_GET_TOOL_NAME,
  FLOW_LIST_TOOL_NAME,
  FlowGetTool,
  FlowListTool,
  createFlowReadTools,
} from "./read-tools.js";
import { FLOW_COMMIT_SLOT } from "./slot.js";
import { formatFlowTime } from "./time.js";
import type { FlowCommitInput, FlowSubject } from "./types.js";

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const SIGNAL = new AbortController().signal;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface Harness {
  readonly store: MemoryFlowStore;
  readonly ctx: HookContext;
  readonly list: HarnessTool;
  readonly get: HarnessTool;
}

function harness(sessionId = "s1"): Harness {
  let nextId = 0;
  const store = new MemoryFlowStore({
    now: () => NOW,
    idFactory: () => `flow_${(nextId++).toString(16).padStart(12, "0")}`,
  });
  const ctx = createTestContext({ sessionId, turnIdx: 0 });
  return {
    store,
    ctx: ctx.ctx,
    list: FlowListTool({ store }),
    get: FlowGetTool({ store }),
  };
}

async function seed(
  store: MemoryFlowStore,
  sessionId: string,
  input: FlowCommitInput,
  turnIdx = 0,
): Promise<FlowSubject> {
  const result = await store.commit(sessionId, input, {
    turn_idx: turnIdx,
    now: NOW,
  });
  return result.subject;
}

function textOf(result: ToolExecResult): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

interface ListSubjectDetail {
  readonly subject_id: string;
  readonly subject_name: string;
  readonly kind: string;
  readonly title: string;
  readonly state: string;
  readonly focus: string;
  readonly version: number;
  readonly next_decision_at: number | null;
  readonly updated_at: number;
  readonly last_commit_turn: number | null;
  readonly notes_count: number;
  readonly latest_note: string | null;
}

interface ListDetails {
  readonly total: number;
  readonly shown: number;
  readonly offset: number;
  readonly has_more: boolean;
  readonly subjects: readonly ListSubjectDetail[];
}

interface GetDetails {
  readonly subject: FlowSubject;
  readonly notes: readonly string[];
  readonly notes_total: number;
  readonly notes_offset: number;
  readonly notes_truncated: boolean;
}

function listFlow(result: ToolExecResult): ListDetails {
  const details = result.details as { __flow?: ListDetails } | undefined;
  if (details?.__flow === undefined) throw new Error("missing details.__flow");
  return details.__flow;
}

function getFlow(result: ToolExecResult): GetDetails {
  const details = result.details as { __flow?: GetDetails } | undefined;
  if (details?.__flow === undefined) throw new Error("missing details.__flow");
  return details.__flow;
}

function errorName(result: ToolExecResult): string | undefined {
  const details = result.details as
    | { __flow?: { error?: string } }
    | undefined;
  return details?.__flow?.error;
}

describe("flow_list", () => {
  it("空 session 返回零行零 total", async () => {
    const h = harness();
    const result = await h.list.execute({}, h.ctx, SIGNAL);

    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe("flow_list: 0 subjects");
    expect(listFlow(result)).toEqual({
      total: 0,
      shown: 0,
      offset: 0,
      has_more: false,
      subjects: [],
    });
  });

  it("默认排除 closed，并按 focus、next_decision_at 排序", async () => {
    const h = harness();
    await seed(h.store, "s1", {
      subject_name: "背景",
      state: "active",
      focus: "background",
      next_decision_at: NOW + 2 * HOUR,
    });
    await seed(h.store, "s1", {
      subject_name: "前台晚",
      state: "active",
      focus: "foreground",
      next_decision_at: NOW + HOUR,
    });
    await seed(h.store, "s1", {
      subject_name: "前台早",
      state: "waiting_user",
      focus: "foreground",
      next_decision_at: NOW + 30 * MINUTE,
    });
    await seed(h.store, "s1", {
      subject_name: "关闭",
      state: "closed",
      focus: "foreground",
    });

    const result = await h.list.execute({}, h.ctx, SIGNAL);
    const details = listFlow(result);

    expect(result.isError).toBeUndefined();
    expect(details.total).toBe(3);
    expect(details.subjects.map((row) => row.subject_name)).toEqual([
      "前台早",
      "前台晚",
      "背景",
    ]);
    expect(textOf(result)).toContain(
      "flow_list: 3 subjects (active=2, waiting=1)",
    );
    expect(textOf(result)).not.toContain("关闭");
  });

  it("state/focus/kind 过滤与 include_closed", async () => {
    const h = harness();
    await seed(h.store, "s1", {
      subject_name: "活动前台",
      state: "active",
      focus: "foreground",
      kind: "thread",
    });
    await seed(h.store, "s1", {
      subject_name: "等待后台",
      state: "waiting_user",
      focus: "background",
      kind: "task",
    });
    await seed(h.store, "s1", {
      subject_name: "等待事件",
      state: "waiting_event",
      focus: "foreground",
      kind: "task",
    });
    await seed(h.store, "s1", {
      subject_name: "已结",
      state: "closed",
      focus: "foreground",
      kind: "thread",
    });

    const byState = await h.list.execute(
      { state: ["waiting_user"] },
      h.ctx,
      SIGNAL,
    );
    expect(
      listFlow(byState).subjects.map((row) => row.subject_name),
    ).toEqual(["等待后台"]);

    const byFocus = await h.list.execute(
      { focus: ["background"] },
      h.ctx,
      SIGNAL,
    );
    expect(listFlow(byFocus).subjects.map((row) => row.subject_name)).toEqual([
      "等待后台",
    ]);

    const byKind = await h.list.execute({ kind: "task" }, h.ctx, SIGNAL);
    expect(listFlow(byKind).subjects.map((row) => row.subject_name)).toEqual([
      "等待事件",
      "等待后台",
    ]);

    const withClosed = await h.list.execute(
      { include_closed: true },
      h.ctx,
      SIGNAL,
    );
    expect(listFlow(withClosed).total).toBe(4);
    expect(
      listFlow(withClosed).subjects.map((row) => row.subject_name),
    ).toEqual(["活动前台", "等待事件", "已结", "等待后台"]);

    const explicitClosed = await h.list.execute(
      { state: ["active", "closed"] },
      h.ctx,
      SIGNAL,
    );
    expect(
      listFlow(explicitClosed).subjects.map((row) => row.subject_name),
    ).toEqual(["活动前台", "已结"]);
  });

  it("limit/offset 分页与 has_more", async () => {
    const h = harness();
    for (let index = 0; index < 5; index += 1) {
      await seed(h.store, "s1", {
        subject_name: `序${index + 1}`,
        state: "active",
        focus: "foreground",
        next_decision_at: NOW + (index + 1) * 10 * MINUTE,
      });
    }

    const firstPage = await h.list.execute(
      { limit: 2, offset: 1 },
      h.ctx,
      SIGNAL,
    );
    const firstDetails = listFlow(firstPage);
    expect(firstDetails.total).toBe(5);
    expect(firstDetails.shown).toBe(2);
    expect(firstDetails.offset).toBe(1);
    expect(firstDetails.has_more).toBe(true);
    expect(firstDetails.subjects.map((row) => row.subject_name)).toEqual([
      "序2",
      "序3",
    ]);
    expect(textOf(firstPage)).toContain("其余 2 个未显示，offset=3 继续");

    const lastPage = await h.list.execute(
      { limit: 20, offset: 3 },
      h.ctx,
      SIGNAL,
    );
    expect(listFlow(lastPage).shown).toBe(2);
    expect(listFlow(lastPage).has_more).toBe(false);
    expect(
      listFlow(lastPage).subjects.map((row) => row.subject_name),
    ).toEqual(["序4", "序5"]);

    const badLimit = await h.list.execute({ limit: 0 }, h.ctx, SIGNAL);
    expect(badLimit.isError).toBe(true);
    expect(errorName(badLimit)).toBe("FlowValidationError");
    const badOffset = await h.list.execute({ offset: -1 }, h.ctx, SIGNAL);
    expect(badOffset.isError).toBe(true);
    expect(errorName(badOffset)).toBe("FlowValidationError");
  });

  it("latest_note 折叠换行并截断到 120 码点", async () => {
    const h = harness();
    await seed(h.store, "s1", {
      subject_name: "换行",
      state: "active",
      notes_append: ["第一行\n第二行"],
    });
    const long = "长".repeat(130);
    const target = await seed(h.store, "s1", {
      subject_name: "长记",
      state: "active",
      notes_append: ["短"],
    });
    await seed(
      h.store,
      "s1",
      {
        subject_id: target.subject_id,
        expected_version: 1,
        state: "active",
        notes_append: [long],
      },
      1,
    );

    const result = await h.list.execute({}, h.ctx, SIGNAL);
    const text = textOf(result);
    expect(text).toContain("第一行 第二行");
    expect(text).toContain(`${"长".repeat(120)}…`);
    expect(text.includes("长".repeat(121))).toBe(false);

    const row = listFlow(result).subjects.find(
      (item) => item.subject_name === "长记",
    );
    expect(row?.notes_count).toBe(2);
    expect(row?.latest_note).toBe(`${"长".repeat(120)}…`);
    expect(Array.from(row?.latest_note ?? "")).toHaveLength(121);
  });

  it("信封超限时丢行、标注截断并保持 has_more", async () => {
    const h = harness();
    for (let index = 0; index < 12; index += 1) {
      await seed(h.store, "s1", {
        subject_name: `关闭${index + 1}`,
        state: "closed",
        notes_append: ["长".repeat(120)],
      });
    }

    const result = await h.list.execute(
      { include_closed: true, limit: 32 },
      h.ctx,
      SIGNAL,
    );
    const details = listFlow(result);
    const text = textOf(result);

    expect(result.isError).toBeUndefined();
    expect(details.total).toBe(12);
    expect(details.shown).toBeLessThan(12);
    expect(details.subjects).toHaveLength(details.shown);
    expect(details.has_more).toBe(true);
    expect(text).toContain("输出已截断");
    expect(bytesOf(text)).toBeLessThanOrEqual(4096);
  });
});

describe("flow_get", () => {
  it("默认读主线，也支持按名称/按 id 读取", async () => {
    const h = harness();
    const main = await seed(h.store, "s1", {
      subject_name: "主线",
      state: "active",
      next_decision_at: NOW + HOUR,
      notes_append: ["主线笔记"],
    });
    const side = await seed(h.store, "s1", {
      subject_name: "副线",
      state: "waiting_user",
    });

    const byDefault = await h.get.execute({}, h.ctx, SIGNAL);
    expect(byDefault.isError).toBeUndefined();
    expect(getFlow(byDefault).subject.subject_id).toBe(main.subject_id);
    expect(getFlow(byDefault).subject.subject_name).toBe("主线");
    expect(textOf(byDefault)).toContain(main.subject_id);
    expect(textOf(byDefault)).toContain("主线笔记");

    const byName = await h.get.execute(
      { subject_name: "副线" },
      h.ctx,
      SIGNAL,
    );
    expect(getFlow(byName).subject.subject_id).toBe(side.subject_id);

    const byId = await h.get.execute(
      { subject_id: side.subject_id },
      h.ctx,
      SIGNAL,
    );
    expect(getFlow(byId).subject.subject_name).toBe("副线");
  });

  it("空 session 默认主线不存在时报 not-found", async () => {
    const h = harness();
    const result = await h.get.execute({}, h.ctx, SIGNAL);
    expect(result.isError).toBe(true);
    expect(errorName(result)).toBe("FlowNotFoundError");
    expect(textOf(result)).toContain("主线");
  });

  it("notes 从最新往前切片、按时间正序返回并标 truncated", async () => {
    const h = harness();
    await seed(h.store, "s1", {
      subject_name: "多笔记",
      state: "active",
      notes_append: ["n1", "n2", "n3", "n4", "n5", "n6", "n7"],
    });

    const tail = await h.get.execute({ subject_name: "多笔记" }, h.ctx, SIGNAL);
    const tailDetails = getFlow(tail);
    expect(tailDetails.notes).toEqual(["n3", "n4", "n5", "n6", "n7"]);
    expect(tailDetails.notes_total).toBe(7);
    expect(tailDetails.notes_offset).toBe(0);
    expect(tailDetails.notes_truncated).toBe(true);
    expect(textOf(tail)).toContain("[3] n3");
    expect(textOf(tail)).toContain("[7] n7");
    expect(textOf(tail)).not.toContain("[2] n2");

    const offset = await h.get.execute(
      { subject_name: "多笔记", notes_limit: 2, notes_offset: 2 },
      h.ctx,
      SIGNAL,
    );
    expect(getFlow(offset).notes).toEqual(["n4", "n5"]);
    expect(getFlow(offset).notes_offset).toBe(2);
    expect(getFlow(offset).notes_truncated).toBe(true);
    expect(textOf(offset)).toContain("[4] n4");
    expect(textOf(offset)).not.toContain("[3] n3");

    const all = await h.get.execute(
      { subject_name: "多笔记", notes_limit: 10, notes_offset: 0 },
      h.ctx,
      SIGNAL,
    );
    expect(getFlow(all).notes).toEqual([
      "n1",
      "n2",
      "n3",
      "n4",
      "n5",
      "n6",
      "n7",
    ]);
    expect(getFlow(all).notes_truncated).toBe(false);

    const hidden = await h.get.execute(
      { subject_name: "多笔记", include_notes: false },
      h.ctx,
      SIGNAL,
    );
    expect(getFlow(hidden).notes).toEqual([]);
    expect(getFlow(hidden).notes_total).toBe(7);
    expect(getFlow(hidden).notes_truncated).toBe(false);
    expect(textOf(hidden)).toContain("notes=7（未显示）");

    const beyond = await h.get.execute(
      { subject_name: "多笔记", notes_offset: 99 },
      h.ctx,
      SIGNAL,
    );
    expect(getFlow(beyond).notes).toEqual([]);
    expect(getFlow(beyond).notes_truncated).toBe(false);
  });

  it("closed 主体可读", async () => {
    const h = harness();
    const closed = await seed(h.store, "s1", {
      subject_name: "已结",
      state: "closed",
      close_reason: "完成",
      notes_append: ["收尾"],
    });

    const result = await h.get.execute(
      { subject_name: "已结" },
      h.ctx,
      SIGNAL,
    );
    expect(result.isError).toBeUndefined();
    expect(getFlow(result).subject.subject_id).toBe(closed.subject_id);
    expect(getFlow(result).subject.state).toBe("closed");
    expect(textOf(result)).toContain("state=closed");
    expect(textOf(result)).toContain("next=-");
  });

  it("id 与 name 同时给出且不匹配时拒绝", async () => {
    const h = harness();
    const main = await seed(h.store, "s1", {
      subject_name: "主线",
      state: "active",
    });

    const result = await h.get.execute(
      { subject_id: main.subject_id, subject_name: "另一个" },
      h.ctx,
      SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(errorName(result)).toBe("FlowValidationError");
    expect(textOf(result)).toContain("[flow:validation]");
    expect((await h.store.get(main.subject_id))?.subject_name).toBe("主线");
  });

  it("跨会话 id 视为不存在且不泄漏对方主体", async () => {
    const h = harness("s1");
    await seed(h.store, "s1", { subject_name: "自己的", state: "active" });
    const foreign = await seed(h.store, "s2", {
      subject_name: "别人的",
      state: "active",
    });

    const byId = await h.get.execute(
      { subject_id: foreign.subject_id },
      h.ctx,
      SIGNAL,
    );
    expect(byId.isError).toBe(true);
    expect(errorName(byId)).toBe("FlowNotFoundError");
    expect(textOf(byId)).not.toContain("别人的");

    const byName = await h.get.execute(
      { subject_name: "别人的" },
      h.ctx,
      SIGNAL,
    );
    expect(byName.isError).toBe(true);
    expect(errorName(byName)).toBe("FlowNotFoundError");

    const listed = await h.list.execute({}, h.ctx, SIGNAL);
    expect(listFlow(listed).subjects.map((row) => row.subject_name)).toEqual([
      "自己的",
    ]);
  });

  it("信封超限时丢最旧笔记、标 truncated 且文本不超上限", async () => {
    const h = harness();
    await seed(h.store, "s1", {
      subject_name: "长笔记",
      state: "active",
      notes_append: Array.from({ length: 10 }, () => "x".repeat(500)),
    });

    const result = await h.get.execute(
      { subject_name: "长笔记", notes_limit: 10 },
      h.ctx,
      SIGNAL,
    );
    const details = getFlow(result);
    const text = textOf(result);

    expect(result.isError).toBeUndefined();
    expect(details.notes_total).toBe(10);
    expect(details.notes.length).toBeLessThan(10);
    expect(details.notes.length).toBeGreaterThan(0);
    expect(details.notes_truncated).toBe(true);
    expect(text).toContain("已截断");
    expect(bytesOf(text)).toBeLessThanOrEqual(4096);
  });

  it("not-found 错误文本超长时仍受信封限制", async () => {
    const h = harness();
    const result = await h.get.execute(
      { subject_name: "x".repeat(5000) },
      h.ctx,
      SIGNAL,
    );

    expect(result.isError).toBe(true);
    expect(errorName(result)).toBe("FlowNotFoundError");
    expect(textOf(result)).toContain("已截断");
    expect(bytesOf(textOf(result))).toBeLessThanOrEqual(4096);
  });

  it("validation 错误文本超长时仍受信封限制", async () => {
    const h = harness();
    const result = await h.get.execute(
      { subject_id: "x".repeat(5000) },
      h.ctx,
      SIGNAL,
    );

    expect(result.isError).toBe(true);
    expect(errorName(result)).toBe("FlowValidationError");
    expect(textOf(result)).toContain("已截断");
    expect(bytesOf(textOf(result))).toBeLessThanOrEqual(4096);
  });

  it("长主体名导致笔记全丢时 notes_truncated=true 且文本标注截断", async () => {
    const h = harness();
    const name = "名".repeat(1000);
    await seed(h.store, "s1", {
      subject_name: name,
      state: "active",
      notes_append: ["记".repeat(500)],
    });

    const result = await h.get.execute(
      { subject_name: name, notes_limit: 10 },
      h.ctx,
      SIGNAL,
    );
    const details = getFlow(result);
    const text = textOf(result);

    expect(result.isError).toBeUndefined();
    expect(details.notes).toEqual([]);
    expect(details.notes_total).toBe(1);
    expect(details.notes_truncated).toBe(true);
    expect(text).toContain("原 1 条因长度未显示，已截断");
    expect(bytesOf(text)).toBeLessThanOrEqual(4096);
  });

  it("长主体名且无笔记：header-only 截断不置 notes_truncated", async () => {
    const h = harness();
    const name = "名".repeat(2000);
    await seed(h.store, "s1", { subject_name: name, state: "active" });

    const result = await h.get.execute({ subject_name: name }, h.ctx, SIGNAL);
    const details = getFlow(result);
    const text = textOf(result);

    expect(result.isError).toBeUndefined();
    expect(text).toContain("已截断");
    expect(details.notes).toEqual([]);
    expect(details.notes_total).toBe(0);
    expect(details.notes_truncated).toBe(false);
    expect(bytesOf(text)).toBeLessThanOrEqual(4096);
  });

  it("长主体名 + include_notes=false：不置 notes_truncated", async () => {
    const h = harness();
    const name = "名".repeat(2000);
    await seed(h.store, "s1", {
      subject_name: name,
      state: "active",
      notes_append: ["一条"],
    });

    const result = await h.get.execute(
      { subject_name: name, include_notes: false },
      h.ctx,
      SIGNAL,
    );
    const details = getFlow(result);

    expect(result.isError).toBeUndefined();
    expect(details.notes).toEqual([]);
    expect(details.notes_total).toBe(1);
    expect(details.notes_truncated).toBe(false);
    expect(bytesOf(textOf(result))).toBeLessThanOrEqual(4096);
  });

  it("details.notes 与文本一致：换行折叠为单行", async () => {
    const h = harness();
    await seed(h.store, "s1", {
      subject_name: "换行详情",
      state: "active",
      notes_append: ["第一行\n第二行"],
    });

    const result = await h.get.execute(
      { subject_name: "换行详情" },
      h.ctx,
      SIGNAL,
    );

    expect(getFlow(result).notes).toEqual(["第一行 第二行"]);
    expect(textOf(result)).toContain("[1] 第一行 第二行");
  });

  it("模型可见 next/updated/last_commit 使用 +08:00，不出现 Z", async () => {
    const h = harness();
    const next = Date.UTC(2026, 9, 23, 14, 11, 54, 267);
    await seed(h.store, "s1", {
      subject_name: "本地时间",
      state: "waiting_user",
      next_decision_at: next,
    });

    expect(formatFlowTime(next)).toBe("2026-10-23T22:11:54.267+08:00");

    const listed = await h.list.execute({}, h.ctx, SIGNAL);
    const listText = textOf(listed);
    expect(listText).toContain("next=2026-10-23T22:11:54.267+08:00");
    expect(listText).not.toMatch(/\.\d{3}Z/);

    const got = await h.get.execute(
      { subject_name: "本地时间" },
      h.ctx,
      SIGNAL,
    );
    const getText = textOf(got);
    expect(getText).toContain("next=2026-10-23T22:11:54.267+08:00");
    expect(getText).toContain("updated=2026-10-23T20:00:00.000+08:00");
    expect(getText).toContain("last_commit=2026-10-23T20:00:00.000+08:00");
    expect(getText).not.toMatch(/\.\d{3}Z/);
  });
});

describe("flow 只读工具形状", () => {
  it("createFlowReadTools 返回 flow_list/flow_get，且读工具不写版本/状态/提交槽", async () => {
    const h = harness();
    const store = h.store;
    const subject = await seed(store, "s1", {
      subject_name: "只读",
      state: "waiting_user",
      notes_append: ["一条"],
    });
    const before = JSON.stringify(await store.list("s1"));

    const tools = createFlowReadTools({ store });
    expect(tools.map((tool) => tool.name)).toEqual([
      FLOW_LIST_TOOL_NAME,
      FLOW_GET_TOOL_NAME,
    ]);
    expect(FLOW_LIST_TOOL_NAME).toBe("flow_list");
    expect(FLOW_GET_TOOL_NAME).toBe("flow_get");

    for (const tool of tools) {
      expect(tool.isReadOnly).toBe(true);
      expect(tool.isConcurrencySafe?.({})).toBe(true);
    }

    await h.list.execute({ include_closed: true }, h.ctx, SIGNAL);
    await h.get.execute({ subject_id: subject.subject_id }, h.ctx, SIGNAL);

    const after = JSON.stringify(await store.list("s1"));
    expect(after).toBe(before);
    const reloaded = await store.get(subject.subject_id);
    expect(reloaded?.version).toBe(1);
    expect(reloaded?.state).toBe("waiting_user");
    expect(h.ctx.state.get(FLOW_COMMIT_SLOT) ?? null).toBeNull();
  });
});
