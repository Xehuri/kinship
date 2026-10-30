/**
 * 时区算术验收：上海跨日边界、周/月排班、纽约夏令时两侧，
 * 以及结果的进程时区独立性。期望值一律由 Date.UTC 或同一套
 * 纯函数派生，不写死任何 UTC 偏移。
 */

import { describe, expect, it } from "vitest";

import {
  addDays,
  localDateTimeToEpoch,
  nextOccurrence,
  zonedDateKey,
  zonedNow,
} from "./timezone.js";

const SHANGHAI = "Asia/Shanghai";
const NEW_YORK = "America/New_York";

describe("zoned wall clock", () => {
  it("uses the target zone's midnight, not the process's", () => {
    const midnight = Date.UTC(2026, 9, 27, 16, 0, 0);
    const zoned = zonedNow(midnight, SHANGHAI);

    expect(zoned.dateKey).toBe("2026-10-28");
    expect(zoned).toMatchObject({
      year: 2026,
      month: 10,
      day: 28,
      hour: 0,
      minute: 0,
      second: 0,
      weekday: 3,
    });
    expect(zonedDateKey(midnight, SHANGHAI)).toBe("2026-10-28");
  });

  it("keeps the previous local day for the last millisecond before midnight", () => {
    const beforeMidnight = Date.UTC(2026, 9, 27, 15, 59, 59, 999);
    const zoned = zonedNow(beforeMidnight, SHANGHAI);

    expect(zoned.dateKey).toBe("2026-10-27");
    expect(zoned.hour).toBe(23);
    expect(zoned.minute).toBe(59);
    expect(zonedDateKey(beforeMidnight, SHANGHAI)).toBe("2026-10-27");
  });
});

describe("wall clock to epoch", () => {
  it("round-trips Shanghai local times", () => {
    expect(localDateTimeToEpoch("2026-10-28", "00:00", SHANGHAI)).toBe(
      Date.UTC(2026, 9, 27, 16, 0, 0),
    );
    expect(localDateTimeToEpoch("2026-10-28", "05:00", SHANGHAI)).toBe(
      Date.UTC(2026, 9, 27, 21, 0, 0),
    );
  });

  it("adds natural days without crossing the date line", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-15", 0)).toBe("2026-01-15");
  });

  it("rejects impossible dates, malformed clocks and non-integer day steps", () => {
    expect(() => localDateTimeToEpoch("2026-02-30", "05:00", SHANGHAI)).toThrow(RangeError);
    expect(() => localDateTimeToEpoch("2026-10-28", "5:00", SHANGHAI)).toThrow(RangeError);
    expect(() => addDays("2026-10-28", 1.5)).toThrow(RangeError);
  });
});

describe("next occurrence", () => {
  it("returns the next daily wall time strictly after the cursor", () => {
    const daily = { kind: "daily", at: "05:00" } as const;
    const from = localDateTimeToEpoch("2026-10-28", "05:00", SHANGHAI);

    expect(nextOccurrence(daily, from - 1, SHANGHAI)).toBe(from);
    expect(nextOccurrence(daily, from, SHANGHAI)).toBe(
      localDateTimeToEpoch("2026-10-29", "05:00", SHANGHAI),
    );
  });

  it("returns the next Monday for a weekly schedule", () => {
    const weekly = { kind: "weekly", days: ["mon"], at: "05:00" } as const;
    const monday = localDateTimeToEpoch("2026-11-02", "05:00", SHANGHAI);

    expect(
      nextOccurrence(weekly, localDateTimeToEpoch("2026-10-28", "05:00", SHANGHAI), SHANGHAI),
    ).toBe(monday);
    expect(nextOccurrence(weekly, monday, SHANGHAI)).toBe(
      localDateTimeToEpoch("2026-11-09", "05:00", SHANGHAI),
    );
  });

  it("returns the next selected day for a monthly schedule", () => {
    const monthly = { kind: "monthly", days: [1, 15], at: "18:30" } as const;

    expect(
      nextOccurrence(
        monthly,
        localDateTimeToEpoch("2026-01-02", "00:00", SHANGHAI),
        SHANGHAI,
      ),
    ).toBe(localDateTimeToEpoch("2026-01-15", "18:30", SHANGHAI));
    expect(
      nextOccurrence(
        monthly,
        localDateTimeToEpoch("2026-01-15", "18:30", SHANGHAI),
        SHANGHAI,
      ),
    ).toBe(localDateTimeToEpoch("2026-02-01", "18:30", SHANGHAI));
  });

  it("skips months that do not contain the requested day", () => {
    const monthly = { kind: "monthly", days: [31], at: "18:30" } as const;

    expect(
      nextOccurrence(
        monthly,
        localDateTimeToEpoch("2026-01-31", "18:30", SHANGHAI),
        SHANGHAI,
      ),
    ).toBe(localDateTimeToEpoch("2026-03-31", "18:30", SHANGHAI));
  });

  it("returns once times only while they are still ahead", () => {
    const once = { kind: "once", date: "2026-10-28", at: "05:00" } as const;
    const at = localDateTimeToEpoch("2026-10-28", "05:00", SHANGHAI);

    expect(nextOccurrence(once, at - 1, SHANGHAI)).toBe(at);
    expect(nextOccurrence(once, at, SHANGHAI)).toBeNull();
  });
});

