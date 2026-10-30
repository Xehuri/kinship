/**
 * wake 解析器：converge 工具 `wake` 参数的**唯一边界**。
 *
 * 模型只允许给出一次性唤醒点：倒计时 / 带时区 ISO / 本地日期时间 / 下一次钟点，
 * 或显式 `none` 清除。周期性语法（cron）不是一次性唤醒，一律拒绝。
 * 本模块是纯函数：无 import、无 IO、无时钟读取（now 由调用方注入）。
 */

export const WAKE_MAX_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

export type WakeResolution = { ok: true; at: number | null } | { ok: false; reason: string };

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

/** 带显式时区的 ISO/类 ISO：手工 Date.UTC 数学，日历回读校验挡住 2 月 30 日。 */
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

function checkAt(at: number, now: number): WakeResolution {
  if (!Number.isFinite(at)) return { ok: false, reason: "无法识别的时间格式" };
  if (at <= now) return { ok: false, reason: "时间已过去" };
  if (at - now > WAKE_MAX_HORIZON_MS) return { ok: false, reason: "超出最长 30 天" };
  return { ok: true, at };
}

export function resolveWakeSpec(spec: string, now: number): WakeResolution {
  const text = spec.trim();
  if (text === "") return { ok: false, reason: "不能为空" };
  if (text.toLowerCase() === "none") return { ok: true, at: null };

  const compact = text.replace(/\s+/g, "");
  if (compact !== "" && COUNTDOWN_FULL.test(compact)) {
    const delta = parseCountdown(compact);
    if (delta === null || delta <= 0) return { ok: false, reason: "时长必须大于 0" };
    if (!Number.isFinite(delta) || delta > WAKE_MAX_HORIZON_MS) {
      return { ok: false, reason: "超出最长 30 天" };
    }
    return checkAt(now + delta, now);
  }

  const zoned = parseZonedISO(text);
  if (zoned !== null) return checkAt(zoned, now);

  const local = parseLocalDateTime(text);
  if (local !== null) return checkAt(local, now);

  const clock = parseClockTime(text, now);
  if (clock !== null) return checkAt(clock, now);

  return { ok: false, reason: "无法识别的时间格式" };
}

export function formatWakeAt(at: number): string {
  const d = new Date(at);
  const year = String(d.getFullYear()).padStart(4, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const minute = String(d.getMinutes()).padStart(2, "0");
  const base = `${year}-${month}-${day} ${hour}:${minute}`;
  const second = d.getSeconds();
  return second === 0 ? base : `${base}:${String(second).padStart(2, "0")}`;
}
