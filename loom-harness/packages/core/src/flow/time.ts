/**
 * Flow 时间边界：与 converge wake **同一输入族**，但套用台账自己的边界策略。
 *
 * 输入族：倒计时（30s / 2h / 30m / 1h30m / 中文单位）、带时区 ISO、无时区本地日期时间、
 * 本地 HH:MM（下一次出现）、`none` / 空串 / null（清空）、number（epoch 毫秒）。
 *
 * 与 convergence/wake.ts 的差异（刻意，不改动 convergence）：
 * - wake 直接拒绝过去与 >30 天；flow 先解析出绝对值，再由字段策略处理：
 *   next_decision_at 钳制到 [now+5s, now+30d]（过去/过远都收敛到边界）；
 *   soft_deadline / due_at 拒绝 <= now。
 * - 因此这里独立实现解析（语法保持一致），而不是复用带边界判定的 resolveWakeSpec。
 */

import { FLOW_LIMITS } from "./limits.js";
import type { FlowTimeInput } from "./types.js";

export type FlowTimeResolution =
  | { readonly ok: true; readonly at: number | null }
  | { readonly ok: false; readonly reason: string };

const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  秒: 1_000,
  分钟: 60_000,
  分: 60_000,
  小时: 3_600_000,
  时: 3_600_000,
  天: 86_400_000,
  日: 86_400_000,
};

const COUNTDOWN_FULL = /^(?:\d+(?:ms|s|m|h|d|秒|分钟|分|小时|时|天|日))+$/;
const COUNTDOWN_TOKEN = /(\d+)(ms|s|m|h|d|秒|分钟|分|小时|时|天|日)/g;
const ZONED_ISO =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{3}))?([Zz]|[+-]\d{2}:\d{2})$/;
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const CLOCK_TIME = /^(\d{1,2}):(\d{2})$/;

function num(value: string | undefined): number {
  return value === undefined ? 0 : Number(value);
}

function validDateParts(
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= 31 &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59
  );
}

/** 倒计时 token 求和；形状不合法返回 null（正负/小数/尾随垃圾都在此挡掉）。 */
function parseCountdown(raw: string): number | null {
  if (!COUNTDOWN_FULL.test(raw)) return null;
  let total = 0;
  for (const match of raw.matchAll(COUNTDOWN_TOKEN)) {
    const unit = UNIT_MS[match[2] ?? ""];
    if (unit === undefined) return null;
    total += num(match[1]) * unit;
  }
  return total;
}

/** 带显式时区的 ISO/类 ISO：手工 Date.UTC 数学 + 日历回读校验。 */
function parseZonedISO(raw: string): number | null {
  const m = ZONED_ISO.exec(raw);
  if (m === null) return null;
  const year = num(m[1]);
  const month = num(m[2]);
  const day = num(m[3]);
  const hour = num(m[4]);
  const minute = num(m[5]);
  const second = num(m[6]);
  const milli = num(m[7]);
  if (!validDateParts(month, day, hour, minute, second)) return null;

  const wall = Date.UTC(year, month - 1, day, hour, minute, second, milli);
  const check = new Date(wall);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second ||
    check.getUTCMilliseconds() !== milli
  ) {
    return null;
  }

  const zone = m[8] ?? "Z";
  if (zone === "Z" || zone === "z") return wall;
  const offsetHour = Number(zone.slice(1, 3));
  const offsetMinute = Number(zone.slice(4, 6));
  if (offsetHour > 23 || offsetMinute > 59) return null;
  const sign = zone.startsWith("-") ? -1 : 1;
  return wall - sign * (offsetHour * 60 + offsetMinute) * 60_000;
}

/** 无时区本地日期时间：本地日历构造（不用 Date.parse），回读校验挡住滚动。 */
function parseLocalDateTime(raw: string): number | null {
  const m = LOCAL_DATETIME.exec(raw);
  if (m === null) return null;
  const year = num(m[1]);
  const month = num(m[2]);
  const day = num(m[3]);
  const hour = num(m[4]);
  const minute = num(m[5]);
  const second = num(m[6]);
  if (!validDateParts(month, day, hour, minute, second)) return null;

  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return null;
  }
  return date.getTime();
}

/** 纯钟点：今天该时刻严格晚于 now 就取今天，否则明天。 */
function parseClockTime(raw: string, now: number): number | null {
  const m = CLOCK_TIME.exec(raw);
  if (m === null) return null;
  const hour = num(m[1]);
  const minute = num(m[2]);
  if (hour > 23 || minute > 59) return null;

  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0).getTime();
  if (today > now) return today;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, hour, minute, 0, 0).getTime();
}

