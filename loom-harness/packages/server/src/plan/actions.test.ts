/**
 * 唤醒动作词表验收：14 个动作每个都有覆盖/静默裁决，来源兜底完整，
 * 新源码不出现旧入口措辞，也不使用类型逃逸。
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  WAKE_ACTIONS,
  WAKE_SOURCES,
  actionIsSilent,
  actionRequiresCoverage,
  defaultActionFor,
  isWakeAction,
  isWakeSource,
  type WakeAction,
  type WakeSource,
} from "./actions.js";

const EXPECTED_COVERAGE: Readonly<Record<WakeAction, boolean>> = {
  "plan.build": false,
  "plan.review": false,
  "coverage.run": true,
  "review.daily": true,
  "review.weekly": true,
  "review.biweekly": true,
  "audit.night": true,
  "weather.morning": false,
  "session.compact": false,
  "probe.run": false,
  "fleet.run": false,
  "longterm.due": false,
  "flow.check": false,
  "special.continue": false,
};

const EXPECTED_SILENT: Readonly<Record<WakeAction, boolean>> = {
  "plan.build": true,
  "plan.review": true,
  "coverage.run": true,
  "review.daily": false,
  "review.weekly": false,
  "review.biweekly": false,
  "audit.night": true,
  "weather.morning": false,
  "session.compact": true,
  "probe.run": true,
  "fleet.run": true,
  "longterm.due": false,
  "flow.check": true,
  "special.continue": false,
};

const EXPECTED_SOURCE_DEFAULTS: Readonly<Record<WakeSource, WakeAction>> = {
  master: "plan.build",
  anchor: "coverage.run",
  long_term: "longterm.due",
  flow: "flow.check",
  special: "special.continue",
};

/** 拆开拼写，避免测试文件自己留下被禁词。 */
const FORBIDDEN_WORDING = ["m", "o", "d", "e"].join("");
const ANY_CAST = ["as", "any"].join(" ");
const IGNORE_DIRECTIVE = ["@ts", "ignore"].join("-");

function sourceText(name: string): string {
  return readFileSync(new URL(name, import.meta.url), "utf8");
}

describe("wake action vocabulary", () => {
  it("lists each action exactly once", () => {
    expect(WAKE_ACTIONS).toHaveLength(14);
    expect(new Set(WAKE_ACTIONS).size).toBe(WAKE_ACTIONS.length);
  });

  it("gives every action an explicit coverage and silent decision", () => {
    for (const action of WAKE_ACTIONS) {
      expect(actionRequiresCoverage(action), `coverage: ${action}`).toBe(
        EXPECTED_COVERAGE[action],
      );
      expect(actionIsSilent(action), `silent: ${action}`).toBe(EXPECTED_SILENT[action]);
    }
  });

  it("falls back to one action per source when the id is not an action", () => {
    for (const source of WAKE_SOURCES) {
      expect(defaultActionFor(source, "unknown-entry")).toBe(
        EXPECTED_SOURCE_DEFAULTS[source],
      );
    }
  });

  it("prefers an id that is itself an action and keeps known task ids", () => {
    for (const action of WAKE_ACTIONS) {
      expect(defaultActionFor("master", action)).toBe(action);
    }
    expect(defaultActionFor("master", "05-plan-wake")).toBe("plan.build");
    expect(defaultActionFor("master", "07-plan-review")).toBe("plan.review");
    expect(defaultActionFor("master", "12-daily-review")).toBe("review.daily");
    expect(defaultActionFor("master", "13-biweekly-review")).toBe("review.biweekly");
    expect(defaultActionFor("master", "14-weekly-summary")).toBe("review.weekly");
    expect(defaultActionFor("master", "15-night-audit")).toBe("audit.night");
  });

  it("narrows actions and sources without accepting neighbors", () => {
    expect(isWakeAction("plan.build")).toBe(true);
    expect(isWakeAction("plan.build.extra")).toBe(false);
    expect(isWakeAction(undefined)).toBe(false);
    expect(isWakeSource("anchor")).toBe(true);
    expect(isWakeSource("main")).toBe(false);
  });

  it("keeps old entry wording and type escapes out of the new sources", () => {
    for (const name of ["actions.ts", "timezone.ts", "wake-render.ts"]) {
      const text = sourceText(name);
      expect(text.toLowerCase(), name).not.toContain(FORBIDDEN_WORDING);
      expect(text, name).not.toContain(ANY_CAST);
      expect(text, name).not.toContain(IGNORE_DIRECTIVE);
    }
  });
});
