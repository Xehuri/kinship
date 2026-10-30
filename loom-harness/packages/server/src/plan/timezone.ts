/**
 * 计划唤醒的时区算术。
 *
 * 全部换算只经 IANA 时区与 Intl 完成：
 *   - 读墙钟用 Intl.DateTimeFormat#formatToParts；
 *   - 墙钟转时刻用同一格式化器回读偏移，再反解 epoch；
 *   - 日期键加减只用 UTC 日历，不碰进程本地时区。
 *
 * 不写死任何 UTC 偏移；夏令时缺口按“向前补齐”处理（例如纽约春季 02:30
 * 不存在时落到 03:30），重叠时刻取较早的一次。
 */
// allow: SIZE_OK — 任务 allowlist 只允许本文件承载时区换算与排班求解，二者共用同一套墙钟解析。

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const WEEKDAY_TOKENS: Readonly<Record<string, number>> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

export interface ZonedDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** 0=周日，6=周六。 */
  readonly weekday: number;
  readonly weekdayName: string;
  readonly dateKey: string;
}

export type WakeSchedule =
  | { readonly kind: "daily"; readonly at: string }
  | {
      readonly kind: "weekly";
      readonly days: readonly (string | number)[];
      readonly at: string;
    }
  | {
      readonly kind: "monthly";
      readonly days: readonly (number | string)[];
      readonly at: string;
    }
  | { readonly kind: "once"; readonly date: string; readonly at: string };

interface WallParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function requireFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  formatters.set(timeZone, formatter);
  return formatter;
}

function partValue(parts: readonly Intl.DateTimeFormatPart[], type: string): string {
  const part = parts.find((candidate) => candidate.type === type);
  if (part === undefined) throw new RangeError(`missing Intl part: ${type}`);
  return part.value;
}

function partNumber(parts: readonly Intl.DateTimeFormatPart[], type: string): number {
  const value = Number(partValue(parts, type));
  if (!Number.isFinite(value)) throw new RangeError(`Intl part ${type} is not numeric`);
  return value;
}

function capture(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new RangeError("regex capture missing");
  return value;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDateKey(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
}

function parseDateKey(dateKey: string): DateParts {
  const match = DATE_KEY_RE.exec(dateKey);
  if (match === null) throw new RangeError(`invalid date key: ${dateKey}`);
  const year = Number(capture(match, 1));
  const month = Number(capture(match, 2));
  const day = Number(capture(match, 3));
  const utc = utcFromParts({ year, month, day, hour: 0, minute: 0, second: 0 });
  const check = new Date(utc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new RangeError(`invalid date key: ${dateKey}`);
  }
  return { year, month, day };
}

function parseClock(clock: string): { readonly hour: number; readonly minute: number } {
  const match = CLOCK_RE.exec(clock);
  if (match === null) throw new RangeError(`invalid clock: ${clock}`);
  return { hour: Number(capture(match, 1)), minute: Number(capture(match, 2)) };
}

function utcFromParts(parts: WallParts): number {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return date.getTime();
}

function wallPartsAt(epochMs: number, timeZone: string): WallParts {
  const parts = requireFormatter(timeZone).formatToParts(epochMs);
  return {
    year: partNumber(parts, "year"),
    month: partNumber(parts, "month"),
    day: partNumber(parts, "day"),
    hour: partNumber(parts, "hour"),
    minute: partNumber(parts, "minute"),
    second: partNumber(parts, "second"),
  };
}

/** 某时刻在目标时区的 UTC 偏移（毫秒，东为正）。 */
function offsetAt(epochMs: number, timeZone: string): number {
  const wholeSecond = Math.floor(epochMs / 1000) * 1000;
  return utcFromParts(wallPartsAt(wholeSecond, timeZone)) - wholeSecond;
}

/** 读某时刻在目标时区的墙钟日历。 */
export function zonedNow(nowMs: number, timeZone: string): ZonedDateTime {
  if (!Number.isFinite(nowMs)) throw new RangeError(`invalid epoch: ${String(nowMs)}`);
  const parts = requireFormatter(timeZone).formatToParts(nowMs);
  const year = partNumber(parts, "year");
  const month = partNumber(parts, "month");
  const day = partNumber(parts, "day");
  const hour = partNumber(parts, "hour");
  const minute = partNumber(parts, "minute");
  const second = partNumber(parts, "second");
  const weekdayName = partValue(parts, "weekday");
  const weekday = WEEKDAY_INDEX[weekdayName.toLowerCase()];
  if (weekday === undefined) throw new RangeError(`unknown weekday: ${weekdayName}`);
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday,
    weekdayName,
    dateKey: formatDateKey(year, month, day),
  };
}

/** 某时刻在目标时区的日期键（YYYY-MM-DD）。 */
export function zonedDateKey(nowMs: number, timeZone: string): string {
  return zonedNow(nowMs, timeZone).dateKey;
}

/**
 * 本地墙钟转 epoch。
 *
 * 夏令时缺口不存在精确解，按向前补齐（缺口后的第一个等效墙钟）；重叠时刻
 * 取较早的 epoch。非法日期/时刻/时区一律抛 RangeError。
 */
