/**
 * legacy 旧日计划读写验收：两级形状兼容（Loom v1 严格 / dsh 宽松）、缺文件为 null、
 * 损坏与结构非法抛 PlanValidationError、母版 + 旧计划合并、撞 id 告警与有效条目字段。
 *
 * Loom 形状 fixture 先过 validatePlanDocument 再落盘（本地 helper，不复制 json-plan-store.ts）；
 * dsh 形状 fixture 直接写原始 JSON，模拟 kinship-plan 插件写出的真实文件。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  effectiveFromLegacyPlanWithMaster,
  readLegacyPlan,
  readLegacyPlanDetailed,
} from "../../packages/kinship-plan-scheduler/src/plan/legacy.js";
import type {
  MasterEntry,
  MasterPlanDocument,
} from "../../packages/kinship-plan-scheduler/src/plan/master-plan.js";
import {
  PlanValidationError,
  validatePlanDocument,
  type PlanDocument,
} from "../../packages/kinship-plan-scheduler/src/plan/plan-store.js";

const NOW = Date.UTC(2026, 10, 15, 4, 0, 0);
const DAY = "2026-11-15";
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "plan-legacy-"));
  roots.push(root);
  return root;
}

function planPath(root: string, date: string): string {
  return join(root, "daily", date, `plan-${date}.json`);
}

function writeRawPlan(root: string, date: string, value: unknown): void {
  const path = planPath(root, date);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

/** Loom v1 形状：先校验形状再落盘，落盘字节即真实 v1 文件形状。 */
function writeLoomPlan(root: string, document: PlanDocument): void {
  writeRawPlan(root, document.date, validatePlanDocument(document));
}