describe("America/New_York daylight saving boundaries", () => {
  it("maps the spring-forward gap forward by the missing hour", () => {
    const beforeGap = localDateTimeToEpoch("2026-03-08", "01:30", NEW_YORK);
    const gap = localDateTimeToEpoch("2026-03-08", "02:30", NEW_YORK);
    const afterGap = localDateTimeToEpoch("2026-03-08", "03:30", NEW_YORK);

    expect(beforeGap).toBe(Date.UTC(2026, 2, 8, 6, 30, 0));
    expect(afterGap).toBe(Date.UTC(2026, 2, 8, 7, 30, 0));
    expect(gap).toBe(afterGap);
    expect(afterGap - beforeGap).toBe(3_600_000);
    expect(zonedNow(afterGap, NEW_YORK)).toMatchObject({
      dateKey: "2026-03-08",
      hour: 3,
      minute: 30,
    });
  });

  it("maps the fall-back overlap to the earlier instant", () => {
    const firstHalf = localDateTimeToEpoch("2026-11-01", "01:30", NEW_YORK);
    const afterTransition = localDateTimeToEpoch("2026-11-01", "02:30", NEW_YORK);

    expect(firstHalf).toBe(Date.UTC(2026, 10, 1, 5, 30, 0));
    expect(afterTransition).toBe(Date.UTC(2026, 10, 1, 7, 30, 0));
    expect(afterTransition - firstHalf).toBe(7_200_000);
    expect(zonedNow(Date.UTC(2026, 10, 1, 6, 30, 0), NEW_YORK)).toMatchObject({
      dateKey: "2026-11-01",
      hour: 1,
      minute: 30,
    });
  });

  it("keeps a daily wake at the same wall clock across spring forward", () => {
    const daily = { kind: "daily", at: "03:00" } as const;
    const from = localDateTimeToEpoch("2026-03-07", "04:00", NEW_YORK);
    const next = nextOccurrence(daily, from, NEW_YORK);

    expect(next).not.toBeNull();
    if (next === null) return;
    expect(zonedDateKey(next, NEW_YORK)).toBe("2026-03-08");
    expect(zonedNow(next, NEW_YORK)).toMatchObject({ hour: 3, minute: 0 });
  });
});

describe("process timezone independence", () => {
  it("produces identical results under different process TZ values", () => {
    const original = process.env.TZ;
    const compute = (): readonly number[] => [
      localDateTimeToEpoch("2026-10-28", "05:00", SHANGHAI),
      localDateTimeToEpoch("2026-03-08", "03:30", NEW_YORK),
      nextOccurrence({ kind: "daily", at: "05:00" }, Date.UTC(2026, 9, 27, 0, 0, 0), SHANGHAI) ??
        -1,
    ];
    try {
      process.env.TZ = "UTC";
      const utc = compute();
      process.env.TZ = "Pacific/Kiritimati";
      const kiritimati = compute();
      expect(kiritimati).toEqual(utc);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});
