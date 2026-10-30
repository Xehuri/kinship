/**
 * plan 纯文本投影验收：七个动作的头部、覆盖行、条目与续行、ops/notes/
 * leftovers/账本块，以及「文本不再是 JSON 信封」。
 *
 * details.__plan 的结构断言在 plan-overlay-tool.test.ts；本文件只测渲染。
 */

import { describe, expect, it } from "vitest";

import type { MasterEntry, MasterPlanDocument } from "../plan/master-plan.js";
import type { PlanLedgerRow } from "../plan/plan-ledger.js";
import type {
  EffectivePlan,
  EffectivePlanEntry,
  PlanOverlayDocument,
  PlanOverlayOp,
} from "../plan/plan-overlay.js";
import type { PlanCoverage } from "../plan/plan-store.js";
import type {
  PlanBaseResult,
  PlanCloseResult,
  PlanDiffResult,
  PlanDoneResult,
  PlanLeftoverItem,
  PlanReadResult,
} from "./plan-overlay-tool.js";
import { renderPlanOverlayText } from "./plan-overlay-text.js";

const NOW = Date.UTC(2026, 9, 28, 5, 0, 0);
const DAY = "2026-10-28";
const YESTERDAY = "2026-10-27";

const COVERAGE: PlanCoverage = {
  profile: "merged_7",
  checkpoints: ["cov-06"],
  debt: [],
};