function masterEntry(overrides: Partial<MasterEntry> = {}): MasterEntry {
  return {
    id: "morning-review",
    kind: "fixed",
    title: "晨间复盘",
    enabled: true,
    action: "review.daily",
    schedule: { kind: "daily", at: "06:10" },
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function master(
  version = 3,
  entries: readonly MasterEntry[] = [
    masterEntry(),
    masterEntry({ id: "lunch-check", title: "午间检查", schedule: { kind: "daily", at: "12:00" } }),
  ],
): MasterPlanDocument {
  return {
    schema: 1,
    kind: "master-plan",
    timezone: "Asia/Shanghai",
    version,
    created_at: NOW,
    updated_at: NOW,
    entries,
  };
}

function loomPlan(overrides: Partial<PlanDocument> = {}): PlanDocument {
  return {
    schema: 1,
    date: DAY,
    status: "draft",
    version: 4,
    created_at: NOW,
    updated_at: NOW,
    review_at: "07:30",
    items: [{ id: "legacy-item", kind: "care", intent: "旧计划条目", status: "planned" }],
    coverage: { profile: "merged_7", checkpoints: ["cov-06"], debt: [] },
    notes: ["旧计划备注"],
    ...overrides,
  };
}

/** 真实 dsh 形状：无 coverage、带 carry_over、items 无 title/at 且夹带未知键。 */
function dshPlan(): Record<string, unknown> {
  return {
    schema: 1,
    date: DAY,
    status: "committed",
    version: 7,
    created_at: NOW,
    updated_at: NOW + 60_000,
    review_at: "08:15",
    items: [
      { id: "dsh-note", kind: "note", intent: "dsh 写出的备注", status: "planned", note: "备注" },
      {
        id: "dsh-care",
        kind: "care",
        intent: "dsh 写出的照护",
        status: "done",
        window: "08:00~09:00",
        done_when: "09:00 前完成",
        source: "loom",
        done_at: "2026-11-15T09:00:00+08:00",
        evidence: "已完成",
      },
    ],
    notes: ["dsh 备注"],
    carry_over: { to: "2026-11-16", created_at: NOW, items: [] },
    extra_top_level: { anything: true },
  };
}

describe("readLegacyPlan", () => {
  it("缺文件返回 null 且不创建任何目录", () => {
    const root = tempRoot();
    expect(readLegacyPlan(root, DAY)).toBeNull();
    expect(readLegacyPlanDetailed(root, DAY)).toBeNull();
    expect(existsSync(join(root, "daily"))).toBe(false);
  });

  it("损坏 JSON 抛 PlanValidationError", () => {
    const root = tempRoot();
    const path = planPath(root, DAY);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not-json", "utf8");
    expect(() => readLegacyPlan(root, DAY)).toThrow(PlanValidationError);
    expect(() => readLegacyPlanDetailed(root, DAY)).toThrow(PlanValidationError);
  });

  it("非对象、items 非数组或条目 kind 未知都抛 PlanValidationError", () => {
    const root = tempRoot();
    writeRawPlan(root, DAY, []);
    expect(() => readLegacyPlan(root, DAY)).toThrow(PlanValidationError);

    writeRawPlan(root, DAY, { date: DAY, items: "nope" });
    expect(() => readLegacyPlan(root, DAY)).toThrow(PlanValidationError);

    writeRawPlan(root, DAY, {
      date: DAY,
      items: [{ id: "x", kind: "weird", status: "planned", intent: "未知 kind" }],
    });
    expect(() => readLegacyPlan(root, DAY)).toThrow(PlanValidationError);

    writeRawPlan(root, DAY, { date: DAY, status: "weird", items: [] });
    expect(() => readLegacyPlan(root, DAY)).toThrow(PlanValidationError);
  });

  it("日期与请求日不一致抛 PlanValidationError", () => {
    const root = tempRoot();
    writeRawPlan(root, DAY, loomPlan({ date: "2026-11-14" }));
    expect(() => readLegacyPlan(root, DAY)).toThrow(PlanValidationError);
  });

  it("Loom v1 形状严格通过，coerced=false 且不加 legacy_coerced", () => {
    const root = tempRoot();
    const document = loomPlan();
    writeLoomPlan(root, document);
    const detailed = readLegacyPlanDetailed(root, DAY);
    expect(detailed?.coerced).toBe(false);
    expect(detailed?.document).toEqual(validatePlanDocument(document));
    expect(readLegacyPlan(root, DAY)).toEqual(validatePlanDocument(document));

    const legacy = readLegacyPlan(root, DAY);
    if (legacy === null) throw new Error("Loom v1 计划未被读取");
    expect(effectiveFromLegacyPlanWithMaster(legacy, master()).warnings).toEqual([
      "legacy_fallback",
    ]);
  });

  it("dsh 形状被兼容：丢掉 coverage/carry_over/未知键，保留 id/kind/status", () => {
    const root = tempRoot();
    writeRawPlan(root, DAY, dshPlan());
    const detailed = readLegacyPlanDetailed(root, DAY);
    expect(detailed?.coerced).toBe(true);
    if (detailed === null) throw new Error("dsh 计划未被读取");
    const document = detailed.document;

    expect(document.status).toBe("committed");
    expect(document.version).toBe(7);
    expect(document.review_at).toBe("08:15");
    expect(document.notes).toEqual(["dsh 备注"]);
    expect(document.coverage).toEqual({ profile: "merged_7", checkpoints: [], debt: [] });
    expect(document.items.map((item) => [item.id, item.kind, item.status])).toEqual([
      ["dsh-note", "note", "planned"],
      ["dsh-care", "care", "done"],
    ]);
    expect(document.items[1]?.window).toBe("08:00~09:00");
    expect(document.items[1]?.done_when).toBe("09:00 前完成");

    expect(Object.keys(document).sort()).toEqual([
      "coverage",
      "created_at",
      "date",
      "items",
      "notes",
      "review_at",
      "schema",
      "status",
      "updated_at",
      "version",
    ]);
    expect("carry_over" in document).toBe(false);
    expect("extra_top_level" in document).toBe(false);
    expect(document.items[0]).not.toHaveProperty("title");
    expect(document.items[0]).not.toHaveProperty("at");
    expect(document.items[1]).not.toHaveProperty("source");
    expect(document.items[1]).not.toHaveProperty("evidence");
    expect(document.items[1]).not.toHaveProperty("done_at");

    // 兼容层刻意保留 dsh 的宽松取值（空 coverage.checkpoints），因此不再满足 Loom 严格校验。
    expect(() => validatePlanDocument(document)).toThrow(PlanValidationError);
  });

  it("dsh 形状缺省字段按兼容口径补齐（date 用请求日、intent 空串、review_at 回落）", () => {
    const root = tempRoot();
    writeRawPlan(root, DAY, {
      items: [
        { id: "only-item", kind: "note", status: "planned" },
        { id: "no-intent", kind: "care", status: "skipped" },
      ],
      review_at: "not-a-clock",
    });
    const detailed = readLegacyPlanDetailed(root, DAY);
    expect(detailed?.coerced).toBe(true);
    if (detailed === null) throw new Error("dsh 计划未被读取");
    const document = detailed.document;

    expect(document.date).toBe(DAY);
    expect(document.status).toBe("committed");
    expect(document.version).toBe(1);
    expect(document.created_at).toBe(0);
    expect(document.updated_at).toBe(0);
    expect(document.review_at).toBe("07:30");
    expect(document.notes).toEqual([]);
    expect(document.coverage).toEqual({ profile: "merged_7", checkpoints: [], debt: [] });
    expect(document.items.map((item) => item.intent)).toEqual(["", ""]);
  });
});

describe("effectiveFromLegacyPlanWithMaster", () => {
  it("合并母版条目与旧计划条目：at 来自母版 schedule、status 来自旧计划", () => {
    const legacy = validatePlanDocument(
      loomPlan({
        items: [{ id: "legacy-item", kind: "care", intent: "旧计划条目", status: "skipped" }],
      }),
    );
    const effective = effectiveFromLegacyPlanWithMaster(legacy, master());

    expect(effective.origin).toBe("legacy");
    expect(effective.date).toBe(DAY);
    expect(effective.status).toBe("draft");
    expect(effective.base_version).toBe(3);
    expect(effective.master_version).toBe(3);
    expect(effective.overlay_version).toBe(4);
    expect(effective.coverage).toEqual(legacy.coverage);
    expect(effective.notes).toEqual(["旧计划备注"]);
    expect(effective.warnings).toEqual(["legacy_fallback"]);
    expect(effective.entries.map((row) => row.id)).toEqual([
      "morning-review",
      "lunch-check",
      "legacy-item",
    ]);

    const byId = new Map(effective.entries.map((row) => [row.id, row]));
    const base = byId.get("morning-review");
    expect(base?.source).toBe("master");
    expect(base?.at).toBe("06:10");
    expect(base?.status).toBe("planned");
    expect(base?.at_override).toBe(false);
    expect(base?.suppressed).toBe(false);
    expect(base?.master_version).toBe(3);
    expect(base?.overlay_version).toBe(4);

    const item = byId.get("legacy-item");
    expect(item?.source).toBe("legacy");
    expect(item?.at).toBeUndefined();
    expect(item?.status).toBe("skipped");
    expect(item?.kind).toBe("care");
    expect(item?.intent).toBe("旧计划条目");
    expect(item?.at_override).toBe(false);
    expect(item?.suppressed).toBe(false);
  });

  it("旧条目与母版 id 冲突时跳过并记 legacy_collision:<id>", () => {
    const legacy = validatePlanDocument(
      loomPlan({
        items: [
          { id: "morning-review", kind: "care", intent: "撞 id", status: "planned" },
          { id: "legacy-item", kind: "note", intent: "独立条目", status: "planned" },
        ],
      }),
    );
    const effective = effectiveFromLegacyPlanWithMaster(legacy, master());

    expect(effective.warnings).toEqual(["legacy_fallback", "legacy_collision:morning-review"]);
    expect(effective.entries.map((row) => row.id)).toEqual([
      "morning-review",
      "lunch-check",
      "legacy-item",
    ]);
    const collided = effective.entries.filter((row) => row.id === "morning-review");
    expect(collided).toHaveLength(1);
    expect(collided[0]?.source).toBe("master");
    expect(collided[0]?.at).toBe("06:10");
  });

  it("dsh 兼容文档追加 legacy_coerced 告警且条目改用 dsh 语义", () => {
    const root = tempRoot();
    writeRawPlan(root, DAY, dshPlan());
    const legacy = readLegacyPlan(root, DAY);
    if (legacy === null) throw new Error("dsh 计划未被读取");

    const effective = effectiveFromLegacyPlanWithMaster(legacy, master());
    expect(effective.warnings).toEqual(["legacy_fallback", "legacy_coerced"]);
    expect(effective.entries.map((row) => row.id)).toEqual([
      "morning-review",
      "lunch-check",
      "dsh-note",
      "dsh-care",
    ]);

    const care = effective.entries.find((row) => row.id === "dsh-care");
    expect(care?.source).toBe("legacy");
    expect(care?.status).toBe("done");
    expect(care?.at).toBeUndefined();
    expect(care?.window).toBe("08:00~09:00");
    expect(care?.overlay_version).toBe(7);
  });

  it("合并不改写入参文档", () => {
    const legacy = validatePlanDocument(loomPlan());
    const masterDoc = master();
    const beforeLegacy = JSON.stringify(legacy);
    const beforeMaster = JSON.stringify(masterDoc);

    effectiveFromLegacyPlanWithMaster(legacy, masterDoc);

    expect(JSON.stringify(legacy)).toBe(beforeLegacy);
    expect(JSON.stringify(masterDoc)).toBe(beforeMaster);
  });
});