export function localDateTimeToEpoch(
  dateKey: string,
  clock: string,
  timeZone: string,
): number {
  const date = parseDateKey(dateKey);
  const time = parseClock(clock);
  const wall = utcFromParts({
    year: date.year,
    month: date.month,
    day: date.day,
    hour: time.hour,
    minute: time.minute,
    second: 0,
  });
  const offsets = new Set<number>();
  for (const probe of [wall - 2 * DAY_MS, wall, wall + 2 * DAY_MS]) {
    offsets.add(offsetAt(probe, timeZone));
  }
  const candidates = [...offsets].map((offset) => wall - offset);
  candidates.sort((left, right) => left - right);

  let forward: { readonly epoch: number; readonly wall: number } | null = null;
  for (const candidate of candidates) {
    const candidateWall = utcFromParts(wallPartsAt(candidate, timeZone));
    if (candidateWall === wall) return candidate;
    if (candidateWall > wall) {
      if (forward === null || candidateWall < forward.wall) {
        forward = { epoch: candidate, wall: candidateWall };
      }
    }
  }
  if (forward !== null) return forward.epoch;
  const fallback = candidates[0];
  if (fallback === undefined) throw new RangeError(`cannot resolve local time: ${dateKey} ${clock}`);
  return fallback;
}

/** 日期键加减自然日（只走 UTC 日历，跨夏令时不受影响）。 */
export function addDays(dateKey: string, days: number): string {
  if (!Number.isInteger(days)) throw new RangeError(`days must be an integer: ${String(days)}`);
  const date = parseDateKey(dateKey);
  const shifted = new Date(0);
  shifted.setUTCFullYear(date.year, date.month - 1, date.day + days);
  shifted.setUTCHours(0, 0, 0, 0);
  return formatDateKey(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

function weekdayOfDateKey(dateKey: string): number {
  const date = parseDateKey(dateKey);
  const utc = utcFromParts({ ...date, hour: 0, minute: 0, second: 0 });
  return new Date(utc).getUTCDay();
}

function parseWeekday(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > 7) {
      throw new RangeError(`invalid weekday: ${String(value)}`);
    }
    return value === 7 ? 0 : value;
  }
  const key = value.trim().toLowerCase();
  const named = WEEKDAY_TOKENS[key];
  if (named !== undefined) return named;
  if (/^[0-7]$/.test(key)) {
    const numeric = Number(key);
    return numeric === 7 ? 0 : numeric;
  }
  throw new RangeError(`invalid weekday: ${value}`);
}

function parseMonthDay(value: number | string): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 31) {
    throw new RangeError(`invalid month day: ${String(value)}`);
  }
  return numeric;
}

function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

function nextDaily(
  schedule: { readonly at: string },
  fromEpoch: number,
  timeZone: string,
): number {
  const startKey = zonedDateKey(fromEpoch, timeZone);
  for (let offset = 0; offset <= 3; offset += 1) {
    const candidate = localDateTimeToEpoch(addDays(startKey, offset), schedule.at, timeZone);
    if (candidate > fromEpoch) return candidate;
  }
  throw new RangeError("daily schedule produced no occurrence");
}

function nextWeekly(
  schedule: { readonly days: readonly (string | number)[]; readonly at: string },
  fromEpoch: number,
  timeZone: string,
): number {
  const weekdays = new Set(schedule.days.map((day) => parseWeekday(day)));
  if (weekdays.size === 0) throw new RangeError("weekly schedule needs at least one day");
  const startKey = zonedDateKey(fromEpoch, timeZone);
  for (let offset = 0; offset <= 8; offset += 1) {
    const key = addDays(startKey, offset);
    if (!weekdays.has(weekdayOfDateKey(key))) continue;
    const candidate = localDateTimeToEpoch(key, schedule.at, timeZone);
    if (candidate > fromEpoch) return candidate;
  }
  throw new RangeError("weekly schedule produced no occurrence");
}

function nextMonthly(
  schedule: { readonly days: readonly (number | string)[]; readonly at: string },
  fromEpoch: number,
  timeZone: string,
): number {
  const days = [...new Set(schedule.days.map((day) => parseMonthDay(day)))].sort(
    (left, right) => left - right,
  );
  if (days.length === 0) throw new RangeError("monthly schedule needs at least one day");
  const start = parseDateKey(zonedDateKey(fromEpoch, timeZone));
  const startMonth = start.year * 12 + (start.month - 1);
  for (let offset = 0; offset <= 48; offset += 1) {
    const total = startMonth + offset;
    const year = Math.floor(total / 12);
    const month = (total % 12) + 1;
    for (const day of days) {
      if (day > daysInMonth(year, month)) continue;
      const candidate = localDateTimeToEpoch(
        formatDateKey(year, month, day),
        schedule.at,
        timeZone,
      );
      if (candidate > fromEpoch) return candidate;
    }
  }
  throw new RangeError("monthly schedule produced no occurrence");
}

function nextOnce(
  schedule: { readonly date: string; readonly at: string },
  fromEpoch: number,
  timeZone: string,
): number | null {
  const candidate = localDateTimeToEpoch(schedule.date, schedule.at, timeZone);
  return candidate > fromEpoch ? candidate : null;
}

function assertNeverSchedule(value: never): never {
  throw new RangeError(`unknown schedule: ${JSON.stringify(value)}`);
}

/** 下一次严格晚于 fromEpoch 的排班时刻；once 已过期返回 null。 */
export function nextOccurrence(
  schedule: WakeSchedule,
  fromEpoch: number,
  timeZone: string,
): number | null {
  if (!Number.isFinite(fromEpoch)) throw new RangeError(`invalid epoch: ${String(fromEpoch)}`);
  switch (schedule.kind) {
    case "daily":
      return nextDaily(schedule, fromEpoch, timeZone);
    case "weekly":
      return nextWeekly(schedule, fromEpoch, timeZone);
    case "monthly":
      return nextMonthly(schedule, fromEpoch, timeZone);
    case "once":
      return nextOnce(schedule, fromEpoch, timeZone);
    default:
      return assertNeverSchedule(schedule);
  }
}
