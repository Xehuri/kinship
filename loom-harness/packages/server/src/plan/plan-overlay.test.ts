/**
 * 日计划 diff 覆盖层验收：四类 op 合并、母版逐字节不变、base_version 冲突、
 * 重复 add/母版 id 冲突、未知 update/remove、漂移孤儿告警与有效字段标记。
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { MasterEntry, MasterPlanDocument } from "./master-plan.js";
import {
  OverlayBaseStaleError,
  PlanOverlayValidationError,
  assertOverlayBaseFresh,
  mergeOverlay,
  renderEffectiveMarkdown,
  validateCareEntries,
  validatePlanOverlayAgainstMaster,
  validatePlanOverlayDocument,
  validatePlanOverlayReviseInput,
  validatePlanOverlayWriteInput,
  type PlanOverlayDocument,
  type PlanOverlayItem,
  type PlanOverlayOp,
} from "./plan-overlay.js";
import type { PlanCoverage } from "./plan-store.js";

const NOW = Date.UTC(2026, 9, 28, 4, 0, 0);
const DAY = "2026-10-28";
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "plan-overlay-"));
  roots.push(root);
  return root;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function entry(overrides: Partial<MasterEntry> = {}): MasterEntry {
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

function master(version = 3, entries: readonly MasterEntry[] = [entry()]): MasterPlanDocument {
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

const COVERAGE: PlanCoverage = {
  profile: "merged_7",
  checkpoints: ["cov-06"],
  debt: [],
};

function overlay(overrides: Partial<PlanOverlayDocument> = {}): PlanOverlayDocument {
  return {
    schema: 1,
    kind: "plan-overlay",
    date: DAY,
    base_version: 3,
    version: 2,
    status: "draft",
    created_at: NOW,
    updated_at: NOW,
    ops: [],
    notes: [],
    coverage: COVERAGE,
    ...overrides,
  };
}

describe("mergeOverlay", () => {
  it("应用 add/update/remove/note 并标记 source 与 at_override", () => {
    const masterDoc = master(3, [
      entry(),
      entry({ id: "lunch-check", title: "午间检查", schedule: { kind: "daily", at: "12:00" } }),
      entry({ id: "evening-stretch", title: "晚间拉伸", schedule: { kind: "daily", at: "20:00" } }),
    ]);
    const doc = overlay({
      notes: ["当日备注"],
      ops: [
        {
          op: "update",
          id: "morning-review",
          patch: {
            at: "06:30",
            intent: "改到六点半",
            status: "done",
            evidence: "完成",
            done_at: "2026-10-28T06:35:00+08:00",
          },
        },
        { op: "remove", id: "evening-stretch" },
        {
          op: "add",
          item: { id: "extra-walk", kind: "care", intent: "傍晚散步", status: "planned", at: "18:00" },
        },
        { op: "note", text: "今天不加班" },
      ],
    });

    const effective = mergeOverlay(masterDoc, doc, DAY);
    const byId = new Map(effective.entries.map((row) => [row.id, row]));

    const morning = byId.get("morning-review");
    expect(morning?.source).toBe("master");
    expect(morning?.at).toBe("06:30");
    expect(morning?.at_override).toBe(true);
    expect(morning?.status).toBe("done");
    expect(morning?.evidence).toBe("完成");
    expect(morning?.done_at).toBe("2026-10-28T06:35:00+08:00");
    expect(morning?.master_version).toBe(3);
    expect(morning?.overlay_version).toBe(2);

    expect(byId.get("evening-stretch")?.suppressed).toBe(true);
    const added = byId.get("extra-walk");
    expect(added?.source).toBe("overlay");
    expect(added?.at).toBe("18:00");
    expect(added?.suppressed).toBe(false);

    expect(effective.notes).toEqual(["当日备注", "今天不加班"]);
    expect(effective.warnings).toEqual([]);
    expect(effective.coverage).toEqual(COVERAGE);
  });

  it("母版文件 sha256 与 JSON 字节在合并前后完全不变", () => {
    const root = tempRoot();
    const path = join(root, "master.json");
    const masterDoc = master(3, [
      entry(),
      entry({ id: "lunch-check", title: "午间检查", schedule: { kind: "daily", at: "12:00" } }),
    ]);
    writeFileSync(path, `${JSON.stringify(masterDoc, null, 2)}\n`, "utf8");
    const before = sha256(path);
    const beforeJson = JSON.stringify(masterDoc);

    mergeOverlay(
      masterDoc,
      overlay({
        ops: [
          { op: "update", id: "morning-review", patch: { at: "07:00" } },
          { op: "remove", id: "lunch-check" },
        ],
      }),
      DAY,
    );

    expect(sha256(path)).toBe(before);
    expect(JSON.stringify(masterDoc)).toBe(beforeJson);
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(masterDoc, null, 2)}\n`);
  });

  it("母版漂移时容忍孤儿 op 并给出告警", () => {
    const drifted = master(4, [entry(), entry({ id: "new-master", schedule: { kind: "daily", at: "09:00" } })]);
    const doc = overlay({
      base_version: 3,
      ops: [
        { op: "update", id: "gone-item", patch: { intent: "不存在" } },
        { op: "remove", id: "gone-item" },
        { op: "add", item: { id: "morning-review", kind: "care", intent: "撞 id", status: "planned" } },
      ],
    });

    const effective = mergeOverlay(drifted, doc, DAY);
    expect(effective.warnings).toContain("base_stale:3!=4");
    expect(effective.warnings).toContain("orphan_update:gone-item");
    expect(effective.warnings).toContain("orphan_remove:gone-item");
    expect(effective.warnings).toContain("add_collision:morning-review");
    expect(effective.entries.map((row) => row.id)).toEqual(["morning-review", "new-master"]);
    expect(effective.entries[0]?.source).toBe("master");
  });
});

describe("base_version 与对账", () => {
  it("commit 前 base_version 与母版不一致抛 typed OverlayBaseStaleError", () => {
    expect(() => assertOverlayBaseFresh(overlay({ base_version: 2 }), master(3))).toThrow(
      OverlayBaseStaleError,
    );
    expect(() => assertOverlayBaseFresh(overlay({ base_version: 3 }), master(3))).not.toThrow();
  });

  it("重复 add 在文档校验阶段被拒绝", () => {
    const item = { id: "dupe", kind: "care" as const, intent: "重复", status: "planned" as const };
    expect(() =>
      validatePlanOverlayDocument(
        overlay({ ops: [{ op: "add", item }, { op: "add", item }] }),
      ),
    ).toThrow(/重复操作 id/);
  });

  it("add 与当日母版 id 冲突、update/remove 未知 id 都抛 typed 校验错误", () => {
    const masterDoc = master();
    expect(() =>
      validatePlanOverlayAgainstMaster(
        masterDoc,
        overlay({
          ops: [
            {
              op: "add",
              item: { id: "morning-review", kind: "care", intent: "撞 id", status: "planned" },
            },
          ],
        }),
        DAY,
      ),
    ).toThrow(PlanOverlayValidationError);

    expect(() =>
      validatePlanOverlayAgainstMaster(
        masterDoc,
        overlay({ ops: [{ op: "update", id: "unknown", patch: { intent: "x" } }] }),
        DAY,
      ),
    ).toThrow(/母版当日不存在/);

    expect(() =>
      validatePlanOverlayAgainstMaster(
        masterDoc,
        overlay({ ops: [{ op: "remove", id: "unknown" }] }),
        DAY,
      ),
    ).toThrow(/母版当日不存在/);
  });
});

describe("user_intent", () => {
  it("document/write/revise 接受并回传 user_intent，空串拒绝，旧文档缺省解析", () => {
    expect(validatePlanOverlayDocument(overlay({ user_intent: "今天先稳住状态" })).user_intent).toBe(
      "今天先稳住状态",
    );
    expect(validatePlanOverlayDocument(overlay()).user_intent).toBeUndefined();
    expect(() => validatePlanOverlayDocument(overlay({ user_intent: "" }))).toThrow(
      PlanOverlayValidationError,
    );

    const write = validatePlanOverlayWriteInput({
      date: DAY,
      base_version: 3,
      ops: [],
      coverage: COVERAGE,
      user_intent: "只做重要的事",
    });
    expect(write.user_intent).toBe("只做重要的事");
    expect(() =>
      validatePlanOverlayWriteInput({
        date: DAY,
        base_version: 3,
        ops: [],
        coverage: COVERAGE,
        user_intent: "",
      }),
    ).toThrow(PlanOverlayValidationError);

    const revise = validatePlanOverlayReviseInput({ user_intent: "慢一点" });
    expect(revise.user_intent).toBe("慢一点");
    expect(() => validatePlanOverlayReviseInput({ user_intent: "   " })).toThrow(
      PlanOverlayValidationError,
    );
  });

  it("mergeOverlay 传播 user_intent，缺省时保持缺省", () => {
    const withIntent = mergeOverlay(master(), overlay({ user_intent: "今天不加班" }), DAY);
    expect(withIntent.user_intent).toBe("今天不加班");

    const withoutIntent = mergeOverlay(master(), overlay(), DAY);
    expect(withoutIntent.user_intent).toBeUndefined();
    expect("user_intent" in withoutIntent).toBe(false);
  });

  it("renderEffectiveMarkdown 仅在存在时渲染 用户意图", () => {
    const withIntent = renderEffectiveMarkdown(
      mergeOverlay(master(), overlay({ user_intent: "今天先稳住状态" }), DAY),
    );
    expect(withIntent).toContain("用户意图: 今天先稳住状态");

    const withoutIntent = renderEffectiveMarkdown(mergeOverlay(master(), overlay(), DAY));
    expect(withoutIntent).not.toContain("用户意图");
  });
});

describe("validateCareEntries", () => {
  function careOp(overrides: Partial<PlanOverlayItem> = {}): PlanOverlayOp {
    return {
      op: "add",
      item: {
        id: "care-message",
        kind: "care",
        intent: "发一条非事务消息",
        status: "planned",
        ...overrides,
      },
    };
  }

  function catchCareError(fn: () => void): PlanOverlayValidationError {
    try {
      fn();
    } catch (error) {
      if (error instanceof PlanOverlayValidationError) return error;
      throw error;
    }
    throw new Error("validateCareEntries 未抛出 PlanOverlayValidationError");
  }

  it("care add 缺少 done_when 或无可核验时间且无 window 时拒绝", () => {
    const missing = catchCareError(() =>
      validateCareEntries(master(), overlay({ ops: [careOp()] }), DAY),
    );
    expect(missing.field).toBe("ops[0].item.done_when");
    expect(missing.message).toContain("done_when");
    expect(missing.message).toContain("kind=note");

    expect(() =>
      validateCareEntries(
        master(),
        overlay({ ops: [careOp({ done_when: "已经发过消息了" })] }),
        DAY,
      ),
    ).toThrow(PlanOverlayValidationError);

    expect(() =>
      validateCareEntries(
        master(),
        overlay({ ops: [careOp({ window: "08:00~09:00" })] }),
        DAY,
      ),
    ).toThrow(PlanOverlayValidationError);
  });

  it("care add 在 done_when 含时钟或提供 window 时放行", () => {
    expect(() =>
      validateCareEntries(
        master(),
        overlay({ ops: [careOp({ done_when: "08:00 前已发过一条非事务消息" })] }),
        DAY,
      ),
    ).not.toThrow();

    expect(() =>
      validateCareEntries(
        master(),
        overlay({ ops: [careOp({ done_when: "已经发过消息", window: "08:00~09:00" })] }),
        DAY,
      ),
    ).not.toThrow();
  });

  it("时钟匹配接受 8:00 与全角冒号 08：00", () => {
    for (const doneWhen of ["8:00 前已发消息", "08：00 前已发消息"]) {
      expect(() =>
        validateCareEntries(master(), overlay({ ops: [careOp({ done_when: doneWhen })] }), DAY),
      ).not.toThrow();
    }
  });

  it("时钟匹配拒绝 24:00、108:00、08:000", () => {
    for (const doneWhen of ["24:00 前已发消息", "108:00 前已发消息", "08:000 前已发消息"]) {
      expect(() =>
        validateCareEntries(master(), overlay({ ops: [careOp({ done_when: doneWhen })] }), DAY),
      ).toThrow(PlanOverlayValidationError);
    }
  });

  it("非 care add 与 care status-only update 不受影响", () => {
    expect(() =>
      validateCareEntries(
        master(),
        overlay({
          ops: [
            {
              op: "add",
              item: { id: "note-1", kind: "note", intent: "记一笔", status: "planned" },
            },
          ],
        }),
        DAY,
      ),
    ).not.toThrow();

    expect(() =>
      validateCareEntries(
        master(),
        overlay({
          ops: [
            careOp({ done_when: "08:00 前已发过一条非事务消息" }),
            { op: "update", id: "care-message", patch: { status: "done" } },
          ],
        }),
        DAY,
      ),
    ).not.toThrow();

    expect(() =>
      validateCareEntries(
        master(),
        overlay({ ops: [{ op: "update", id: "morning-review", patch: { done_when: "不是时间" } }] }),
        DAY,
      ),
    ).not.toThrow();
  });

  it("update care 目标的 done_when 后置校验：非法拒绝、有效时钟放行", () => {
    const invalid = catchCareError(() =>
      validateCareEntries(
        master(),
        overlay({
          ops: [
            careOp({ done_when: "08:00 前已发过一条非事务消息" }),
            { op: "update", id: "care-message", patch: { done_when: "发过就行" } },
          ],
        }),
        DAY,
      ),
    );
    expect(invalid.field).toBe("ops[1].patch.done_when");
    expect(invalid.message).toContain("kind=note");

    expect(() =>
      validateCareEntries(
        master(),
        overlay({
          ops: [
            careOp({ done_when: "08:00 前已发过一条非事务消息" }),
            { op: "update", id: "care-message", patch: { done_when: "09:00 前完成" } },
          ],
        }),
        DAY,
      ),
    ).not.toThrow();
  });

  it("未知 update id 跳过", () => {
    expect(() =>
      validateCareEntries(
        master(),
        overlay({ ops: [{ op: "update", id: "ghost-care", patch: { done_when: "不是时间" } }] }),
        DAY,
      ),
    ).not.toThrow();
  });

  it("priorOps 对字段未变的 legacy care add 放行，变更后重新校验", () => {
    const legacy = careOp({ done_when: "记得发消息" });
    expect(() =>
      validateCareEntries(master(), overlay({ ops: [legacy] }), DAY, { priorOps: [legacy] }),
    ).not.toThrow();

    const changed = careOp({ done_when: "记得发消息啊" });
    expect(() =>
      validateCareEntries(master(), overlay({ ops: [changed] }), DAY, { priorOps: [legacy] }),
    ).toThrow(PlanOverlayValidationError);
  });
});
