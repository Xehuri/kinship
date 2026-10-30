/**
 * Flow 时间边界验收：与 converge wake 同族输入，但按台账字段策略套边界。
 * 本地时间断言一律用本地日历构造，保证测试跨时区可移植。
 */

import { describe, expect, it } from "vitest";
import {
  FLOW_DISPLAY_TIME_ZONE,
  FLOW_LIMITS,
  clampNextDecisionAt,
  formatFlowTime,
  isValidTimeZone,
  parseFlowTime,
  resolveDeadlineTime,
  resolveNextDecisionAt,
} from "./index.js";

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0); // 2026-10-23T12:00:00Z

function expectedNextClock(now: number, hour: number, minute: number): number {
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0).getTime();
  if (today > now) return today;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, hour, minute, 0, 0).getTime();
}

describe("parseFlowTime 输入族", () => {
  it.each([
    ["2h", 7_200_000],
    ["30m", 1_800_000],
    ["1h30m", 5_400_000],
    ["2天", 172_800_000],
    ["500ms", 500],
    ["1小时 30分", 5_400_000],
  ] as const)("倒计时 %s 解析为 now + %i ms", (spec, delta) => {
    expect(parseFlowTime(spec, NOW)).toEqual({ ok: true, at: NOW + delta });
  });

  it("带时区 ISO 解析为绝对时刻", () => {
    expect(parseFlowTime("2026-10-24T09:30:00+08:00", NOW)).toEqual({
      ok: true,
      at: Date.UTC(2026, 9, 24, 1, 30, 0),
    });
    expect(parseFlowTime("2026-10-23T20:00:00Z", NOW)).toEqual({
      ok: true,
      at: Date.UTC(2026, 9, 23, 20, 0, 0),
    });
  });

  it("无时区本地日期时间用本地日历构造，不依赖 Date.parse", () => {
    expect(parseFlowTime("2026-10-24T09:30", NOW)).toEqual({
      ok: true,
      at: new Date(2026, 9, 24, 9, 30, 0, 0).getTime(),
    });
  });

  it("HH:MM 取下一个严格未来的本地钟点", () => {
    expect(parseFlowTime("18:30", NOW)).toEqual({
      ok: true,
      at: expectedNextClock(NOW, 18, 30),
    });
  });

  it("number 视为 epoch 毫秒", () => {
    expect(parseFlowTime(NOW + 1_234, NOW)).toEqual({ ok: true, at: NOW + 1_234 });
  });

  it.each([null, undefined, "", "   ", "none", "NONE", " None "])(
    "%j 解析为显式清空",
    (spec) => {
      expect(parseFlowTime(spec, NOW)).toEqual({ ok: true, at: null });
    },
  );

  it.each([
    ["cron * * * * *"],
    ["2026-02-30T10:00"],
    ["0s"],
    ["1.5h"],
    ["-5m"],
    ["abc"],
    ["2026-10-24"],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
  ])("%j 拒绝", (spec) => {
    expect(parseFlowTime(spec, NOW).ok).toBe(false);
  });
});

describe("resolveNextDecisionAt 钳制", () => {
  it("低于 now+5s 的值钳到下限", () => {
    expect(resolveNextDecisionAt("1s", NOW)).toEqual({
      ok: true,
      at: NOW + FLOW_LIMITS.minWakeLeadMs,
    });
    expect(resolveNextDecisionAt(NOW + 2_000, NOW)).toEqual({
      ok: true,
      at: NOW + FLOW_LIMITS.minWakeLeadMs,
    });
  });

  it("恰好 5s 不被改动，6s 保持原值", () => {
    expect(resolveNextDecisionAt("5s", NOW)).toEqual({
      ok: true,
      at: NOW + FLOW_LIMITS.minWakeLeadMs,
    });
    expect(resolveNextDecisionAt("6s", NOW)).toEqual({ ok: true, at: NOW + 6_000 });
  });

  it("超过 30 天的值钳到上限（含过去时刻）", () => {
    expect(resolveNextDecisionAt("31d", NOW)).toEqual({
      ok: true,
      at: NOW + FLOW_LIMITS.maxWakeHorizonMs,
    });
    expect(resolveNextDecisionAt("2026-10-23T11:00:00Z", NOW)).toEqual({
      ok: true,
      at: NOW + FLOW_LIMITS.minWakeLeadMs,
    });
  });

  it("null/none 保持清空语义", () => {
    expect(resolveNextDecisionAt(null, NOW)).toEqual({ ok: true, at: null });
    expect(resolveNextDecisionAt("none", NOW)).toEqual({ ok: true, at: null });
  });

  it("clampNextDecisionAt 在边界内原样返回", () => {
    const at = NOW + 60_000;
    expect(clampNextDecisionAt(at, NOW)).toBe(at);
  });
});

describe("resolveDeadlineTime 拒绝过去", () => {
  it("未来时刻原样保留", () => {
    const at = Date.UTC(2026, 9, 24, 12, 0, 0);
    expect(resolveDeadlineTime("2026-10-24T12:00:00Z", NOW)).toEqual({ ok: true, at });
    expect(resolveDeadlineTime("1ms", NOW)).toEqual({ ok: true, at: NOW + 1 });
  });

  it("过去与恰好此刻拒绝", () => {
    expect(resolveDeadlineTime("2026-10-23T11:59:59Z", NOW)).toEqual({
      ok: false,
      reason: "时间必须晚于当前",
    });
    expect(resolveDeadlineTime("2026-10-23T12:00:00Z", NOW)).toEqual({
      ok: false,
      reason: "时间必须晚于当前",
    });
  });

  it("null/none 表示清空", () => {
    expect(resolveDeadlineTime(null, NOW)).toEqual({ ok: true, at: null });
    expect(resolveDeadlineTime("none", NOW)).toEqual({ ok: true, at: null });
  });
});

describe("isValidTimeZone", () => {
  it.each(["UTC", "Asia/Shanghai", "Europe/Berlin", "America/New_York"])(
    "%s 合法",
    (zone) => {
      expect(isValidTimeZone(zone)).toBe(true);
    },
  );

  it.each(["", "   ", "Mars/Base", "Asia/Not_A_City"])("%j 非法", (zone) => {
    expect(isValidTimeZone(zone)).toBe(false);
  });
});

describe("formatFlowTime 模型可见时间", () => {
  const FIXED = Date.UTC(2026, 9, 23, 6, 11, 54, 267);

  it("默认时区为 Asia/Shanghai，输出墙钟 + 显式偏移并保留毫秒", () => {
    expect(FLOW_DISPLAY_TIME_ZONE).toBe("Asia/Shanghai");
    expect(formatFlowTime(FIXED)).toBe("2026-10-23T14:11:54.267+08:00");
    expect(formatFlowTime(FIXED, "Asia/Shanghai")).toBe(
      "2026-10-23T14:11:54.267+08:00",
    );
  });

  it("UTC 输出 +00:00 而不是 Z", () => {
    expect(formatFlowTime(FIXED, "UTC")).toBe("2026-10-23T06:11:54.267+00:00");
  });
});
