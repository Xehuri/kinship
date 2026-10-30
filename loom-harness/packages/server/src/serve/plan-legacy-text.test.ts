/**
 * legacy plan 纯文本投影验收：文档/收口头部、覆盖行、条目续行、notes 上限，
 * 以及「文本不再是 JSON 信封」。details.__plan 的结构断言在 plan-tool.test.ts。
 */

import { describe, expect, it } from "vitest";

import type {
  PlanCloseResult,
  PlanCoverage,
  PlanDocument,
  PlanItem,
} from "../plan/plan-store.js";
import { renderPlanLegacyText } from "./plan-legacy-text.js";

const DATE = "2026-10-28";
const NOW = Date.UTC(2026, 9, 27, 21, 0, 0);

const COVERAGE: PlanCoverage = {
  profile: "merged_7",
  checkpoints: ["cov-00", "cov-06", "cov-08", "cov-12", "cov-16", "cov-20", "cov-22"],
  debt: [],
};

function item(
  overrides: Partial<PlanItem> & Pick<PlanItem, "id" | "intent">,
): PlanItem {
  return {
    id: overrides.id,
    kind: overrides.kind ?? "care",
    intent: overrides.intent,
    status: overrides.status ?? "planned",
    ...(overrides.target_date === undefined
      ? {}
      : { target_date: overrides.target_date }),
    ...(overrides.window === undefined ? {} : { window: overrides.window }),
    ...(overrides.checkpoint_id === undefined
      ? {}
      : { checkpoint_id: overrides.checkpoint_id }),
    ...(overrides.done_when === undefined ? {} : { done_when: overrides.done_when }),
    ...(overrides.not_do === undefined ? {} : { not_do: overrides.not_do }),
    ...(overrides.source === undefined ? {} : { source: overrides.source }),
    ...(overrides.note === undefined ? {} : { note: overrides.note }),
  };
}

function documentOf(overrides: Partial<PlanDocument> = {}): PlanDocument {
  return {
    schema: 1,
    date: DATE,
    status: "committed",
    version: 3,
    created_at: NOW,
    updated_at: NOW,
    review_at: "07:30",
    items: [item({ id: "c1", intent: "材料提交" })],
    coverage: COVERAGE,
    notes: ["昨晚睡 6 小时"],
    ...overrides,
  };
}

describe("renderPlanLegacyText document", () => {
  it("renders read/commit/revise/note results as compact text", () => {
    const text = renderPlanLegacyText("read", documentOf());
    expect(text).toBe(
      [
        `plan ${DATE} status=committed v3 review_at=07:30`,
        "coverage profile=merged_7 checkpoints=cov-00,cov-06,cov-08,cov-12,cov-16,cov-20,cov-22 debt=none",
        "items 1 (planned 1):",
        "- c1 care 材料提交 status=planned",
        "notes 1:",
        "- 昨晚睡 6 小时",
      ].join("\n"),
    );
  });

  it("never emits a JSON envelope", () => {
    const text = renderPlanLegacyText("read", documentOf());
    expect(text.startsWith("{")).toBe(false);
    expect(text).not.toContain('"schema"');
    expect(text).not.toContain('"items"');
    expect(text).not.toContain('"coverage"');
    expect(text).not.toContain('"notes"');
  });

  it("renders item continuation fields in the fixed order", () => {
    const text = renderPlanLegacyText(
      "commit",
      documentOf({
        items: [
          item({
            id: "c9",
            intent: "材料提交",
            target_date: "2026-10-29",
            window: "08:00~09:00",
            checkpoint_id: "cov-08",
            done_when: "回执到手",
            not_do: ["不主动提理发", "不主动催简历"],
            source: "plan-2026-10-28",
            note: "先确认材料",
          }),
        ],
        notes: [],
      }),
    );

    expect(text).toContain(
      [
        "- c9 care 材料提交 status=planned",
        "  target_date: 2026-10-29",
        "  window: 08:00~09:00",
        "  checkpoint_id: cov-08",
        "  done_when: 回执到手",
        "  not_do: 不主动提理发; 不主动催简历",
        "  source: plan-2026-10-28",
        "  note: 先确认材料",
      ].join("\n"),
    );
  });

  it("clips item intent at 80 characters", () => {
    const text = renderPlanLegacyText(
      "read",
      documentOf({
        items: [item({ id: "c1", intent: "长".repeat(90) })],
        notes: [],
      }),
    );
    expect(text).toContain(`- c1 care ${"长".repeat(80)}…(+10) status=planned`);
  });

  it("omits the notes block when there are no notes", () => {
    const text = renderPlanLegacyText("note", documentOf({ notes: [] }));
    expect(text).not.toMatch(/^notes \d+:/m);
    expect(text).not.toContain("- …(+");
  });

  it("caps notes at 10 with a hidden-count marker", () => {
    const notes = Array.from(
      { length: 12 },
      (_, index) => `笔记 ${String(index + 1)}`,
    );
    const text = renderPlanLegacyText("read", documentOf({ items: [], notes }));

    expect(text).toContain("items 0 (none):");
    expect(text).toContain("notes 12:");
    expect(text).toContain("- 笔记 10");
    expect(text).not.toContain("- 笔记 11");
    expect(text).toContain("- …(+2)");
  });
});

describe("renderPlanLegacyText close", () => {
  it("renders summary, coverage, carried ids, items and notes", () => {
    const carried = [
      item({ id: "plan-1", intent: "没做", status: "carried" }),
      item({ id: "skip-1", intent: "主动跳过", status: "carried" }),
    ];
    const result: PlanCloseResult = {
      plan: documentOf({
        status: "closed",
        version: 4,
        items: [item({ id: "done-1", intent: "已完成", status: "done" }), ...carried],
        notes: ["今天只完成一件"],
      }),
      carried,
      summary: "今天只完成一件",
    };

    const text = renderPlanLegacyText("close", result);
    expect(text).toContain(`plan ${DATE} closed v4 review_at=07:30`);
    expect(text).toContain("summary: 今天只完成一件");
    expect(text).toContain("coverage profile=merged_7");
    expect(text).toContain("carried 2: plan-1, skip-1");
    expect(text).toContain("items 3 (carried 2, done 1):");
    expect(text).toContain("notes 1:");
  });

  it("renders none when no items were carried", () => {
    const result: PlanCloseResult = {
      plan: documentOf({ status: "closed", version: 2, items: [], notes: [] }),
      carried: [],
      summary: "全部完成",
    };

    const text = renderPlanLegacyText("close", result);
    expect(text).toContain("carried 0: none");
    expect(text).not.toMatch(/^notes \d+:/m);
  });
});
