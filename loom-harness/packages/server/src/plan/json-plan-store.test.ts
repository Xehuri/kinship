/**
 * JsonPlanStore 验收（Todo 9）：
 * JSON 真源 + MD 渲染 + 审计 append-only；CAS 修订/收口；
 * 路径安全（日期穿越、符号链接越界）；全部落在 mkdtemp 临时根。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JsonPlanStore } from "./json-plan-store.js";
import {
  PlanClosedError,
  PlanConflictError,
  PlanNotFoundError,
  PlanValidationError,
  type PlanAuditRecord,
  type PlanItem,
  type PlanItemStatus,
  type PlanWriteInput,
} from "./plan-store.js";

const DATE = "2026-10-28";
const NOW = Date.UTC(2026, 9, 27, 21, 0, 0);

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "plan-store-"));
  roots.push(root);
  return root;
}

function dayDir(root: string, date = DATE): string {
  return join(root, "daily", date);
}

function jsonPath(root: string, date = DATE): string {
  return join(dayDir(root, date), `plan-${date}.json`);
}

function markdownPath(root: string, date = DATE): string {
  return join(dayDir(root, date), `计划-${date}.md`);
}

function auditPath(root: string, date = DATE): string {
  return join(dayDir(root, date), `plan-${date}.audit.jsonl`);
}

function readAudit(root: string, date = DATE): PlanAuditRecord[] {
  const content = readFileSync(auditPath(root, date), "utf8").trim();
  if (content === "") return [];
  return content
    .split("\n")
    .map((line) => JSON.parse(line) as PlanAuditRecord);
}

function careItem(
  id: string,
  intent: string,
  status: PlanItemStatus = "planned",
  extras: {
    readonly window?: string;
    readonly target_date?: string;
    readonly done_when?: string;
    readonly not_do?: readonly string[];
    readonly source?: string;
    readonly note?: string;
  } = {},
): PlanItem {
  return {
    id,
    kind: "care",
    intent,
    status,
    ...(extras.window === undefined ? {} : { window: extras.window }),
    ...(extras.target_date === undefined ? {} : { target_date: extras.target_date }),
    ...(extras.done_when === undefined ? {} : { done_when: extras.done_when }),
    ...(extras.not_do === undefined ? {} : { not_do: extras.not_do }),
    ...(extras.source === undefined ? {} : { source: extras.source }),
    ...(extras.note === undefined ? {} : { note: extras.note }),
  };
}

function basePlan(): PlanWriteInput {
  return {
    date: DATE,
    status: "draft",
    review_at: "07:30",
    items: [
      careItem("c1", "材料提交", "planned", {
        window: "09:30~11:00",
        done_when: "材料提交成功",
        not_do: ["不主动提理发", "不催简历"],
        source: "chat",
        note: "截止日期快到了",
      }),
      {
        id: "cov-00",
        kind: "coverage",
        intent: "00 点覆盖昨日夜窗",
        status: "planned",
        target_date: "2026-10-27",
        window: "22:00~00:00",
        checkpoint_id: "cov-00",
        done_when: "check_coverage exit 0",
      },
      {
        id: "cov-06",
        kind: "coverage",
        intent: "06 点覆盖",
        status: "planned",
        target_date: DATE,
        window: "00:00~06:00",
        checkpoint_id: "cov-06",
        done_when: "check_coverage exit 0",
      },
    ],
    coverage: {
      profile: "merged_7",
      checkpoints: [
        "cov-00",
        "cov-06",
        "cov-08",
        "cov-12",
        "cov-16",
        "cov-20",
        "cov-22",
      ],
      debt: [],
    },
    notes: ["昨晚睡 6 小时"],
  };
}

describe("创建 / 读取 round trip", () => {
  it("写 JSON + 渲染 MD + 追加审计，读回与写入完全一致", async () => {
    const root = tempRoot();
    const store = new JsonPlanStore({ planRoot: root, now: () => NOW });
    const input = basePlan();
    const written = await store.write(input);

    expect(written).toMatchObject({
      schema: 1,
      date: DATE,
      status: "draft",
      version: 1,
      created_at: NOW,
      updated_at: NOW,
      review_at: "07:30",
    });
    expect(written.items).toEqual(input.items);
    expect(written.coverage).toEqual(input.coverage);
    expect(written.notes).toEqual(input.notes);

    expect(await store.read(DATE)).toEqual(written);
    expect(JSON.parse(readFileSync(jsonPath(root), "utf8"))).toEqual(written);

    const markdown = readFileSync(markdownPath(root), "utf8");
    expect(markdown).toContain(`# ${DATE} 计划`);
    expect(markdown).toContain("- 状态: draft");
    expect(markdown).toContain("- 覆盖档: merged_7");
    expect(markdown).toContain("### c1 [care] 材料提交");
    expect(markdown).toContain("- 目标日期: 2026-10-27");
    expect(markdown).toContain("- 不做: 不主动提理发 | 不催简历");
    expect(markdown).toContain("- 来源: chat");

    const audit = readAudit(root);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      schema: 1,
      date: DATE,
      action: "write",
      at: NOW,
      version: 1,
      expected_version: null,
      reason: null,
    });

    expect(readdirSync(dayDir(root)).sort()).toEqual(
      [`plan-${DATE}.audit.jsonl`, `plan-${DATE}.json`, `计划-${DATE}.md`].sort(),
    );
  });

  it("同名计划已存在时二次 write 冲突且不覆盖", async () => {
    const root = tempRoot();
    const store = new JsonPlanStore({ planRoot: root, now: () => NOW });
    const first = await store.write(basePlan());
    await expect(store.write({ ...basePlan(), notes: ["新草稿"] })).rejects.toMatchObject({
      name: "PlanConflictError",
      date: DATE,
      expected: 0,
      actual: 1,
    });
    expect(await store.read(DATE)).toEqual(first);
    expect(readAudit(root)).toHaveLength(1);
  });
});

describe("revise CAS", () => {
  it("当前版本可修订并 +1；ops 与 patch 两种形态都落盘", async () => {
    const root = tempRoot();
    const clock = { now: NOW };
    const store = new JsonPlanStore({ planRoot: root, now: () => clock.now });
    await store.write(basePlan());

    clock.now = NOW + 1_000;
    const revised = await store.revise(
      DATE,
      1,
      [
        { op: "set_status", status: "committed" },
        { op: "upsert_item", item: careItem("c1", "材料提交", "done") },
        { op: "append_note", note: "09:40 已提交" },
      ],
      "用户确认材料已提交",
    );
    expect(revised.version).toBe(2);
    expect(revised.status).toBe("committed");
    expect(revised.updated_at).toBe(NOW + 1_000);
    expect(revised.items.find((item) => item.id === "c1")?.status).toBe("done");
    expect(revised.notes).toContain("09:40 已提交");
    expect(await store.read(DATE)).toEqual(revised);

    clock.now = NOW + 2_000;
    const patched = await store.revise(
      DATE,
      2,
      {
        review_at: "08:00",
        coverage: {
          profile: "merged_6",
          checkpoints: [
            "cov-night",
            "cov-08",
            "cov-12",
            "cov-16",
            "cov-20",
            "cov-22",
          ],
          debt: ["14:00~16:00"],
        },
        notes_append: ["再补一句"],
      },
      "切换合并档并记债",
    );
    expect(patched.version).toBe(3);
    expect(patched.review_at).toBe("08:00");
    expect(patched.coverage.profile).toBe("merged_6");
    expect(patched.coverage.debt).toEqual(["14:00~16:00"]);
    expect(patched.notes).toEqual(["昨晚睡 6 小时", "09:40 已提交", "再补一句"]);
    expect(await store.read(DATE)).toEqual(patched);

    const audit = readAudit(root);
    expect(audit).toHaveLength(3);
    expect(audit[1]).toMatchObject({
      action: "revise",
      version: 2,
      expected_version: 1,
      reason: "用户确认材料已提交",
    });
    expect(audit[2]).toMatchObject({
      action: "revise",
      version: 3,
      expected_version: 2,
      reason: "切换合并档并记债",
    });
  });

  it("陈旧版本冲突不改文件、不追加审计", async () => {
    const root = tempRoot();
    const store = new JsonPlanStore({ planRoot: root, now: () => NOW });
    await store.write(basePlan());
    await store.revise(DATE, 1, { notes_append: ["第一次"] }, "第一次修订");
    const before = readFileSync(jsonPath(root), "utf8");

    await expect(
      store.revise(DATE, 1, { notes_append: ["迟到"] }, "陈旧写入"),
    ).rejects.toMatchObject({
      name: "PlanConflictError",
      date: DATE,
      expected: 1,
      actual: 2,
    });
    expect(readFileSync(jsonPath(root), "utf8")).toBe(before);
    expect(readAudit(root)).toHaveLength(2);
    expect((await store.read(DATE)).version).toBe(2);
  });
});

describe("close 收口", () => {
  it("未完成项转 carried 并返回；done/carried 保持不变；closed 后只读", async () => {
    const root = tempRoot();
    const store = new JsonPlanStore({ planRoot: root, now: () => NOW });
    await store.write({
      ...basePlan(),
      items: [
        careItem("done-1", "已完成", "done"),
        careItem("plan-1", "没做", "planned"),
        careItem("skip-1", "主动跳过", "skipped"),
        careItem("block-1", "被阻塞", "blocked"),
        careItem("carry-1", "之前已带过来", "carried"),
      ],
    });

    const closed = await store.close(DATE, 1, "今天只完成一件");
    expect(closed.summary).toBe("今天只完成一件");
    expect(closed.plan.status).toBe("closed");
    expect(closed.plan.version).toBe(2);
    expect(closed.carried.map((item) => item.id)).toEqual(["plan-1", "skip-1", "block-1"]);
    expect(closed.carried.every((item) => item.status === "carried")).toBe(true);
    expect(closed.plan.items.map((item) => [item.id, item.status])).toEqual([
      ["done-1", "done"],
      ["plan-1", "carried"],
      ["skip-1", "carried"],
      ["block-1", "carried"],
      ["carry-1", "carried"],
    ]);
    expect(await store.read(DATE)).toEqual(closed.plan);

    const audit = readAudit(root);
    expect(audit).toHaveLength(2);
    expect(audit[1]).toMatchObject({
      action: "close",
      version: 2,
      expected_version: 1,
      reason: "今天只完成一件",
    });

    await expect(store.revise(DATE, 2, { notes_append: ["太晚"] }, "收口后修订")).rejects.toBeInstanceOf(
      PlanClosedError,
    );
    await expect(store.close(DATE, 2, "再收一次")).rejects.toBeInstanceOf(PlanClosedError);
  });

  it("陈旧版本 close 冲突", async () => {
    const root = tempRoot();
    const store = new JsonPlanStore({ planRoot: root, now: () => NOW });
    await store.write(basePlan());
    await store.revise(DATE, 1, { notes_append: ["一"] }, "先修订");
    await expect(store.close(DATE, 1, "收口")).rejects.toMatchObject({
      name: "PlanConflictError",
      expected: 1,
      actual: 2,
    });
    expect((await store.read(DATE)).status).toBe("draft");
  });
});

describe("缺失与路径安全", () => {
  it("文件不存在时 read/revise/close 抛 PlanNotFoundError 且不建目录", async () => {
    const root = tempRoot();
    const store = new JsonPlanStore({ planRoot: root, now: () => NOW });
    await expect(store.read(DATE)).rejects.toBeInstanceOf(PlanNotFoundError);
    await expect(store.revise(DATE, 1, { notes_append: ["x"] }, "改")).rejects.toBeInstanceOf(
      PlanNotFoundError,
    );
    await expect(store.close(DATE, 1, "收口")).rejects.toBeInstanceOf(PlanNotFoundError);
    expect(existsSync(join(root, "daily"))).toBe(false);
  });

  it("planRoot 必须是显式绝对目录", () => {
    const base = tempRoot();
    expect(() => new JsonPlanStore({ planRoot: "" })).toThrow(PlanValidationError);
    expect(() => new JsonPlanStore({ planRoot: "   " })).toThrow(PlanValidationError);
    expect(() => new JsonPlanStore({ planRoot: "relative/plan-root" })).toThrow(
      PlanValidationError,
    );
    expect(() => new JsonPlanStore({ planRoot: "./relative" })).toThrow(PlanValidationError);

    const fileRoot = join(base, "not-a-dir");
    writeFileSync(fileRoot, "x", "utf8");
    expect(() => new JsonPlanStore({ planRoot: fileRoot })).toThrow(PlanValidationError);
  });

  it("日期穿越/非法日期一律拒绝，且不在根外落任何文件", async () => {
    const root = tempRoot();
    const store = new JsonPlanStore({ planRoot: root, now: () => NOW });
    const badDates = [
      "../../escape",
      "..",
      ".",
      "/etc/passwd",
      "2026-10-28/../x",
      "2026-10-28\n",
      "2026-13-01",
      "2026-02-30",
      "2026-1-01",
      "26-10-28",
      "",
    ];
    for (const date of badDates) {
      await expect(store.read(date)).rejects.toBeInstanceOf(PlanValidationError);
      await expect(
        store.write({ ...basePlan(), date } as unknown as PlanWriteInput),
      ).rejects.toBeInstanceOf(PlanValidationError);
      await expect(
        store.appendAudit(date, { action: "revise", version: 1 }),
      ).rejects.toBeInstanceOf(PlanValidationError);
    }
    expect(existsSync(join(root, "daily"))).toBe(false);
  });

  it("daily/{date} 指向根外时读与写都拒绝，外部目录保持为空", async () => {
    const root = tempRoot();
    const outside = tempRoot();
    mkdirSync(join(root, "daily"), { recursive: true });
    symlinkSync(outside, join(root, "daily", DATE), "dir");
    const store = new JsonPlanStore({ planRoot: root, now: () => NOW });

    await expect(store.write(basePlan())).rejects.toBeInstanceOf(PlanValidationError);
    await expect(store.read(DATE)).rejects.toBeInstanceOf(PlanValidationError);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("目标路径被目录占用时失败且不留 tmp/MD/审计", async () => {
    const root = tempRoot();
    const store = new JsonPlanStore({ planRoot: root, now: () => NOW });
    mkdirSync(jsonPath(root), { recursive: true });
    await expect(store.write(basePlan())).rejects.toBeInstanceOf(PlanValidationError);
    const names = readdirSync(dayDir(root));
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(existsSync(markdownPath(root))).toBe(false);
    expect(existsSync(auditPath(root))).toBe(false);

    rmSync(jsonPath(root), { recursive: true, force: true });
    const written = await store.write(basePlan());
    expect(written.version).toBe(1);
    expect(await store.read(DATE)).toEqual(written);
  });
});

describe("schema 校验", () => {
  it("非法 coverage profile / item 字段 / 重复 id / 非法 review_at 拒绝写入", async () => {
    const root = tempRoot();
    const store = new JsonPlanStore({ planRoot: root, now: () => NOW });

    await expect(
      store.write({
        ...basePlan(),
        coverage: {
          profile: "merged_10",
          checkpoints: ["cov-00"],
          debt: [],
        },
      } as unknown as PlanWriteInput),
    ).rejects.toMatchObject({ name: "PlanValidationError", field: "coverage.profile" });

    await expect(
      store.write({
        ...basePlan(),
        items: [{ ...careItem("c1", "材料提交"), kind: "chore" } as unknown as PlanItem],
      }),
    ).rejects.toBeInstanceOf(PlanValidationError);

    await expect(
      store.write({
        ...basePlan(),
        items: [{ ...careItem("c1", "材料提交"), status: "pending" } as unknown as PlanItem],
      }),
    ).rejects.toBeInstanceOf(PlanValidationError);

    await expect(
      store.write({
        ...basePlan(),
        items: [careItem("dup", "一"), careItem("dup", "二")],
      }),
    ).rejects.toMatchObject({ name: "PlanValidationError", field: "items.id" });

    await expect(
      store.write({ ...basePlan(), review_at: "7:30" }),
    ).rejects.toBeInstanceOf(PlanValidationError);

    await expect(
      store.write({
        ...basePlan(),
        items: [careItem("c1", "材料", "planned", { target_date: "../../etc" })],
      }),
    ).rejects.toBeInstanceOf(PlanValidationError);
  });

  it("磁盘 JSON 损坏/版本不符/日期不符/未知字段都被 read 拒绝", async () => {
    const root = tempRoot();
    const store = new JsonPlanStore({ planRoot: root, now: () => NOW });
    const written = await store.write(basePlan());
    const file = jsonPath(root);

    writeFileSync(file, JSON.stringify({ ...written, schema: 2 }), "utf8");
    await expect(store.read(DATE)).rejects.toBeInstanceOf(PlanValidationError);

    writeFileSync(file, JSON.stringify({ ...written, date: "2026-10-29" }), "utf8");
    await expect(store.read(DATE)).rejects.toBeInstanceOf(PlanValidationError);

    writeFileSync(file, JSON.stringify({ ...written, extra: true }), "utf8");
    await expect(store.read(DATE)).rejects.toBeInstanceOf(PlanValidationError);

    writeFileSync(file, JSON.stringify(written), "utf8");
    writeFileSync(file, "{", "utf8");
    await expect(store.read(DATE)).rejects.toBeInstanceOf(PlanValidationError);

    writeFileSync(file, JSON.stringify(written), "utf8");
    expect(await store.read(DATE)).toEqual(written);
  });
});

describe("appendAudit", () => {
  it("独立追加多行；不要求计划文件存在；非法 action/version 拒绝", async () => {
    const root = tempRoot();
    const store = new JsonPlanStore({ planRoot: root, now: () => NOW });

    const first = await store.appendAudit(DATE, {
      action: "revise",
      version: 2,
      expected_version: 1,
      reason: "手动补记",
    });
    expect(first).toMatchObject({
      schema: 1,
      date: DATE,
      action: "revise",
      at: NOW,
      version: 2,
      expected_version: 1,
      reason: "手动补记",
    });
    await store.appendAudit(DATE, { action: "close", version: 3, reason: "收口" });
    expect(existsSync(jsonPath(root))).toBe(false);
    expect(readAudit(root)).toHaveLength(2);
    expect(readAudit(root)[1]).toMatchObject({
      action: "close",
      version: 3,
      expected_version: null,
      reason: "收口",
    });

    await expect(
      store.appendAudit(DATE, { action: "bogus", version: 1 } as unknown as {
        action: "revise";
        version: number;
      }),
    ).rejects.toBeInstanceOf(PlanValidationError);
    await expect(store.appendAudit(DATE, { action: "revise", version: 0 })).rejects.toBeInstanceOf(
      PlanValidationError,
    );
  });
});
