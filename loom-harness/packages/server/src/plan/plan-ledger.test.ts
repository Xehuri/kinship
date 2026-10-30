/**
 * PlanLedger（T07）验收：只追加 JSONL、宽容读取坏行、并发 append 行完整性
 * 与 tail；另钉日期/来源/事件/版本/时钟校验和路径形状。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PLAN_LEDGER_SCHEMA,
  PlanLedger,
  PlanLedgerValidationError,
  type PlanLedgerRow,
} from "./plan-ledger.js";
import { PlanOverlayValidationError } from "./plan-overlay.js";

const NOW = Date.UTC(2026, 9, 28, 4, 0, 0);
const DAY = "2026-10-28";
const YESTERDAY = "2026-10-27";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "plan-ledger-"));
  roots.push(root);
  return root;
}

function ledgerAt(root: string, now = () => NOW): PlanLedger {
  return new PlanLedger({ planRoot: root, now });
}

function rowLine(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    schema: PLAN_LEDGER_SCHEMA,
    at: NOW,
    date: DAY,
    source: "plan",
    event: "diff",
    ...overrides,
  });
}

describe("append", () => {
  it("append 写入单行 JSONL，返回带 schema 与注入时钟的行", async () => {
    const root = tempRoot();
    const ledger = ledgerAt(root);
    const row = await ledger.append({
      date: DAY,
      source: "plan",
      event: "diff",
      entry_id: "morning-review",
      status: "done",
      version: 2,
      reason: "首次 diff",
    });

    expect(row).toEqual({
      schema: PLAN_LEDGER_SCHEMA,
      at: NOW,
      date: DAY,
      source: "plan",
      event: "diff",
      entry_id: "morning-review",
      status: "done",
      version: 2,
      reason: "首次 diff",
    });
    expect(PLAN_LEDGER_SCHEMA).toBe(1);

    const paths = ledger.paths(DAY);
    expect(paths.dir).toBe(join(root, "daily", DAY));
    expect(paths.ledger).toBe(join(root, "daily", DAY, "plan-ledger.jsonl"));
    expect(readFileSync(paths.ledger, "utf8")).toBe(`${JSON.stringify(row)}\n`);
  });

  it("只追加：后写不截断、不改写已有行", async () => {
    const root = tempRoot();
    const ledger = ledgerAt(root);
    await ledger.append({ date: DAY, source: "plan", event: "diff" });
    const first = readFileSync(ledger.paths(DAY).ledger, "utf8");

    await ledger.append({ date: DAY, source: "scheduler", event: "wake" });
    const after = readFileSync(ledger.paths(DAY).ledger, "utf8");

    expect(after.startsWith(first)).toBe(true);
    const lines = after.split("\n").filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "null")).toMatchObject({ event: "diff" });
    expect(JSON.parse(lines[1] ?? "null")).toMatchObject({ event: "wake" });
  });

  it("校验 date/source/event/version/now，失败不创建账本", async () => {
    const root = tempRoot();
    const ledger = ledgerAt(root);

    // 日期校验复用 plan-overlay 的 requireOverlayDate，因此抛其类型化错误。
    await expect(
      ledger.append({ date: "2026-02-30", source: "plan", event: "diff" }),
    ).rejects.toBeInstanceOf(PlanOverlayValidationError);
    await expect(
      ledger.append({ date: DAY, source: "model" as never, event: "diff" }),
    ).rejects.toBeInstanceOf(PlanLedgerValidationError);
    await expect(
      ledger.append({ date: DAY, source: "plan", event: "  " }),
    ).rejects.toBeInstanceOf(PlanLedgerValidationError);
    await expect(
      ledger.append({ date: DAY, source: "plan", event: "diff", version: 0 }),
    ).rejects.toBeInstanceOf(PlanLedgerValidationError);
    await expect(
      ledger.append({ date: DAY, source: "plan", event: "diff", entry_id: "" }),
    ).rejects.toBeInstanceOf(PlanLedgerValidationError);

    expect(existsSync(ledger.paths(DAY).dir)).toBe(false);

    const badClock = ledgerAt(root, () => -1);
    await expect(
      badClock.append({ date: DAY, source: "plan", event: "diff" }),
    ).rejects.toBeInstanceOf(PlanLedgerValidationError);
  });

  it("构造函数拒绝空/相对 planRoot", () => {
    expect(() => new PlanLedger({ planRoot: "" })).toThrow(PlanLedgerValidationError);
    expect(() => new PlanLedger({ planRoot: "relative/plan" })).toThrow(
      PlanLedgerValidationError,
    );
  });
});

describe("read / tail", () => {
  it("read 对坏行宽容：跳过坏 JSON、错 schema/date/source/event/at/version", async () => {
    const root = tempRoot();
    const ledger = ledgerAt(root);
    const validA = await ledger.append({ date: DAY, source: "plan", event: "diff" });
    const validB = await ledger.append({
      date: DAY,
      source: "scheduler",
      event: "wake",
      version: 3,
    });

    const lines = [
      JSON.stringify(validA),
      "{not-json",
      rowLine({ schema: 2 }),
      rowLine({ date: YESTERDAY }),
      rowLine({ source: "model" }),
      rowLine({ event: "   " }),
      rowLine({ at: "2026-10-28" }),
      rowLine({ version: 0 }),
      rowLine({ entry_id: "" }),
      "",
      JSON.stringify(validB),
    ];
    writeFileSync(ledger.paths(DAY).ledger, lines.join("\n"), "utf8");

    const rows = await ledger.read(DAY);
    expect(rows.map((row) => row.event)).toEqual(["diff", "wake"]);
    expect(rows[0]).toEqual(validA);
    expect(rows[1]).toEqual(validB);
  });

  it("read 文件不存在返回空数组，且按日期隔离", async () => {
    const root = tempRoot();
    const ledger = ledgerAt(root);
    expect(await ledger.read(DAY)).toEqual([]);

    await ledger.append({ date: DAY, source: "plan", event: "today" });
    await ledger.append({ date: YESTERDAY, source: "plan", event: "yesterday" });

    expect((await ledger.read(DAY)).map((row) => row.event)).toEqual(["today"]);
    expect((await ledger.read(YESTERDAY)).map((row) => row.event)).toEqual(["yesterday"]);
  });

  it("tail 返回最近 limit 行，limit 0 为空，非法 limit 抛校验错误", async () => {
    const root = tempRoot();
    const ledger = ledgerAt(root);
    for (const event of ["a", "b", "c"] as const) {
      await ledger.append({ date: DAY, source: "plan", event });
    }

    expect((await ledger.tail(DAY, 2)).map((row) => row.event)).toEqual(["b", "c"]);
    expect(await ledger.tail(DAY, 0)).toEqual([]);
    expect((await ledger.tail(DAY, 99)).map((row) => row.event)).toEqual(["a", "b", "c"]);
    expect((await ledger.tail(DAY)).map((row) => row.event)).toEqual(["a", "b", "c"]);
    await expect(ledger.tail(DAY, -1)).rejects.toBeInstanceOf(PlanLedgerValidationError);
    await expect(ledger.tail(DAY, 1.5)).rejects.toBeInstanceOf(PlanLedgerValidationError);
  });
});

describe("并发追加", () => {
  it("多个实例同时 append 产生完整、可解析、无截断的 JSONL 行", async () => {
    const root = tempRoot();
    const ledgers = [
      ledgerAt(root, () => NOW),
      ledgerAt(root, () => NOW + 1),
      ledgerAt(root, () => NOW + 2),
      ledgerAt(root, () => NOW + 3),
    ];
    const count = 48;
    const primary = ledgers[0];
    if (primary === undefined) throw new Error("missing primary ledger");

    await Promise.all(
      Array.from({ length: count }, (_, index) => {
        const ledger = ledgers[index % ledgers.length];
        if (ledger === undefined) throw new Error("missing ledger");
        return ledger.append({
          date: DAY,
          source: index % 2 === 0 ? "plan" : "scheduler",
          event: `event-${String(index)}`,
        });
      }),
    );

    const rows = await primary.read(DAY);
    expect(rows).toHaveLength(count);
    expect(new Set(rows.map((row) => row.event)).size).toBe(count);
    for (const row of rows) {
      expect(row.schema).toBe(PLAN_LEDGER_SCHEMA);
      expect(row.date).toBe(DAY);
    }

    const text = readFileSync(primary.paths(DAY).ledger, "utf8");
    const lines = text.split("\n").filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(count);
    for (const line of lines) {
      const parsed = JSON.parse(line) as PlanLedgerRow;
      expect(parsed.schema).toBe(PLAN_LEDGER_SCHEMA);
      expect(parsed.date).toBe(DAY);
      expect(typeof parsed.event).toBe("string");
    }
    expect(text.endsWith("\n")).toBe(true);
  });
});
