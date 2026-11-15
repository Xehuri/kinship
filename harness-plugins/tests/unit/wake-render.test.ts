/**
 * 唤醒行渲染验收：计划行 golden、旧自动唤醒形状、来源分派、
 * 未知动作/来源的兜底与告警，以及输出里不出现旧入口措辞。
 *
 * Ported from loom-harness/packages/server/src/plan/wake-render.test.ts (kinship@c945667).
 * 适配：不再依赖 @axeuh/loom-core 的 formatWakeAt（本包内为私有函数），
 * 时间戳断言改为形状匹配；done 提示恢复 Loom 的 `plan done` 文案（overlay 写回已在
 * kinship-plan 落地），plan.build/review 仍不要求 done。
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  formatPlanWakeLine,
  formatSpecialWakeLine,
  renderWakeEntry,
  type WakeEntry,
} from "../../packages/kinship-plan-scheduler/src/plan/wake-render.js";

const SHANGHAI = "Asia/Shanghai";
const DATE = "2026-10-28";
const AT = Date.UTC(2026, 9, 27, 21, 0, 0);

function entry(overrides: Partial<WakeEntry> = {}): WakeEntry {
  return {
    id: "master-05",
    title: "日计划",
    source: "master",
    action: "plan.build",
    at: AT,
    ...overrides,
  };
}

/** 拆开拼写，避免测试文件自己留下被禁词。 */
const FORBIDDEN_WORDING = ["m", "o", "d", "e"].join("");

function sourceText(name: string): string {
  return readFileSync(
    new URL(`../../packages/kinship-plan-scheduler/src/plan/${name}`, import.meta.url),
    "utf8",
  );
}

