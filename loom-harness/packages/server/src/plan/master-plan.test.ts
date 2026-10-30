/**
 * Master Plan schema 与纯函数的验收：未知键/重复 id/覆盖目标日校验、
 * 四类排班匹配、long_term 到期门槛、编辑 op 校验与不改原文档。
 */

import { describe, expect, it } from "vitest";

import {
  MasterPlanValidationError,
  applyMasterEditOps,
  materializeMasterEntries,
  renderMasterMarkdown,
  validateMasterEditOps,
  validateMasterPlanDocument,
  type MasterEntry,
  type MasterPlanDocument,
} from "./master-plan.js";

const NOW = Date.UTC(2026, 9, 27, 4, 0, 0);

function entry(overrides: Partial<MasterEntry> = {}): MasterEntry {
  return {
    id: "daily-review",
    kind: "fixed",
    title: "今日复盘",
    enabled: true,
    action: "review.daily",
    schedule: { kind: "daily", at: "00:40" },
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function doc(entries: readonly MasterEntry[] = [entry()]): MasterPlanDocument {
  return {
    schema: 1,
    kind: "master-plan",
    timezone: "Asia/Shanghai",
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    entries,
  };
}

describe("schema 校验", () => {
  it("接受完整文档并保留条目顺序", () => {
    const parsed = validateMasterPlanDocument(doc([entry(), entry({ id: "second" })]));
    expect(parsed.entries.map((row) => row.id)).toEqual(["daily-review", "second"]);
  });

  it("拒绝未知字段、重复 id 与非法 schema", () => {
    expect(() =>
      validateMasterPlanDocument({ ...doc(), extra: true }),
    ).toThrow(MasterPlanValidationError);
    expect(() =>
      validateMasterPlanDocument(doc([entry(), entry()])),
    ).toThrow(/重复 id/);
    expect(() => validateMasterPlanDocument({ ...doc(), schema: 2 })).toThrow(/只支持 1/);
  });

  it("previous_day 只允许用于 coverage.run", () => {
    expect(() =>
      validateMasterPlanDocument(doc([entry({ target_date: "previous_day" })])),
    ).toThrow(/previous_day/);
    const coverage = entry({
      id: "cov-00",
      kind: "anchor",
      action: "coverage.run",
      target_date: "previous_day",
      window: "22:00~00:00",
    });
    expect(validateMasterPlanDocument(doc([coverage])).entries[0]?.target_date).toBe("previous_day");
  });

  it("long_term 必须显式 status，active 必须带 next_check", () => {
    const base = entry({ id: "lt_soak_7d", kind: "long_term", action: "longterm.due" });
    expect(() => validateMasterPlanDocument(doc([base]))).toThrow(/status/);
    expect(() =>
      validateMasterPlanDocument(
        doc([entry({ id: "lt_soak_7d", kind: "long_term", action: "longterm.due", status: "active" })]),
      ),
    ).toThrow(/next_check/);
    expect(() =>
      validateMasterPlanDocument(
        doc([
          entry({
            id: "lt_soak_7d",
            kind: "long_term",
            action: "longterm.due",
            status: "active",
            next_check: "2026-11-03",
          }),
        ]),
      ),
    ).not.toThrow();
  });

  it("拒绝非法时间、日期、周几与未知动作", () => {
    expect(() =>
      validateMasterPlanDocument(
        doc([entry({ schedule: { kind: "daily", at: "5:00" } })]),
      ),
    ).toThrow(/HH:MM/);
    expect(() =>
      validateMasterPlanDocument(
        doc([entry({ schedule: { kind: "once", date: "2026-02-30", at: "05:00" } })]),
      ),
    ).toThrow(/有效日期/);
    expect(() =>
      validateMasterPlanDocument(
        doc([entry({ schedule: { kind: "weekly", days: [], at: "05:00" } })]),
      ),
    ).toThrow(/至少需要一个周几/);
    expect(() =>
      validateMasterPlanDocument(doc([entry({ action: "not.an.action" })])),
    ).toThrow(/未知唤醒动作/);
  });
});

describe("materializeMasterEntries", () => {
  it("daily 每天到期，disabled 不到期", () => {
    const document = doc([entry(), entry({ id: "off", enabled: false })]);
    expect(materializeMasterEntries(document, "2026-11-02").map((row) => row.id)).toEqual([
      "daily-review",
    ]);
  });

  it("weekly 只命中指定周几", () => {
    const document = doc([
      entry({ id: "weekly", schedule: { kind: "weekly", days: ["mon"], at: "03:00" } }),
    ]);
    expect(materializeMasterEntries(document, "2026-11-02")).toHaveLength(1);
    expect(materializeMasterEntries(document, "2026-11-03")).toHaveLength(0);
  });

  it("monthly 支持 1/15 两个日期", () => {
    const document = doc([
      entry({ id: "biweekly", schedule: { kind: "monthly", days: [1, 15], at: "18:30" } }),
    ]);
    expect(materializeMasterEntries(document, "2026-11-01")).toHaveLength(1);
    expect(materializeMasterEntries(document, "2026-11-15")).toHaveLength(1);
    expect(materializeMasterEntries(document, "2026-11-02")).toHaveLength(0);
  });

  it("once 只在指定日期命中", () => {
    const document = doc([
      entry({ id: "once", schedule: { kind: "once", date: "2026-11-15", at: "09:00" } }),
    ]);
    expect(materializeMasterEntries(document, "2026-11-15")).toHaveLength(1);
    expect(materializeMasterEntries(document, "2026-11-16")).toHaveLength(0);
  });

  it("long_term 同时看 active 与 next_check 门槛", () => {
    const longTerm = entry({
      id: "lt_soak_7d",
      kind: "long_term",
      action: "longterm.due",
      schedule: { kind: "daily", at: "20:00" },
      status: "active",
      next_check: "2026-11-03",
    });
    const document = doc([
      longTerm,
      entry({ ...longTerm, id: "lt_future", next_check: "2026-11-10" }),
      entry({ ...longTerm, id: "lt_paused", status: "paused" }),
    ]);
    expect(materializeMasterEntries(document, "2026-11-02")).toHaveLength(0);
    expect(materializeMasterEntries(document, "2026-11-03").map((row) => row.id)).toEqual([
      "lt_soak_7d",
    ]);
  });

  it("不修改原文档", () => {
    const document = doc([entry(), entry({ id: "off", enabled: false })]);
    const before = JSON.stringify(document);
    materializeMasterEntries(document, "2026-11-02");
    expect(JSON.stringify(document)).toBe(before);
  });
});

describe("编辑 op", () => {
  it("接受显式 op 并拒绝未知操作/字段", () => {
    const ops = validateMasterEditOps([
      { op: "set_enabled", id: "daily-review", enabled: false },
      { op: "remove_entry", id: "second" },
    ]);
    expect(ops).toHaveLength(2);
    expect(() => validateMasterEditOps([])).toThrow(/至少需要一个/);
    expect(() => validateMasterEditOps([{ op: "explode" }])).toThrow(/未知编辑操作/);
    expect(() =>
      validateMasterEditOps([{ op: "update_entry", id: "daily-review", patch: { id: "x" } }]),
    ).toThrow(/未知字段/);
  });

  it("应用 update/remove 后条目更新且原文档不变", () => {
    const document = doc([entry(), entry({ id: "second" })]);
    const ops = validateMasterEditOps([
      { op: "update_entry", id: "daily-review", patch: { title: "改名" } },
      { op: "remove_entry", id: "second" },
    ]);
    const entries = applyMasterEditOps(document, ops, NOW + 1000);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBe("改名");
    expect(entries[0]?.updated_at).toBe(NOW + 1000);
    expect(document.entries).toHaveLength(2);
    expect(renderMasterMarkdown(document)).toContain("### daily-review [fixed] 今日复盘");
  });
});
