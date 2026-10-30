/**
 * wake 解析器验收：模型给的**单个**时间串 → 绝对 epoch-ms 唤醒点或显式清除。
 *
 *   - 倒计时（ms/s/m/h/d/秒/分/分钟/时/小时/天/日）按 token 求和；
 *   - none 大小写不敏感，表示清除唤醒；
 *   - 带时区 ISO 用绝对时刻；无时区本地时间用本地日历构造；
 *   - 纯钟点取下一个严格未来的本地 occurrence；
 *   - 绝对形式拒绝过去/此刻，全部形式拒绝超过 30 天；
 *   - 周期语法（cron）不是一次性唤醒，一律拒绝。
 *
 * 本地时间断言一律用 new Date(y, mo-1, d, h, mi, s) 构造期望值，保证测试跨时区可移植。
 */

import { describe, expect, it } from "vitest";
import { WAKE_MAX_HORIZON_MS, formatWakeAt, resolveWakeSpec } from "./wake.js";

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0); // 2026-10-21T12:00:00Z

function expectAt(spec: string, at: number, now = NOW): void {
  expect(resolveWakeSpec(spec, now)).toEqual({ ok: true, at });
}

function expectRejected(spec: string, reason?: string, now = NOW): void {
  const result = resolveWakeSpec(spec, now);
  expect(result.ok).toBe(false);
  if (!result.ok && reason !== undefined) {
    expect(result.reason).toBe(reason);
  }
}

/** 规范里的钟点语义：今天该时刻严格晚于 now 就取今天，否则明天（本地日历构造）。 */
function expectedNextClock(now: number, hour: number, minute: number): number {
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0).getTime();
  if (today > now) return today;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, hour, minute, 0, 0).getTime();
}

describe("resolveWakeSpec 倒计时", () => {
  it.each([
    ["30s", 30_000],
    ["10m", 600_000],
    ["1h30m", 5_400_000],
    ["2d", 172_800_000],
    ["30秒", 30_000],
    ["10分钟", 600_000],
    ["1小时30分", 5_400_000],
    ["2天", 172_800_000],
    ["1h 30m", 5_400_000],
    ["1d2h3m4s", 93_784_000],
    ["500ms", 500],
    ["1分", 60_000],
    ["1时", 3_600_000],
    ["1日", 86_400_000],
  ] as const)("%s → now + %i ms", (spec, delta) => {
    expectAt(spec, NOW + delta);
  });

  it("整数 token 可混用中英文单位并累加", () => {
    expectAt("1小时 30分 15秒", NOW + 5_415_000);
  });

  it("非正时长、负数、小数、尾随垃圾一律拒绝", () => {
    expectRejected("0s", "时长必须大于 0");
    expectRejected("1.5h");
    expectRejected("-5m");
    expectRejected("10x");
    expectRejected("1h30");
    expectRejected("abc");
    expectRejected("1h 30");
  });
});

describe("resolveWakeSpec none", () => {
  it.each(["none", "NONE", " None "])("%s → 显式清除", (spec) => {
    expect(resolveWakeSpec(spec, NOW)).toEqual({ ok: true, at: null });
  });
});

describe("resolveWakeSpec 带时区 ISO", () => {
  it.each([
    ["2026-10-22T09:30:00Z", Date.UTC(2026, 9, 22, 9, 30, 0)],
    ["2026-10-22T09:30Z", Date.UTC(2026, 9, 22, 9, 30, 0)],
    ["2026-10-22 09:30:00+08:00", Date.UTC(2026, 9, 22, 1, 30, 0)],
    ["2026-10-22T09:30:00.250Z", Date.UTC(2026, 9, 22, 9, 30, 0, 250)],
    ["2026-10-22T01:30:00-05:00", Date.UTC(2026, 9, 22, 6, 30, 0)],
  ] as const)("%s → 绝对 epoch", (spec, at) => {
    expectAt(spec, at);
  });
});

describe("resolveWakeSpec 本地日期时间", () => {
  it("无时区 datetime 用本地日历构造，不依赖 Date.parse", () => {
    expectAt("2026-10-22T09:30", new Date(2026, 9, 22, 9, 30, 0, 0).getTime());
    expectAt("2026-10-22 09:30:15", new Date(2026, 9, 22, 9, 30, 15, 0).getTime());
  });

  it("非法日历日（2 月 30 日）拒绝而不是滚动到下月", () => {
    expectRejected("2026-02-30T10:00", "无法识别的时间格式");
  });
});

describe("resolveWakeSpec 钟点", () => {
  it.each(["18:30", "9:05"])("%s → 下一个严格未来的本地钟点", (spec) => {
    const [hour, minute] = spec.split(":").map(Number);
    expectAt(spec, expectedNextClock(NOW, hour ?? 0, minute ?? 0));
  });

  it("非法的时/分拒绝", () => {
    expectRejected("25:00", "无法识别的时间格式");
    expectRejected("12:60", "无法识别的时间格式");
    expectRejected("12:5", "无法识别的时间格式");
  });
});

describe("resolveWakeSpec 过去与边界", () => {
  it("过去与恰好此刻的绝对时间拒绝", () => {
    expectRejected("2026-10-21T11:59:59Z", "时间已过去");
    expectRejected("2026-10-21T12:00:00Z", "时间已过去");
    expectRejected("2026-10-21T12:00:00+00:00", "时间已过去");
  });

  it("30 天整接受，30 天 + 1ms 拒绝", () => {
    const boundary = NOW + WAKE_MAX_HORIZON_MS;
    expectAt(new Date(boundary).toISOString(), boundary);
    expectRejected(new Date(boundary + 1).toISOString(), "超出最长 30 天");
  });

  it("倒计时同样受 30 天上限约束", () => {
    expectAt("30d", NOW + WAKE_MAX_HORIZON_MS);
    expectRejected("31d", "超出最长 30 天");
  });
});

describe("resolveWakeSpec 无法识别", () => {
  it.each([
    "",
    "   ",
    "2026-10-22",
    "2026-13-01T00:00:00Z",
    "2026-02-30T00:00:00Z",
    "cron * * * * *",
    "*/5 * * * *",
    "every 10m",
  ])("%j 拒绝", (spec) => {
    expectRejected(spec, spec.trim() === "" ? "不能为空" : "无法识别的时间格式");
  });
});

describe("formatWakeAt", () => {
  it("零填充到 YYYY-MM-DD HH:MM，秒为 0 时不追加", () => {
    expect(formatWakeAt(new Date(2026, 9, 22, 9, 5, 0, 0).getTime())).toBe("2026-10-22 09:05");
    expect(formatWakeAt(new Date(2026, 5, 1, 0, 0, 0, 0).getTime())).toBe("2026-06-01 00:00");
  });

  it("秒非 0 时追加零填充的 :SS", () => {
    expect(formatWakeAt(new Date(2026, 0, 2, 3, 4, 7, 0).getTime())).toBe("2026-01-02 03:04:07");
    expect(formatWakeAt(new Date(2026, 11, 31, 23, 59, 9, 0).getTime())).toBe(
      "2026-12-31 23:59:09",
    );
  });
});
