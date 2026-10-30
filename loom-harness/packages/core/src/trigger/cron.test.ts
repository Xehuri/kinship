/**
 * T15 cron parser 验收（docs/02 §T15 TDD：clock-injected schedule test first）。
 *
 * 本文件冻结 **parser + 匹配语义**（纯函数、表驱动，无时钟）：
 *   1. 五字段合法性（字段数、空表达式）；
 *   2. 展开语义：`*` / `a` / `a-b` / `a/b` / `a-b/c` / 逗号并列；
 *   3. 取值域越界、区间倒序、零步长、非整数、多余逗号/斜杠 → 类型化抛错；
 *   4. 周日 7 → 0 归一；
 *   5. 本地时间字段匹配（分/时/日/月/周）；
 *   6. 日/周 OR 语义（两字段都受限时满足其一即命中；任一 `*` 则退化为 AND）。
 *
 * 全部用本地 `new Date(y,m,d,h,mi)` 构造（matches 只读本地 getter），无时区依赖。
 */

import { describe, expect, it } from "vitest";
import { CronParseError, cronMatches, matchesCron, parseCron } from "./cron.js";

/** 便捷：本地时刻。 */
function at(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

/** 取字段展开集合并排序（断言友好）。 */
function values(expr: string, field: "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek"): number[] {
  return [...parseCron(expr).fields[field].values].sort((a, b) => a - b);
}

/* ────────────── 1：五字段形状 ────────────── */

describe("parseCron 字段形状", () => {
  it("恰好五字段解析成功并规范化 source", () => {
    const e = parseCron("  30   0  *  *  * ");
    expect(e.source).toBe("30 0 * * *");
    expect(e.domRestricted).toBe(false);
    expect(e.dowRestricted).toBe(false);
  });

  it.each([
    ["", "空表达式"],
    ["   ", "全空白"],
    ["* * * *", "四字段"],
    ["* * * * * *", "六字段"],
  ])("非法表达式 %j 抛 CronParseError（%s）", (src) => {
    expect(() => parseCron(src)).toThrow(CronParseError);
  });

  it("CronParseError 带 field 标签与 [cron:...] 前缀", () => {
    try {
      parseCron("60 * * * *");
      throw new Error("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(CronParseError);
      const e = err as CronParseError;
      expect(e.field).toBe("minute");
      expect(e.message.startsWith("[cron:minute]")).toBe(true);
    }
  });
});

/* ────────────── 2：展开语义 ────────────── */

describe("字段展开语义", () => {
  it("`*` 全量", () => {
    expect(values("* * * * *", "minute")).toHaveLength(60);
    expect(values("* * * * *", "hour")).toHaveLength(24);
    expect(values("* * * * *", "dayOfMonth")).toHaveLength(31);
    expect(values("* * * * *", "month")).toHaveLength(12);
  });

  it("单值 `a`", () => {
    expect(values("30 * * * *", "minute")).toEqual([30]);
  });

  it("闭区间 `a-b`", () => {
    expect(values("* 9-11 * * *", "hour")).toEqual([9, 10, 11]);
  });

  it("步进 `*/15`", () => {
    expect(values("*/15 * * * *", "minute")).toEqual([0, 15, 30, 45]);
  });

  it("区间步进 `1-5/2`", () => {
    expect(values("1-5/2 * * * *", "minute")).toEqual([1, 3, 5]);
  });

  it("起点步进 `n/step`（从 n 到上界）", () => {
    expect(values("10/20 * * * *", "minute")).toEqual([10, 30, 50]);
  });

  it("逗号并列多段", () => {
    expect(values("0,30 * * * *", "minute")).toEqual([0, 30]);
    expect(values("1-5/2,30 * * * *", "minute")).toEqual([1, 3, 5, 30]);
  });

  it("周日 7 归一为 0", () => {
    expect(values("* * * * 7", "dayOfWeek")).toEqual([0]);
    expect(values("* * * * 0", "dayOfWeek")).toEqual([0]);
    expect(values("* * * * 1-7", "dayOfWeek")).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

/* ────────────── 3：非法输入 fail-loud ────────────── */

describe("非法字段 fail-loud", () => {
  it.each([
    ["60 * * * *", "分越界"],
    ["* 24 * * *", "时越界"],
    ["* * 0 * *", "日下界越界（0）"],
    ["* * 32 * *", "日上界越界"],
    ["* * * 0 *", "月越界"],
    ["* * * * 8", "周越界"],
    ["10-5 * * * *", "区间倒序"],
    ["*/0 * * * *", "零步长"],
    ["*/x * * * *", "步长非整数"],
    ["a * * * *", "非整数单值"],
    ["1,,2 * * * *", "多余逗号"],
    ["1//2 * * * *", "多余斜杠"],
    ["- * * * *", "空区间端"],
  ])("`%s`（%s）抛 CronParseError", (src) => {
    expect(() => parseCron(src)).toThrow(CronParseError);
  });
});

/* ────────────── 4：本地时间匹配 ────────────── */

describe("matchesCron 本地时间匹配", () => {
  const daily = parseCron("30 0 * * *"); // 每天 00:30

  it("命中精确到分钟", () => {
    expect(matchesCron(daily, at(2026, 1, 5, 0, 30))).toBe(true);
  });

  it("差一分钟不命中", () => {
    expect(matchesCron(daily, at(2026, 1, 5, 0, 29))).toBe(false);
    expect(matchesCron(daily, at(2026, 1, 5, 0, 31))).toBe(false);
  });

  it("小时不匹配则不命中", () => {
    expect(matchesCron(daily, at(2026, 1, 5, 1, 30))).toBe(false);
  });

  it("cronMatches 是 matchesCron 别名", () => {
    expect(cronMatches(daily, at(2026, 1, 5, 0, 30))).toBe(matchesCron(daily, at(2026, 1, 5, 0, 30)));
  });

  it("月/日限定命中", () => {
    const monthly = parseCron("30 18 1,15 * *");
    expect(matchesCron(monthly, at(2026, 1, 15, 18, 30))).toBe(true);
    expect(matchesCron(monthly, at(2026, 1, 14, 18, 30))).toBe(false);
    expect(matchesCron(monthly, at(2026, 2, 15, 18, 30))).toBe(true);
  });

  it("周限定命中（周一 03:00）", () => {
    const weekly = parseCron("0 3 * * 1");
    expect(at(2026, 1, 5, 3, 0).getDay()).toBe(1); // 前置断言：2026-01-05 是周一
    expect(matchesCron(weekly, at(2026, 1, 5, 3, 0))).toBe(true);
    expect(matchesCron(weekly, at(2026, 1, 6, 3, 0))).toBe(false); // 周二
  });
});

/* ────────────── 5：日/周 OR 语义 ────────────── */

describe("日/周 OR 语义（vixie 惯例）", () => {
  // 每月 1 号 或 每周一 的 00:00
  const orExpr = parseCron("0 0 1 * 1");

  it("命中「是 1 号」而「非周一」", () => {
    // 2026-04-01 是周三
    const d = at(2026, 4, 1, 0, 0);
    expect(d.getDay()).toBe(3);
    expect(matchesCron(orExpr, d)).toBe(true);
  });

  it("命中「是周一」而「非 1 号」", () => {
    const d = at(2026, 1, 5, 0, 0); // 周一
    expect(d.getDay()).toBe(1);
    expect(d.getDate()).not.toBe(1);
    expect(matchesCron(orExpr, d)).toBe(true);
  });

  it("两者皆非则不命中", () => {
    const d = at(2026, 1, 6, 0, 0); // 周二、非 1 号
    expect(matchesCron(orExpr, d)).toBe(false);
  });

  it("日字段为 `*` 时退化为 AND（周单独判定）", () => {
    const dowOnly = parseCron("0 0 * * 1");
    expect(matchesCron(dowOnly, at(2026, 1, 5, 0, 0))).toBe(true); // 周一
    expect(matchesCron(dowOnly, at(2026, 1, 6, 0, 0))).toBe(false); // 周二
  });

  it("周字段为 `*` 时退化为 AND（日单独判定）", () => {
    const domOnly = parseCron("0 0 15 * *");
    expect(matchesCron(domOnly, at(2026, 1, 15, 0, 0))).toBe(true);
    expect(matchesCron(domOnly, at(2026, 1, 14, 0, 0))).toBe(false);
  });
});
