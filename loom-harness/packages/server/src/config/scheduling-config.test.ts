/**
 * scheduling 配置段：缺省不物化、全键解析、枚举/正整数/时区校验、未知键容忍。
 */

import { describe, expect, it } from "vitest";

import { LoomConfigError, parseLoomConfig } from "./loom-config.js";

const BASE = `
server:
  port: 5097
  hostname: 127.0.0.1
workspace: /srv/loom/fixture-workspace
models:
  - id: m1
    provider: fake
    contextWindow: 1000
    maxOutput: 100
    timeout: 5000
pricing:
  fake:
    input: 0
    output: 0
`;

function errorsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error: unknown) {
    if (error instanceof LoomConfigError) return [...error.errors];
    throw error;
  }
  return [];
}

describe("scheduling 配置段", () => {
  it("整段缺省 = undefined 不物化", () => {
    const cfg = parseLoomConfig(BASE, "<test>");
    expect(cfg.scheduling).toBeUndefined();
    expect("scheduling" in cfg).toBe(false);
  });

  it("全键合法 = 逐值解析", () => {
    const yaml = `${BASE}
scheduling:
  wakeQueue: live
  planScheduler: shadow
  watchdogMs: 60000
  horizonHours: 72
  catchupMaxAgeHours: 24
  debtAfterHours: 12
  timezone: Asia/Shanghai
  sessionId: ses_test
`;
    const cfg = parseLoomConfig(yaml, "<test>");
    expect(cfg.scheduling).toEqual({
      wakeQueue: "live",
      planScheduler: "shadow",
      watchdogMs: 60000,
      horizonHours: 72,
      catchupMaxAgeHours: 24,
      debtAfterHours: 12,
      timezone: "Asia/Shanghai",
      sessionId: "ses_test",
    });
  });

  it("枚举非法值 → 精确错误点名键名", () => {
    for (const key of ["wakeQueue", "planScheduler"]) {
      const errs = errorsOf(() =>
        parseLoomConfig(`${BASE}\nscheduling:\n  ${key}: enqueue\n`, "<test>"),
      );
      expect(
        errs.some((e) => e.includes(`scheduling.${key}`) && e.includes('"live"')),
        `应拒 ${key}`,
      ).toBe(true);
    }
  });

  it("anchors 缺省 = 不物化；自定义值原样解析", () => {
    const absent = parseLoomConfig(`${BASE}\nscheduling:\n  wakeQueue: live\n`, "<test>");
    expect(absent.scheduling?.anchors).toBeUndefined();
    expect("anchors" in (absent.scheduling ?? {})).toBe(false);

    const custom = parseLoomConfig(
      `${BASE}\nscheduling:\n  anchors: ["06:15", "21:45"]\n`,
      "<test>",
    );
    expect(custom.scheduling?.anchors).toEqual(["06:15", "21:45"]);
  });

  it("anchors 非法时刻 → 精确错误点名 scheduling.anchors", () => {
    for (const bad of ["6:15", "24:00", "05:60", "05:00:00", "ab:cd", 615]) {
      const value = typeof bad === "number" ? String(bad) : JSON.stringify(bad);
      const errs = errorsOf(() =>
        parseLoomConfig(`${BASE}\nscheduling:\n  anchors: [${value}]\n`, "<test>"),
      );
      expect(
        errs.some((e) => e.includes("scheduling.anchors")),
        `应拒 ${String(bad)}`,
      ).toBe(true);
    }
  });

  it("anchors 重复时刻 → 精确错误点名 scheduling.anchors", () => {
    const errs = errorsOf(() =>
      parseLoomConfig(`${BASE}\nscheduling:\n  anchors: ["05:00", "05:00"]\n`, "<test>"),
    );
    expect(
      errs.some((e) => e.includes("scheduling.anchors") && e.includes("重复")),
    ).toBe(true);
  });

  it("anchors 空数组与非数组 → 精确错误点名 scheduling.anchors", () => {
    const empty = errorsOf(() =>
      parseLoomConfig(`${BASE}\nscheduling:\n  anchors: []\n`, "<test>"),
    );
    expect(empty.some((e) => e.includes("scheduling.anchors"))).toBe(true);
    const notArray = errorsOf(() =>
      parseLoomConfig(`${BASE}\nscheduling:\n  anchors: "05:00"\n`, "<test>"),
    );
    expect(notArray.some((e) => e.includes("scheduling.anchors"))).toBe(true);
  });

  it("anchors 超过 8 个 → 精确错误点名 scheduling.anchors", () => {
    const nine = ["00:00", "01:00", "02:00", "03:00", "04:00", "05:00", "06:00", "07:00", "08:00"];
    const errs = errorsOf(() =>
      parseLoomConfig(
        `${BASE}\nscheduling:\n  anchors: [${nine.map((value) => JSON.stringify(value)).join(", ")}]\n`,
        "<test>",
      ),
    );
    expect(
      errs.some((e) => e.includes("scheduling.anchors") && e.includes("最多 8")),
    ).toBe(true);
  });

  it("正整数键 0/负数 → 精确错误点名键名", () => {
    for (const key of ["watchdogMs", "horizonHours", "catchupMaxAgeHours", "debtAfterHours"]) {
      for (const bad of ["0", "-1"]) {
        const errs = errorsOf(() =>
          parseLoomConfig(`${BASE}\nscheduling:\n  ${key}: ${bad}\n`, "<test>"),
        );
        expect(
          errs.some((e) => e.includes(`scheduling.${key}`) && e.includes("需要 ≥1 的整数")),
          `应拒 ${key}: ${bad}`,
        ).toBe(true);
      }
    }
  });

  it("timezone 空串 → 非空字符串错误", () => {
    const errs = errorsOf(() =>
      parseLoomConfig(`${BASE}\nscheduling:\n  timezone: ""\n`, "<test>"),
    );
    expect(
      errs.some((e) => e.includes("scheduling.timezone") && e.includes("非空字符串")),
    ).toBe(true);
  });

  it("未知键静默容忍（只物化已知键）", () => {
    const yaml = `${BASE}
scheduling:
  wakeQueue: off
  futureKnob: 42
  nested:
    x: 1
`;
    const cfg = parseLoomConfig(yaml, "<test>");
    expect(cfg.scheduling).toEqual({ wakeQueue: "off" });
  });

  it("空段 = 空对象；非映射 → 需要映射", () => {
    const empty = parseLoomConfig(`${BASE}\nscheduling: {}\n`, "<test>");
    expect(empty.scheduling).toEqual({});
    const errs = errorsOf(() =>
      parseLoomConfig(`${BASE}\nscheduling: "x"\n`, "<test>"),
    );
    expect(errs.some((e) => e.includes("scheduling") && e.includes("需要映射"))).toBe(true);
  });
});