/**
 * 解析时间输入 → epoch 毫秒 / null。**只做语法与日历校验**，不套用过去/未来边界；
 * 边界由 resolveNextDecisionAt / resolveDeadlineTime 负责。
 */
export function parseFlowTime(
  spec: FlowTimeInput | undefined,
  now: number,
): FlowTimeResolution {
  if (spec === null || spec === undefined) return { ok: true, at: null };
  if (typeof spec === "number") {
    if (!Number.isFinite(spec) || !Number.isInteger(spec)) {
      return { ok: false, reason: "时间必须是有限整数毫秒" };
    }
    return { ok: true, at: spec };
  }
  const text = spec.trim();
  if (text === "") return { ok: true, at: null };
  if (text.toLowerCase() === "none") return { ok: true, at: null };

  const compact = text.replace(/\s+/g, "");
  if (compact !== "" && COUNTDOWN_FULL.test(compact)) {
    const delta = parseCountdown(compact);
    if (delta === null || delta <= 0) return { ok: false, reason: "时长必须大于 0" };
    if (!Number.isFinite(delta)) return { ok: false, reason: "无法识别的时间格式" };
    return { ok: true, at: now + delta };
  }

  const zoned = parseZonedISO(text);
  if (zoned !== null) return { ok: true, at: zoned };

  const local = parseLocalDateTime(text);
  if (local !== null) return { ok: true, at: local };

  const clock = parseClockTime(text, now);
  if (clock !== null) return { ok: true, at: clock };

  return { ok: false, reason: "无法识别的时间格式" };
}

/** 把唤醒点钳制到 [now+minWakeLeadMs, now+maxWakeHorizonMs]。 */
export function clampNextDecisionAt(at: number, now: number): number {
  const min = now + FLOW_LIMITS.minWakeLeadMs;
  const max = now + FLOW_LIMITS.maxWakeHorizonMs;
  if (at < min) return min;
  if (at > max) return max;
  return at;
}

/** next_decision_at 边界：解析后钳制；null/空/none 表示清空。 */
export function resolveNextDecisionAt(
  spec: FlowTimeInput | undefined,
  now: number,
): FlowTimeResolution {
  const parsed = parseFlowTime(spec, now);
  if (!parsed.ok || parsed.at === null) return parsed;
  return { ok: true, at: clampNextDecisionAt(parsed.at, now) };
}

/** soft_deadline / due_at 边界：解析后拒绝 <= now；null/空/none 表示清空。 */
export function resolveDeadlineTime(
  spec: FlowTimeInput | undefined,
  now: number,
): FlowTimeResolution {
  const parsed = parseFlowTime(spec, now);
  if (!parsed.ok || parsed.at === null) return parsed;
  if (parsed.at <= now) return { ok: false, reason: "时间必须晚于当前" };
  return parsed;
}

/** IANA 时区串校验（Intl 是运行时唯一权威）；空串视为非法。 */
export function isValidTimeZone(value: string): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/** 模型可见时间的默认展示时区：本地墙钟 + 显式数字偏移，避免 UTC「Z」造成误读。 */
export const FLOW_DISPLAY_TIME_ZONE = "Asia/Shanghai";

const GMT_OFFSET = /^GMT([+-])(\d{2}:\d{2})$/;

/** longOffset 给的是 `GMT` / `GMT±HH:MM`；统一成 ISO 的 `±HH:MM`。 */
function formatOffset(zoneName: string): string {
  if (zoneName === "GMT") return "+00:00";
  const match = GMT_OFFSET.exec(zoneName);
  if (match === null) throw new RangeError(`无法解析时区偏移: ${zoneName}`);
  return `${match[1] ?? ""}${match[2] ?? ""}`;
}

/**
 * 把 epoch 毫秒渲染成目标时区的 ISO 扩展格式（毫秒 + 显式偏移），如
 * `2026-10-23T14:11:54.267+08:00`；UTC 输出 `+00:00` 而非 `Z`。
 */
export function formatFlowTime(
  at: number,
  timeZone: string = FLOW_DISPLAY_TIME_ZONE,
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(at);
  const partValue = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const milliseconds = String(new Date(at).getUTCMilliseconds()).padStart(3, "0");
  return (
    `${partValue("year")}-${partValue("month")}-${partValue("day")}` +
    `T${partValue("hour")}:${partValue("minute")}:${partValue("second")}` +
    `.${milliseconds}${formatOffset(partValue("timeZoneName"))}`
  );
}