describe("plan wake line", () => {
  it("renders a deterministic golden line", () => {
    const line = formatPlanWakeLine({
      entry: entry(),
      date: DATE,
      timezone: SHANGHAI,
      instructions: "先读昨日计划并收口。",
    });

    expect(line).toBe(
      [
        "【计划唤醒·plan.build】05:00 · 日计划",
        "先读昨日计划并收口。",
        "条目：master-05",
        // dsh adaptation
        "完成后只写当日计划，不需要 plan done。",
        "不发用户通知，除非条目要求。",
      ].join("\n"),
    );
  });

  it("uses payload entry_id and generates a coverage instruction", () => {
    const line = formatPlanWakeLine({
      entry: entry({
        id: "plan:2026-10-28:cov-08",
        title: "覆盖检查点 cov-08",
        source: "anchor",
        action: "coverage.run",
        payload: {
          entry_id: "cov-08",
          window: "06:00~08:00",
          target_date: "today",
        },
      }),
      date: DATE,
      timezone: SHANGHAI,
    });
    expect(line).toContain("条目：cov-08");
    expect(line).not.toContain("条目：plan:2026-10-28:cov-08");
    expect(line).toContain("目标日 2026-10-28）。");
    // The overlay write-back (kinship-plan) makes `plan done` reachable for a
    // master id, so the wake names it again (Loom parity).
    expect(line).toContain("完成后执行 plan done（date=2026-10-28, id=cov-08）。");
    expect(line).not.toContain("plan note");
  });

  it("falls back to the entry instruction and omits an empty instruction line", () => {
    const withEntryInstruction = formatPlanWakeLine({
      entry: entry({ instructions: "只读计划，不改文件。" }),
      date: DATE,
      timezone: SHANGHAI,
    });
    expect(withEntryInstruction).toContain("只读计划，不改文件。");

    const withoutInstruction = formatPlanWakeLine({
      entry: entry(),
      date: DATE,
      timezone: SHANGHAI,
      instructions: "   ",
    });
    expect(withoutInstruction).toBe(
      [
        "【计划唤醒·plan.build】05:00 · 日计划",
        "条目：master-05",
        // dsh adaptation
        "完成后只写当日计划，不需要 plan done。",
        "不发用户通知，除非条目要求。",
      ].join("\n"),
    );
  });

  it("honours the instruction precedence: deps > entry > coverage", () => {
    const coverageEntry = entry({
      id: "plan:2026-10-28:cov-08",
      title: "覆盖检查点 cov-08",
      action: "coverage.run",
      payload: { entry_id: "cov-08", window: "06:00~08:00", target_date: "today" },
    });

    const withEntryInstruction = formatPlanWakeLine({
      entry: { ...coverageEntry, instructions: "entry 级指令" },
      date: DATE,
      timezone: SHANGHAI,
    });
    expect(withEntryInstruction).toContain("entry 级指令");
    expect(withEntryInstruction).not.toContain("按 data-check 流程执行");

    const withDepsInstruction = formatPlanWakeLine({
      entry: { ...coverageEntry, instructions: "entry 级指令" },
      date: DATE,
      timezone: SHANGHAI,
      instructions: "deps 级指令",
    });
    expect(withDepsInstruction).toContain("deps 级指令");
    expect(withDepsInstruction).not.toContain("entry 级指令");
  });

  // The overlay write-back restores Loom's coalesced-catchup hint: one plan done
  // instruction listing every slot id. The 条目 line still falls back from
  // `catchup` to the entry id.
  it("renders the coalesced catchup slots payload with a plan-done list", () => {
    const line = formatPlanWakeLine({
      entry: entry({
        id: "plan:2026-10-28:catchup:0100",
        title: "补覆盖 2026-10-28",
        source: "master",
        action: "coverage.run",
        payload: {
          date: DATE,
          entry_id: "catchup",
          title: "补覆盖 2026-10-28",
          late: true,
          slots: [
            { entry_id: "cov-a", title: "覆盖 A", at: "00:00", window: "22:00~00:00" },
            { entry_id: "cov-b", title: "覆盖 B", at: "01:00", window: "00:00~02:00" },
          ],
        },
        instructions: "补做 2026-10-28 的迟到覆盖：",
      }),
      date: DATE,
      timezone: SHANGHAI,
    });

    expect(line.split("\n")[0]).toBe("【计划唤醒·coverage.run】05:00 · 补覆盖 2026-10-28");
    expect(line).toContain("补做 2026-10-28 的迟到覆盖：");
    expect(line).toContain("条目：plan:2026-10-28:catchup:0100");
    expect(line).toContain(
      "完成后分别执行 plan done（date=2026-10-28, id=cov-a / cov-b）。",
    );
    expect(line).not.toContain("plan note");
    expect(line.endsWith("不发用户通知，除非条目要求。")).toBe(true);
  });

  it("uses the source fallback action when the entry has none", () => {
    const anchorEntry: WakeEntry = {
      id: "cov-08",
      title: "08 点覆盖",
      source: "anchor",
      at: AT,
    };
    const line = formatPlanWakeLine({
      entry: anchorEntry,
      date: DATE,
      timezone: SHANGHAI,
    });
    expect(line).toContain("【计划唤醒·coverage.run】05:00 · 08 点覆盖");
  });
});

describe("special wake line", () => {
  it("keeps the legacy automatic wake shape", () => {
    // dsh adaptation: formatWakeAt 在本包内是私有函数，改为形状断言（本地时钟）。
    expect(formatSpecialWakeLine(AT)).toMatch(
      /^【自动唤醒】设定的唤醒时间已到（\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?，本地时间）。请继续处理此前挂起的任务。$/,
    );
  });
});