function masterEntry(overrides: Partial<MasterEntry> = {}): MasterEntry {
  return {
    id: "morning-review",
    kind: "fixed",
    title: "晨间复盘",
    enabled: true,
    action: "review.daily",
    instruction: "母版指令正文",
    schedule: { kind: "daily", at: "06:10" },
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function masterDoc(entries: readonly MasterEntry[]): MasterPlanDocument {
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

function overlayDoc(overrides: Partial<PlanOverlayDocument> = {}): PlanOverlayDocument {
  return {
    schema: 1,
    kind: "plan-overlay",
    date: DAY,
    base_version: 1,
    version: 2,
    status: "committed",
    created_at: NOW,
    updated_at: NOW,
    ops: [],
    notes: [],
    coverage: COVERAGE,
    ...overrides,
  };
}

function effectiveEntry(overrides: Partial<EffectivePlanEntry> = {}): EffectivePlanEntry {
  return {
    id: "morning-review",
    kind: "fixed",
    title: "晨间复盘",
    intent: "回顾昨天",
    at: "06:10",
    at_override: false,
    action: "review.daily",
    payload: { depth: "full" },
    instruction: "先看昨日复盘",
    window: "06:10~07:00",
    done_when: "给出三条结论",
    target_date: "today",
    checkpoint_id: "cov-06",
    not_do: ["跳过", "敷衍"],
    note: "固定项",
    status: "planned",
    source: "master",
    suppressed: false,
    master_version: 1,
    overlay_version: 2,
    ...overrides,
  };
}

function effectivePlan(
  entries: readonly EffectivePlanEntry[],
  overrides: Partial<EffectivePlan> = {},
): EffectivePlan {
  return {
    date: DAY,
    origin: "overlay",
    status: "committed",
    base_version: 1,
    master_version: 1,
    overlay_version: 2,
    coverage: COVERAGE,
    entries,
    notes: [],
    warnings: [],
    ...overrides,
  };
}

function ledgerRow(overrides: Partial<PlanLedgerRow> = {}): PlanLedgerRow {
  return {
    schema: 1,
    at: NOW,
    date: DAY,
    source: "plan",
    event: "diff",
    ...overrides,
  };
}

function expectPlainText(text: string): void {
  expect(text.startsWith("{")).toBe(false);
  expect(text).not.toContain('"schema":');
  expect(text).not.toContain('"master":');
}

describe("read", () => {
  it("有覆盖层：头部/覆盖行/有效条目/告警/笔记/账本尾", () => {
    const walk: EffectivePlanEntry = {
      id: "walk",
      kind: "care",
      intent: "散步",
      at_override: false,
      status: "planned",
      source: "overlay",
      suppressed: true,
      evidence: "走路截图",
      master_version: 1,
      overlay_version: 2,
    };
    const payload: PlanReadResult = {
      date: DAY,
      master: masterDoc([masterEntry()]),
      overlay: overlayDoc({ notes: ["早间提醒"] }),
      effective: effectivePlan([effectiveEntry(), walk], {
        warnings: ["base_stale:1!=2"],
        notes: ["早间提醒"],
      }),
      leftovers: [],
      ledger_tail: [ledgerRow({ event: "diff", version: 2, reason: "初始 diff" })],
    };

    const text = renderPlanOverlayText("read", payload);
    const lines = text.split("\n");

    expect(lines[0]).toBe(
      "plan read 2026-10-28 master=v1 overlay=v2 status=committed origin=overlay",
    );
    expect(lines[1]).toBe("coverage profile=merged_7 checkpoints=cov-06 debt=none");
    expect(text).toContain("entries 2 (planned 2)");
    expect(text).toContain("- [06:10] fixed morning-review 晨间复盘 status=planned source=master");
    expect(text).toContain("  intent: 回顾昨天");
    expect(text).toContain("  action: review.daily");
    expect(text).toContain("  payload: depth=full");
    expect(text).toContain("  window: 06:10~07:00");
    expect(text).toContain("  done_when: 给出三条结论");
    expect(text).toContain("  target_date: today");
    expect(text).toContain("  checkpoint_id: cov-06");
    expect(text).toContain("  not_do: 跳过; 敷衍");
    expect(text).toContain("  note: 固定项");
    expect(text).not.toContain("instruction:");
    expect(text).toContain(
      "- [--] care walk 散步 status=planned source=overlay suppressed=true evidence=走路截图",
    );
    expect(text).toContain("warnings: base_stale:1!=2");
    expect(text).toContain("notes 1:");
    expect(text).toContain("- 早间提醒");
    expect(text).toContain("ledger tail 1:");
    expect(text).toContain("- 05:00Z diff v2 · 初始 diff");
    expectPlainText(text);
  });

  it("includeInstruction: true 渲染所有 instruction 正文", () => {
    const payload: PlanReadResult = {
      date: DAY,
      master: masterDoc([masterEntry()]),
      overlay: overlayDoc(),
      effective: effectivePlan([effectiveEntry()]),
      leftovers: [],
      ledger_tail: [],
    };

    const text = renderPlanOverlayText("read", payload, { includeInstruction: true });

    expect(text).toContain("  instruction: 先看昨日复盘");
  });

  it("includeInstruction: true 时 instruction 不截断，超长正文完整渲染", () => {
    const longInstruction = "长".repeat(400);
    const payload: PlanReadResult = {
      date: DAY,
      master: masterDoc([masterEntry()]),
      overlay: overlayDoc(),
      effective: effectivePlan([effectiveEntry({ instruction: longInstruction })]),
      leftovers: [],
      ledger_tail: [],
    };

    const text = renderPlanOverlayText("read", payload, { includeInstruction: true });

    expect(text).toContain(longInstruction);
  });

  it("includeInstruction 传 id 数组时只渲染指定条目的 instruction", () => {
    const walk: EffectivePlanEntry = {
      id: "walk",
      kind: "care",
      intent: "散步",
      at_override: false,
      status: "planned",
      source: "overlay",
      suppressed: false,
      instruction: "散步指令正文",
      master_version: 1,
      overlay_version: 2,
    };
    const payload: PlanReadResult = {
      date: DAY,
      master: masterDoc([masterEntry()]),
      overlay: overlayDoc(),
      effective: effectivePlan([effectiveEntry(), walk]),
      leftovers: [],
      ledger_tail: [],
    };

    const text = renderPlanOverlayText("read", payload, {
      includeInstruction: ["morning-review"],
    });

    expect(text).toContain("  instruction: 先看昨日复盘");
    expect(text).not.toContain("散步指令正文");
  });

  it("user_intent 在覆盖行之后、条目计数之前渲染", () => {
    const payload: PlanReadResult = {
      date: DAY,
      master: masterDoc([masterEntry()]),
      overlay: overlayDoc(),
      effective: effectivePlan([effectiveEntry()], { user_intent: "今天先稳住状态" }),
      leftovers: [],
      ledger_tail: [],
    };

    const lines = renderPlanOverlayText("read", payload).split("\n");

    expect(lines[1]).toBe("coverage profile=merged_7 checkpoints=cov-06 debt=none");
    expect(lines[2]).toBe("user_intent: 今天先稳住状态");
    expect(lines[3]).toBe("entries 1 (planned 1)");
  });

  it("effective 无 user_intent 时回退到 overlay.user_intent", () => {
    const payload: PlanReadResult = {
      date: DAY,
      master: masterDoc([masterEntry()]),
      overlay: overlayDoc({ user_intent: "只做重要的事" }),
      effective: effectivePlan([effectiveEntry()]),
      leftovers: [],
      ledger_tail: [],
    };

    const text = renderPlanOverlayText("read", payload);

    expect(text).toContain("user_intent: 只做重要的事");
  });

  it("无 user_intent 时不渲染该行", () => {
    const payload: PlanReadResult = {
      date: DAY,
      master: masterDoc([masterEntry()]),
      overlay: overlayDoc(),
      effective: effectivePlan([effectiveEntry()]),
      leftovers: [],
      ledger_tail: [],
    };

    const text = renderPlanOverlayText("read", payload);

    expect(text).not.toContain("user_intent:");
  });

  it("user_intent 超过 SUMMARY_LIMIT 时截断", () => {
    const longIntent = "稳".repeat(400);
    const payload: PlanReadResult = {
      date: DAY,
      master: masterDoc([masterEntry()]),
      overlay: overlayDoc(),
      effective: effectivePlan([effectiveEntry()], { user_intent: longIntent }),
      leftovers: [],
      ledger_tail: [],
    };

    const text = renderPlanOverlayText("read", payload);

    expect(text).toContain(`user_intent: ${"稳".repeat(300)}…(+100)`);
    expect(text).not.toContain(longIntent);
  });

  it("无覆盖层：母版预览用排班括号，禁用项标 enabled=false", () => {
    const payload: PlanReadResult = {
      date: DAY,
      master: masterDoc([
        masterEntry(),
        masterEntry({
          id: "paused-anchor",
          kind: "anchor",
          title: "暂停锚点",
          enabled: false,
          schedule: { kind: "weekly", days: ["mon"], at: "03:00" },
        }),
      ]),
      overlay: null,
      effective: null,
      leftovers: [],
      ledger_tail: [],
    };

    const text = renderPlanOverlayText("read", payload);
    const lines = text.split("\n");

    expect(lines[0]).toBe("plan read 2026-10-28 master=v1 overlay=none effective=none");
    expect(lines[1]).toBe("entries 2 (master preview, no daily overlay)");
    expect(text).toContain("- [daily@06:10] fixed morning-review 晨间复盘 status=active source=master");
    expect(text).toContain(
      "- [weekly@03:00] anchor paused-anchor 暂停锚点 status=active source=master enabled=false",
    );
    expectPlainText(text);
  });

  it("无覆盖层但有 legacy 有效视图：头部 overlay=none、origin=legacy 并渲染有效条目", () => {
    const walk: EffectivePlanEntry = {
      id: "walk",
      kind: "care",
      intent: "散步",
      at_override: false,
      status: "carried",
      source: "overlay",
      suppressed: false,
      master_version: 1,
      overlay_version: 1,
    };
    const payload: PlanReadResult = {
      date: DAY,
      master: masterDoc([masterEntry()]),
      overlay: null,
      effective: effectivePlan([effectiveEntry({ status: "done" }), walk], {
        origin: "legacy",
        status: "closed",
        notes: ["旧版日计划笔记"],
        warnings: ["legacy:plan-json"],
      }),
      leftovers: [],
      ledger_tail: [ledgerRow({ event: "close", version: 1, reason: "旧版收口" })],
    };

    const text = renderPlanOverlayText("read", payload);
    const lines = text.split("\n");

    expect(lines[0]).toBe(
      "plan read 2026-10-28 master=v1 overlay=none status=closed origin=legacy",
    );
    expect(text).toContain("coverage profile=merged_7 checkpoints=cov-06 debt=none");
    expect(text).toContain("entries 2 (carried 1, done 1)");
    expect(text).toContain("- [06:10] fixed morning-review 晨间复盘 status=done source=master");
    expect(text).toContain("- [--] care walk 散步 status=carried source=overlay");
    expect(text).toContain("warnings: legacy:plan-json");
    expect(text).toContain("notes 1:");
    expect(text).toContain("- 旧版日计划笔记");
    expect(text).toContain("ledger tail 1:");
    expect(text).toContain("- 05:00Z close v1 · 旧版收口");
    expect(text).not.toContain("master preview");
    expectPlainText(text);
  });
});

describe("base", () => {
  it("母版物化条目 + 昨日遗留", () => {
    const leftover: PlanLeftoverItem = {
      source_date: YESTERDAY,
      id: "leftover-1",
      kind: "care",
      status: "planned",
      intent: "昨日未完成",
      at: "21:00",
    };
    const payload: PlanBaseResult = {
      date: DAY,
      master_version: 1,
      base_version: 1,
      items: [masterEntry()],
      leftovers: [leftover],
    };

    const text = renderPlanOverlayText("base", payload);
    const lines = text.split("\n");

    expect(lines[0]).toBe("plan base 2026-10-28 master=v1 base=v1 items=1");
    expect(lines[1]).toBe("items 1:");
    expect(text).toContain("- [daily@06:10] fixed morning-review 晨间复盘 status=active source=master");
    expect(text).toContain("leftovers 2026-10-27: 1");
    expect(text).toContain("- [21:00] care leftover-1 昨日未完成 status=planned source=leftover");
    expect(text).not.toContain("instruction:");
    expectPlainText(text);
  });

  it("includeInstruction: true 渲染母版条目的 instruction", () => {
    const payload: PlanBaseResult = {
      date: DAY,
      master_version: 1,
      base_version: 1,
      items: [masterEntry()],
      leftovers: [],
    };

    const text = renderPlanOverlayText("base", payload, { includeInstruction: true });

    expect(text).toContain("  instruction: 母版指令正文");
  });

  it("filter：按 status 过滤 items，头部与计数行改成 X/Y", () => {
    const leftover: PlanLeftoverItem = {
      source_date: YESTERDAY,
      id: "leftover-1",
      kind: "care",
      status: "planned",
      intent: "昨日未完成",
      at: "21:00",
    };
    const payload: PlanBaseResult = {
      date: DAY,
      master_version: 1,
      base_version: 1,
      items: [
        masterEntry(),
        masterEntry({
          id: "paused-anchor",
          kind: "anchor",
          title: "暂停锚点",
          enabled: false,
          schedule: { kind: "weekly", days: ["mon"], at: "03:00" },
        }),
      ],
      leftovers: [leftover],
    };

    const text = renderPlanOverlayText("base", payload, {
      filter: { status: ["planned"] },
    });
    const lines = text.split("\n");

    expect(lines[0]).toBe("plan base 2026-10-28 master=v1 base=v1 items=1/2");
    expect(lines[1]).toBe("items 1/2 (planned 1) filter=status=planned");
    expect(text).not.toContain("paused-anchor");
    expect(text).toContain("leftovers 2026-10-27: 1");
    expect(text).toContain("- [21:00] care leftover-1 昨日未完成 status=planned source=leftover");
  });
});

describe("diff / revise", () => {
  it("diff：头部、覆盖行、ops、条目计数与账本行", () => {
    const ops: readonly PlanOverlayOp[] = [
      { op: "update", id: "morning-review", patch: { at: "06:30" } },
      { op: "add", item: { id: "walk", kind: "care", intent: "散步", status: "planned" } },
    ];
    const payload: PlanDiffResult = {
      date: DAY,
      overlay: overlayDoc({ ops }),
      effective: effectivePlan([effectiveEntry()]),
      ledger: ledgerRow({ event: "diff", version: 2, reason: "首次 diff" }),
    };

    const text = renderPlanOverlayText("diff", payload);
    const lines = text.split("\n");

    expect(lines[0]).toBe("plan diff 2026-10-28 overlay=v2 status=committed base=v1");
    expect(lines[1]).toBe("coverage profile=merged_7 checkpoints=cov-06 debt=none");
    expect(lines[2]).toBe("ops 2:");
    expect(lines[3]).toBe("- op=update, id=morning-review, patch=at=06:30");
    expect(text).toContain("entries 1 (planned 1)");
    expect(text).toContain("ledger: 05:00Z diff v2 · 首次 diff");
    expectPlainText(text);
  });

  it("revise：头部与 revise 账本行", () => {
    const payload: PlanDiffResult = {
      date: DAY,
      overlay: overlayDoc({
        version: 3,
        ops: [{ op: "update", id: "morning-review", patch: { at: "07:10" } }],
      }),
      effective: effectivePlan([effectiveEntry({ at: "07:10" })], {
        warnings: ["base_stale:1!=2"],
      }),
      ledger: ledgerRow({ event: "revise", version: 3, reason: "母版漂移后的修订" }),
    };

    const text = renderPlanOverlayText("revise", payload);

    expect(text.split("\n")[0]).toBe(
      "plan revise 2026-10-28 overlay=v3 status=committed base=v1",
    );
    expect(text).toContain("ops 1:");
    expect(text).toContain("entries 1 (planned 1)");
    expect(text).toContain("ledger: 05:00Z revise v3 · 母版漂移后的修订");
    expectPlainText(text);
  });

  it("diff：user_intent 在覆盖行之后渲染", () => {
    const payload: PlanDiffResult = {
      date: DAY,
      overlay: overlayDoc({
        user_intent: "今天先稳住状态",
        ops: [{ op: "update", id: "morning-review", patch: { at: "06:30" } }],
      }),
      effective: effectivePlan([effectiveEntry()], { user_intent: "今天先稳住状态" }),
      ledger: ledgerRow({ event: "diff", version: 2 }),
    };

    const lines = renderPlanOverlayText("diff", payload).split("\n");

    expect(lines[1]).toBe("coverage profile=merged_7 checkpoints=cov-06 debt=none");
    expect(lines[2]).toBe("user_intent: 今天先稳住状态");
    expect(lines[3]).toBe("ops 1:");
  });

  it("revise：effective 缺省时回退 overlay.user_intent", () => {
    const payload: PlanDiffResult = {
      date: DAY,
      overlay: overlayDoc({ version: 3, user_intent: "慢一点" }),
      effective: effectivePlan([effectiveEntry({ at: "07:10" })]),
      ledger: ledgerRow({ event: "revise", version: 3 }),
    };

    const text = renderPlanOverlayText("revise", payload);

    expect(text).toContain("user_intent: 慢一点");
  });
});

describe("note", () => {
  it("头部带笔记数、latest note、条目计数与账本行", () => {
    const payload: PlanDiffResult = {
      date: DAY,
      overlay: overlayDoc({ version: 3, notes: ["第一", "午后补一条"] }),
      effective: effectivePlan([effectiveEntry()]),
      ledger: ledgerRow({ event: "note", version: 3, reason: "午后补一条" }),
    };

    const text = renderPlanOverlayText("note", payload);
    const lines = text.split("\n");

    expect(lines[0]).toBe(
      "plan note 2026-10-28 overlay=v3 status=committed notes=2",
    );
    expect(lines[1]).toBe("latest note: 午后补一条");
    expect(text).toContain("entries 1 (planned 1)");
    expect(text).toContain("ledger: 05:00Z note v3 · 午后补一条");
    expectPlainText(text);
  });
});

describe("done", () => {
  it("头部带 id/result/overlay 状态，变更条目以 entry: 前缀给出", () => {
    const payload: PlanDoneResult = {
      date: DAY,
      id: "morning-review",
      status: "done",
      overlay: overlayDoc({ version: 3 }),
      effective: effectivePlan([
        effectiveEntry({
          status: "done",
          evidence: "打卡截图",
          done_at: "2026-10-28T05:30:00.000Z",
        }),
      ]),
      ledger: ledgerRow({
        event: "done",
        entry_id: "morning-review",
        status: "done",
        version: 3,
      }),
    };

    const text = renderPlanOverlayText("done", payload);
    const lines = text.split("\n");

    expect(lines[0]).toBe(
      "plan done 2026-10-28 id=morning-review result=done overlay=v3 overlay_status=committed",
    );
    expect(text).toContain(
      "entry: [06:10] fixed morning-review 晨间复盘 status=done source=master" +
        " evidence=打卡截图 done_at=2026-10-28T05:30:00.000Z",
    );
    expect(text).toContain("entries 1 (done 1)");
    expect(text).toContain("ledger: 05:00Z done v3");
    expect(text).not.toContain("·");
    expectPlainText(text);
  });
});

describe("close", () => {
  it("头部、summary、carried 块、有效条目计数与账本行", () => {
    const payload: PlanCloseResult = {
      date: DAY,
      overlay: overlayDoc({ version: 5, status: "closed", notes: ["当日收口"] }),
      effective: effectivePlan([effectiveEntry({ status: "carried" })]),
      carried: [effectiveEntry({ status: "carried" })],
      ledger: ledgerRow({ event: "close", version: 5, reason: "当日收口" }),
    };

    const text = renderPlanOverlayText("close", payload);
    const lines = text.split("\n");

    expect(lines[0]).toBe("plan close 2026-10-28 overlay=v5 status=closed");
    expect(lines[1]).toBe("summary: 当日收口");
    expect(lines[2]).toBe("carried 1:");
    expect(text).toContain("- [06:10] fixed morning-review 晨间复盘 status=carried source=master");
    expect(text).toContain("entries 1 (carried 1)");
    expect(text).toContain("ledger: 05:00Z close v5 · 当日收口");
    expectPlainText(text);
  });
});

describe("filter", () => {
  it("read 按 status 过滤：只渲染命中条目，计数行带 filter 后缀", () => {
    const walk: EffectivePlanEntry = {
      id: "walk",
      kind: "care",
      title: "散步",
      intent: "出门走走",
      at_override: false,
      status: "done",
      source: "overlay",
      suppressed: false,
      master_version: 1,
      overlay_version: 2,
    };
    const payload: PlanReadResult = {
      date: DAY,
      master: masterDoc([masterEntry()]),
      overlay: overlayDoc(),
      effective: effectivePlan([effectiveEntry(), walk]),
      leftovers: [],
      ledger_tail: [],
    };

    const text = renderPlanOverlayText("read", payload, {
      filter: { status: ["planned"] },
    });

    expect(text).toContain("entries 1/2 (planned 1) filter=status=planned");
    expect(text).toContain("morning-review");
    expect(text).not.toContain("walk");
  });

  it("read 按 kind 过滤", () => {
    const walk: EffectivePlanEntry = {
      id: "walk",
      kind: "care",
      title: "散步",
      at_override: false,
      status: "planned",
      source: "overlay",
      suppressed: false,
      master_version: 1,
      overlay_version: 2,
    };
    const payload: PlanReadResult = {
      date: DAY,
      master: masterDoc([masterEntry()]),
      overlay: overlayDoc(),
      effective: effectivePlan([effectiveEntry(), walk]),
      leftovers: [],
      ledger_tail: [],
    };

    const text = renderPlanOverlayText("read", payload, {
      filter: { kind: ["care"] },
    });

    expect(text).toContain("entries 1/2 (planned 1) filter=kind=care");
    expect(text).toContain("care walk 散步");
    expect(text).not.toContain("morning-review");
  });

  it("read 组合 status+kind：后缀按 status、kind 顺序", () => {
    const walk: EffectivePlanEntry = {
      id: "walk",
      kind: "care",
      title: "散步",
      at_override: false,
      status: "planned",
      source: "overlay",
      suppressed: false,
      master_version: 1,
      overlay_version: 2,
    };
    const stretch: EffectivePlanEntry = {
      id: "stretch",
      kind: "care",
      title: "拉伸",
      at_override: false,
      status: "done",
      source: "overlay",
      suppressed: false,
      master_version: 1,
      overlay_version: 2,
    };
    const payload: PlanReadResult = {
      date: DAY,
      master: masterDoc([masterEntry()]),
      overlay: overlayDoc(),
      effective: effectivePlan([effectiveEntry(), walk, stretch]),
      leftovers: [],
      ledger_tail: [],
    };

    const text = renderPlanOverlayText("read", payload, {
      filter: { status: ["planned"], kind: ["care"] },
    });

    expect(text).toContain("entries 1/3 (planned 1) filter=status=planned,kind=care");
    expect(text).toContain("care walk 散步");
    expect(text).not.toContain("morning-review");
    expect(text).not.toContain("stretch");
  });

  it("read 零命中：计数行给出 0/N 与 none", () => {
    const walk: EffectivePlanEntry = {
      id: "walk",
      kind: "care",
      title: "散步",
      at_override: false,
      status: "planned",
      source: "overlay",
      suppressed: false,
      master_version: 1,
      overlay_version: 2,
    };
    const payload: PlanReadResult = {
      date: DAY,
      master: masterDoc([masterEntry()]),
      overlay: overlayDoc(),
      effective: effectivePlan([effectiveEntry(), walk]),
      leftovers: [],
      ledger_tail: [],
    };

    const text = renderPlanOverlayText("read", payload, {
      filter: { kind: ["review"] },
    });

    expect(text).toContain("entries 0/2 (none) filter=kind=review");
    expect(text).not.toContain("morning-review");
    expect(text).not.toContain("walk");
  });

  it("kind 别名归一：coverage 条目匹配 anchor 过滤值", () => {
    const anchor: EffectivePlanEntry = {
      id: "anchor-1",
      kind: "coverage",
      title: "覆盖锚点",
      at_override: false,
      status: "planned",
      source: "overlay",
      suppressed: false,
      master_version: 1,
      overlay_version: 2,
    };
    const payload: PlanReadResult = {
      date: DAY,
      master: masterDoc([masterEntry()]),
      overlay: overlayDoc(),
      effective: effectivePlan([anchor]),
      leftovers: [],
      ledger_tail: [],
    };

    const text = renderPlanOverlayText("read", payload, {
      filter: { kind: ["anchor"] },
    });

    expect(text).toContain("entries 1/1 (planned 1) filter=kind=anchor");
    expect(text).toContain("coverage anchor-1 覆盖锚点");
  });

  it("read 无有效视图：母版预览过滤，disabled 计为 archived", () => {
    const payload: PlanReadResult = {
      date: DAY,
      master: masterDoc([
        masterEntry(),
        masterEntry({
          id: "paused-anchor",
          kind: "anchor",
          title: "暂停锚点",
          enabled: false,
          schedule: { kind: "weekly", days: ["mon"], at: "03:00" },
        }),
      ]),
      overlay: null,
      effective: null,
      leftovers: [],
      ledger_tail: [],
    };

    const text = renderPlanOverlayText("read", payload, {
      filter: { status: ["archived"] },
    });

    expect(text).toContain(
      "entries 1/2 (archived 1) filter=status=archived (master preview, no daily overlay)",
    );
    expect(text).toContain("paused-anchor");
    expect(text).not.toContain("morning-review");
  });

  it("read 无有效视图：anchor 母版条目匹配 kind=coverage 过滤值", () => {
    const payload: PlanReadResult = {
      date: DAY,
      master: masterDoc([
        masterEntry(),
        masterEntry({
          id: "paused-anchor",
          kind: "anchor",
          title: "暂停锚点",
          enabled: true,
          schedule: { kind: "weekly", days: ["mon"], at: "03:00" },
        }),
      ]),
      overlay: null,
      effective: null,
      leftovers: [],
      ledger_tail: [],
    };

    const text = renderPlanOverlayText("read", payload, {
      filter: { kind: ["coverage"] },
    });

    expect(text).toContain(
      "entries 1/2 (planned 1) filter=kind=coverage (master preview, no daily overlay)",
    );
    expect(text).toContain("anchor paused-anchor 暂停锚点");
    expect(text).not.toContain("morning-review");
  });

  it("过滤只作用于条目：覆盖/告警/笔记/遗留/账本原样保留", () => {
    const leftover: PlanLeftoverItem = {
      source_date: YESTERDAY,
      id: "leftover-1",
      kind: "care",
      status: "planned",
      intent: "昨日未完成",
      at: "21:00",
    };
    const payload: PlanReadResult = {
      date: DAY,
      master: masterDoc([masterEntry()]),
      overlay: overlayDoc({ user_intent: "稳住", notes: ["早间提醒"] }),
      effective: effectivePlan([effectiveEntry()], {
        warnings: ["base_stale:1!=2"],
        notes: ["早间提醒"],
      }),
      leftovers: [leftover],
      ledger_tail: [ledgerRow({ event: "diff", version: 2, reason: "初始 diff" })],
    };

    const text = renderPlanOverlayText("read", payload, {
      filter: { status: ["done"] },
    });

    expect(text).toContain("entries 0/1 (none) filter=status=done");
    expect(text).toContain("coverage profile=merged_7 checkpoints=cov-06 debt=none");
    expect(text).toContain("user_intent: 稳住");
    expect(text).toContain("warnings: base_stale:1!=2");
    expect(text).toContain("notes 1:");
    expect(text).toContain("leftovers 2026-10-27: 1");
    expect(text).toContain("- [21:00] care leftover-1 昨日未完成 status=planned source=leftover");
    expect(text).toContain("ledger tail 1:");
  });

  it("过滤与 includeInstruction id 数组共存：显式条目仍展开且不截断", () => {
    const longInstruction = "长".repeat(400);
    const payload: PlanReadResult = {
      date: DAY,
      master: masterDoc([masterEntry()]),
      overlay: overlayDoc(),
      effective: effectivePlan([effectiveEntry({ instruction: longInstruction })]),
      leftovers: [],
      ledger_tail: [],
    };

    const text = renderPlanOverlayText("read", payload, {
      filter: { status: ["planned"] },
      includeInstruction: ["morning-review"],
    });

    expect(text).toContain("entries 1/1 (planned 1) filter=status=planned");
    expect(text).toContain(`  instruction: ${longInstruction}`);
  });

  it("diff 忽略 filter：条目计数保持原样", () => {
    const payload: PlanDiffResult = {
      date: DAY,
      overlay: overlayDoc(),
      effective: effectivePlan([effectiveEntry()]),
      ledger: ledgerRow({ event: "diff", version: 2 }),
    };

    const text = renderPlanOverlayText("diff", payload, {
      filter: { status: ["archived"] },
    });

    expect(text).toContain("entries 1 (planned 1)");
    expect(text).not.toContain("filter=");
  });
});
