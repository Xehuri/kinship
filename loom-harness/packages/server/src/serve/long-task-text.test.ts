/**
 * long_task 纯文本投影验收：record 头部/备注块/截断、list 头部与条目、
 * read 原样 Markdown。details 结构不在本文件断言（工具测试负责）。
 */

import { describe, expect, it } from "vitest";

import type { LongTask } from "../plan/long-task-store.js";
import {
  renderLongTaskList,
  renderLongTaskRead,
  renderLongTaskRecord,
} from "./long-task-text.js";

function task(overrides: Partial<LongTask> = {}): LongTask {
  return {
    schema: 1,
    id: "lt_weekly_review",
    title: "每周复盘",
    intent: "每周把这一周收一下，定下周三件事",
    cadence: "weekly",
    next_check: "2026-10-27",
    last_done: null,
    status: "active",
    review_policy: "after_done",
    notes: [],
    created_at: "2026-10-27T04:00:00.000Z",
    updated_at: "2026-10-27T04:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

describe("renderLongTaskRecord", () => {
  it("create：头部一行摘要 + intent，无备注时不渲染 notes 块", () => {
    expect(renderLongTaskRecord("create", task()).split("\n")).toEqual([
      "long_task create ok id=lt_weekly_review title=每周复盘 v1 status=active" +
        " cadence=weekly next_check=2026-10-27 review=after_done",
      "intent: 每周把这一周收一下，定下周三件事",
    ]);
  });

  it("last_done 非空时追加到头部行尾；last_done=null 时省略", () => {
    const done = renderLongTaskRecord(
      "update",
      task({ last_done: "2026-10-20", version: 2 }),
    ).split("\n");
    expect(done[0]).toBe(
      "long_task update ok id=lt_weekly_review title=每周复盘 v2 status=active" +
        " cadence=weekly next_check=2026-10-27 review=after_done last_done=2026-10-20",
    );
    expect(renderLongTaskRecord("create", task())).not.toContain("last_done=");
  });

  it("备注逐条列出；超过 10 条时只留前 10 条并标出省略数", () => {
    const notes = Array.from({ length: 13 }, (_, index) => `备注 ${String(index + 1)}`);
    const lines = renderLongTaskRecord("create", task({ notes })).split("\n");
    expect(lines[2]).toBe("notes 13:");
    expect(lines.slice(3, 13)).toEqual(notes.slice(0, 10).map((note) => `- ${note}`));
    expect(lines[13]).toBe("- …(+3)");
    expect(lines).toHaveLength(14);
  });

  it("标题/意图压平成单行并按上限截断", () => {
    const text = renderLongTaskRecord(
      "create",
      task({
        title: `第一行\n第二行 ${"长".repeat(200)}`,
        intent: "  a\r\nb  ",
      }),
    );
    expect(text).toContain("title=第一行 第二行 长");
    expect(text).toContain("…(+");
    expect(text).toContain("\nintent: a b");
  });
});

describe("renderLongTaskList", () => {
  it("due/date/count 头部 + 每任务一行", () => {
    const text = renderLongTaskList(
      [
        task(),
        task({
          id: "lt_daily_walk",
          title: "Daily Walk",
          cadence: "daily",
          next_check: "2026-10-28",
          version: 3,
        }),
      ],
      { due: "today", date: null },
    );
    expect(text.split("\n")).toEqual([
      "long_task list due=today date=store-today count=2",
      "- lt_weekly_review 每周复盘 v1 status=active cadence=weekly next_check=2026-10-27",
      "- lt_daily_walk Daily Walk v3 status=active cadence=daily next_check=2026-10-28",
    ]);
  });

  it("空列表：头部标 (no tasks)，不产生条目行", () => {
    const text = renderLongTaskList([], { due: "all", date: "2026-10-27" });
    expect(text).toBe("long_task list due=all date=2026-10-27 count=0 (no tasks)");
    expect(text.split("\n")).toHaveLength(1);
  });

  it("列表标题按 80 字符截断", () => {
    const text = renderLongTaskList([task({ title: "x".repeat(90) })], {
      due: "active",
      date: null,
    });
    expect(text).toContain(`${"x".repeat(80)}…(+10)`);
  });
});

describe("renderLongTaskRead", () => {
  it("只返回 Markdown 正文（去掉首尾空行），不附 JSON 头", () => {
    const markdown = "\n# 每周复盘\n\n- 任务 ID：`lt_weekly_review`\n\n## 意图\n\n内容\n\n";
    const text = renderLongTaskRead({ task: task(), markdown });
    expect(text).toBe("# 每周复盘\n\n- 任务 ID：`lt_weekly_review`\n\n## 意图\n\n内容");
  });
});