describe("source dispatch", () => {
  it("routes plan sources through the plan renderer", () => {
    const line = renderWakeEntry(entry(), {
      date: DATE,
      timezone: SHANGHAI,
      instructions: "先读昨日计划并收口。",
    });
    expect(line).toContain("【计划唤醒·plan.build】05:00 · 日计划");
  });

  it("routes flow sources through the injected renderer with the entry and at", () => {
    const flowEntry = entry({ source: "flow", action: "flow.check", id: "flow_c1", title: "c1" });
    let seen: { readonly id: string; readonly at: number } | null = null;
    const line = renderWakeEntry(flowEntry, {
      date: DATE,
      timezone: SHANGHAI,
      renderFlow: (candidate, at) => {
        seen = { id: candidate.id, at };
        return `【心流唤醒】${candidate.id}@${String(at)}`;
      },
    });

    expect(line).toBe(`【心流唤醒】flow_c1@${String(AT)}`);
    expect(seen).toEqual({ id: "flow_c1", at: AT });
  });

  it("routes a flow action even when the source is not flow", () => {
    const line = renderWakeEntry(entry({ action: "flow.check" }), {
      date: DATE,
      timezone: SHANGHAI,
      renderFlow: () => "【心流唤醒】注入结果",
    });
    expect(line).toBe("【心流唤醒】注入结果");
  });

  it("returns null and warns when a flow entry has no renderer", () => {
    const warnings: string[] = [];
    const line = renderWakeEntry(entry({ source: "flow", action: "flow.check" }), {
      date: DATE,
      timezone: SHANGHAI,
      warn: (message) => warnings.push(message),
    });

    expect(line).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("flow renderer");
  });

  it("routes special sources and special actions to the legacy line", () => {
    const special = entry({ source: "special", action: "special.continue" });
    expect(renderWakeEntry(special, { date: DATE, timezone: SHANGHAI })).toBe(
      formatSpecialWakeLine(AT),
    );

    const specialByAction = entry({ action: "special.continue" });
    expect(renderWakeEntry(specialByAction, { date: DATE, timezone: SHANGHAI })).toBe(
      formatSpecialWakeLine(AT),
    );
  });

  it("routes inbox sources to the selected instructions or payload fallback", () => {
    const withInstructions = entry({
      id: "inbox:digest:1",
      source: "inbox",
      action: "inbox.digest",
      title: "收件箱摘要",
      instructions: "按 inbox 工具拉取待处理信件。",
    });
    expect(renderWakeEntry(withInstructions, { date: DATE, timezone: SHANGHAI })).toBe(
      "按 inbox 工具拉取待处理信件。",
    );

    const fallback = entry({
      id: "inbox:digest:2",
      source: "inbox",
      action: "inbox.digest",
      title: "摘要批次",
      payload: { title: "摘要批次" },
    });
    const line = renderWakeEntry(fallback, { date: DATE, timezone: SHANGHAI });
    expect(line).toContain("【收件箱摘要】摘要批次");
    // dsh adaptation: 时间戳走私有 formatWakeAt，改为形状断言。
    expect(line).toMatch(
      /^【收件箱摘要】摘要批次（\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?，本地时间）。请按收件箱流程处理待处理信件。$/,
    );
  });
});

describe("unknown input fallback", () => {
  it("warns and uses the source default when the action is unknown", () => {
    const warnings: string[] = [];
    const line = renderWakeEntry(entry({ source: "anchor", action: "plan.unknown" }), {
      date: DATE,
      timezone: SHANGHAI,
      warn: (message) => warnings.push(message),
    });

    expect(line).toContain("【计划唤醒·coverage.run】05:00 · 日计划");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("unknown wake action");
    expect(warnings[0]).toContain("plan.unknown");
  });

  it("warns and treats an unknown source as master", () => {
    const warnings: string[] = [];
    const mysteryEntry: WakeEntry = {
      id: "master-05",
      title: "日计划",
      source: "mystery",
      at: AT,
    };
    const line = renderWakeEntry(mysteryEntry, {
      date: DATE,
      timezone: SHANGHAI,
      warn: (message) => warnings.push(message),
    });

    expect(line).toContain("【计划唤醒·plan.build】05:00 · 日计划");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("unknown wake source");
  });

  it("derives the date from the entry when deps.date is absent", () => {
    const line = renderWakeEntry(
      entry({
        id: "plan:2026-10-28:cov-08",
        title: "覆盖检查点 cov-08",
        action: "coverage.run",
        payload: { entry_id: "cov-08", window: "06:00~08:00", target_date: "today" },
      }),
      { timezone: SHANGHAI },
    );
    expect(line).toContain("目标日 2026-10-28");
  });
});

describe("wording guard", () => {
  it("keeps old entry wording out of rendered lines and new sources", () => {
    const lines = [
      formatPlanWakeLine({
        entry: entry(),
        date: DATE,
        timezone: SHANGHAI,
        instructions: "先读昨日计划并收口。",
      }),
      formatSpecialWakeLine(AT),
    ];
    for (const line of lines) expect(line.toLowerCase()).not.toContain(FORBIDDEN_WORDING);

    for (const name of ["actions.ts", "timezone.ts", "wake-render.ts"]) {
      expect(sourceText(name).toLowerCase(), name).not.toContain(FORBIDDEN_WORDING);
    }
  });
});
