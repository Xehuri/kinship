// RotatingLedger 单测：假时钟跨 UTC 日轮转、同日单分片、跨片序校验/gaps/readFrom、
// 重启全目录扫描、旧 Ledger 钉死路径回归、core 端口结构兼容（静态断言）。全部走临时目录。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Ledger,
  RotatingLedger,
  LedgerError,
  StateLayout,
  isJsonObjectRow,
  parseLedgerRow,
  stateDateKey,
  type LedgerRow,
} from "./index.js";

import type { LedgerPort } from "@axeuh/loom-core/run-engine";
import type { RecoveryLedgerPort } from "@axeuh/loom-core/recovery";

let root: string;
const ledgerDir = (): string => join(root, "ledger");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "axeuh-rot-ledger-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 假时钟：UTC 日界两侧的两个固定时刻（2026-10-09 23:59 / 2026-10-10 00:01）。 */
const DAY1_MS = Date.UTC(2026, 9, 9, 23, 59, 0);
const DAY2_MS = Date.UTC(2026, 9, 10, 0, 1, 0);
const DAY1_KEY = "2026-10-09";
const DAY2_KEY = "2026-10-10";

function fakeClock(startMs: number): { now: () => number; set(ms: number): void } {
  let ms = startMs;
  return {
    now: () => ms,
    set: (v: number) => {
      ms = v;
    },
  };
}

/** 目录内日期分片文件名（升序）。 */
function shardFiles(): string[] {
  return readdirSync(ledgerDir()).sort();
}

/** 逐行直读某分片（字节真相，绕开实例内存镜像）。 */
function rawRows(file: string): LedgerRow[] {
  const out: LedgerRow[] = [];
  for (const line of readFileSync(join(ledgerDir(), file), "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const value: unknown = JSON.parse(line);
    if (!isJsonObjectRow(value)) throw new Error(`not a JSON object line: ${line.slice(0, 80)}`);
    out.push(parseLedgerRow(value));
  }
  return out;
}

describe("RotatingLedger: 写时轮转（假时钟跨 UTC 日）", () => {
  it("同日多次 append 全落单一分片", () => {
    const clock = fakeClock(DAY1_MS);
    const l = new RotatingLedger({ dir: ledgerDir(), now: clock.now });
    l.expected("run-1", DAY1_MS);
    l.expected("run-2", DAY1_MS + 1);
    l.actual("run-1", DAY1_MS + 2, "done");
    expect(shardFiles()).toEqual([`${DAY1_KEY}.jsonl`]);
    expect(rawRows(`${DAY1_KEY}.jsonl`)).toHaveLength(3);
    expect(l.size).toBe(3);
  });

  it("跨 UTC 日轮转：写切当日新分片、行不串片、fsync 逐分片即时可直读", () => {
    const clock = fakeClock(DAY1_MS);
    const l = new RotatingLedger({ dir: ledgerDir(), now: clock.now });
    l.expected("run-1", DAY1_MS); // 落 10-09 片
    clock.set(DAY2_MS);
    l.actual("run-1", DAY2_MS, "done"); // 跨日收口 → 落 10-10 片
    l.expected("run-2", DAY2_MS + 1); // 10-10 片
    clock.set(DAY2_MS + 2);
    l.actual("run-2", DAY2_MS + 2, "failed"); // 仍在 10-10 片（同日不重复轮转）

    expect(shardFiles()).toEqual([`${DAY1_KEY}.jsonl`, `${DAY2_KEY}.jsonl`]);
    expect(rawRows(`${DAY1_KEY}.jsonl`)).toEqual([
      { t: "expected", runId: "run-1", at: DAY1_MS, payload: null },
    ]);
    expect(rawRows(`${DAY2_KEY}.jsonl`)).toEqual([
      { t: "actual", runId: "run-1", at: DAY2_MS, status: "done", payload: null },
      { t: "expected", runId: "run-2", at: DAY2_MS + 1, payload: null },
      { t: "actual", runId: "run-2", at: DAY2_MS + 2, status: "failed", payload: null },
    ]);

    // 拼接读视图 = 分片时序；gaps 跨片收口后清空。
    expect(l.rows().map((r) => [r.t, r.runId])).toEqual([
      ["expected", "run-1"],
      ["actual", "run-1"],
      ["expected", "run-2"],
      ["actual", "run-2"],
    ]);
    expect(l.gaps()).toEqual([]);
    expect(l.filePath).toBe(join(ledgerDir(), `${DAY2_KEY}.jsonl`));
  });

  it("filePath 与 size 随时钟反映当前写片与整本行数", () => {
    const clock = fakeClock(DAY1_MS);
    const l = new RotatingLedger({ dir: ledgerDir(), now: clock.now });
    expect(l.filePath).toBe(join(ledgerDir(), `${DAY1_KEY}.jsonl`));
    l.expected("run-1", DAY1_MS);
    clock.set(DAY2_MS);
    expect(l.filePath).toBe(join(ledgerDir(), `${DAY2_KEY}.jsonl`)); // getter 无开片副作用
    expect(shardFiles()).toEqual([`${DAY1_KEY}.jsonl`]);
    l.expected("run-2", DAY2_MS);
    expect(l.size).toBe(2);
  });

  it("跨片序校验：旧片已登记的 run 换日后仍拒重复 expected、跨日 actual 合法", () => {
    const clock = fakeClock(DAY1_MS);
    const l = new RotatingLedger({ dir: ledgerDir(), now: clock.now });
    l.expected("run-1", DAY1_MS);
    clock.set(DAY2_MS);
    expect(() => l.expected("run-1", DAY2_MS)).toThrow(LedgerError); // 查重扫全本
    expect(() => l.actual("ghost", DAY2_MS, "done")).toThrow(LedgerError);
    l.actual("run-1", DAY2_MS, "partial"); // 跨日补记 = 合法，落当日片
    expect(() => l.actual("run-1", DAY2_MS + 1, "done")).toThrow(LedgerError); // 已收口
    expect(rawRows(`${DAY2_KEY}.jsonl`).map((r) => r.t)).toEqual(["actual"]);
  });

  it("readFrom 游标跨片稳定：旧片行在前，游标起只出增量", () => {
    const clock = fakeClock(DAY1_MS);
    const l = new RotatingLedger({ dir: ledgerDir(), now: clock.now });
    l.expected("run-1", DAY1_MS);
    const cursor = l.size; // =1（10-09 片一行）
    clock.set(DAY2_MS);
    l.actual("run-1", DAY2_MS, "done");
    l.expected("run-2", DAY2_MS + 1);
    expect(l.readFrom(cursor)).toEqual([
      { t: "actual", runId: "run-1", at: DAY2_MS, status: "done", payload: null },
      { t: "expected", runId: "run-2", at: DAY2_MS + 1, payload: null },
    ]);
    expect(l.readFrom(99)).toEqual([]);
  });

  it("重启语义：新实例全量扫目录，旧日残账进扫描窗并可跨日收口", () => {
    const clock1 = fakeClock(DAY1_MS);
    const l1 = new RotatingLedger({ dir: ledgerDir(), now: clock1.now });
    l1.expected("run-1", DAY1_MS); // 崩溃形状：只有 expected
    l1.expected("run-2", DAY1_MS + 1);
    l1.actual("run-2", DAY1_MS + 2, "done");

    // 「次日重启」：全新实例、时钟已在 DAY2。
    const l2 = new RotatingLedger({ dir: ledgerDir(), now: () => DAY2_MS });
    expect(l2.rows()).toHaveLength(3);
    expect(l2.gaps()).toEqual(["run-1"]); // 旧日残账看得见
    l2.actual("run-1", DAY2_MS, "dead-letter"); // 收口落当日片
    const l3 = new RotatingLedger({ dir: ledgerDir(), now: () => DAY2_MS + 1 });
    expect(l3.gaps()).toEqual([]);
  });

  it("目录里非日期分片文件被无视", () => {
    const dir = ledgerDir();
    const l = new RotatingLedger({ dir, now: () => DAY1_MS });
    l.expected("run-1", DAY1_MS);
    writeFileSync(join(dir, "README.md"), "not a shard");
    writeFileSync(join(dir, "2026-10-9.jsonl"), "bad key name");
    expect(new RotatingLedger({ dir, now: () => DAY2_MS }).rows()).toHaveLength(1);
  });

  it("dir 为空串响亮拒绝", () => {
    expect(() => new RotatingLedger({ dir: "  " })).toThrow(LedgerError);
  });

  it("结构兼容 core 端口：可直接进 RunEngine / Reconciler 装配（静态断言）", () => {
    const l = new RotatingLedger({ dir: ledgerDir(), now: () => DAY1_MS });
    const asWritePort: LedgerPort = l; // T12 写面
    const asRecoveryPort: RecoveryLedgerPort = l; // T13 rows() 全量重放面
    asWritePort.expected("run-1", DAY1_MS);
    asRecoveryPort.actual("run-1", DAY1_MS + 1, "done");
    expect(asRecoveryPort.rows()).toHaveLength(2);
  });

  it("缺省时钟 Date.now 可用（不注入 also works）", () => {
    const l = new RotatingLedger({ dir: ledgerDir() });
    const at = Date.now();
    l.expected("run-1", at);
    expect(shardFiles()).toEqual([`${stateDateKey(at)}.jsonl`]);
  });
});

describe("旧 Ledger 构造回归：钉死路径用法零破坏（harness dayPath 同款）", () => {
  it("pinned Ledger 写路径不随墙钟日期漂移、目录只有那一个文件", () => {
    // 照 ledger-e2e harness：START_MS 固定 → dayPath("ledger", stateDateKey(START_MS))。
    const START_MS = Date.UTC(2026, 9, 8, 12, 0, 0); // 2026-10-08（早于真实「今天」）
    const layout = new StateLayout({ root });
    const pinned = layout.dayPath("ledger", stateDateKey(START_MS));
    const l = new Ledger(pinned);
    l.expected("run-1", START_MS);
    l.actual("run-1", START_MS + 1000, "done");
    l.expected("run-2", Date.now()); // 墙钟已在别的日期，行仍进钉死文件
    expect(l.filePath).toBe(pinned);
    expect(shardFiles()).toEqual(["2026-10-08.jsonl"]);
    expect(rawRows("2026-10-08.jsonl")).toHaveLength(3);
  });

  it("同目录混放：pinned Ledger 与 RotatingLedger 各写各片、RotatingLedger 读得到 pinned 行", () => {
    const old = new Ledger(join(ledgerDir(), `${DAY1_KEY}.jsonl`));
    old.expected("run-old", DAY1_MS);
    const rot = new RotatingLedger({ dir: ledgerDir(), now: () => DAY2_MS });
    expect(rot.rows().map((r) => r.runId)).toEqual(["run-old"]); // 既有片被扫入读视图
    expect(rot.gaps()).toEqual(["run-old"]);
    rot.actual("run-old", DAY2_MS, "done"); // 跨实例残账在新片收口
    expect(shardFiles()).toEqual([`${DAY1_KEY}.jsonl`, `${DAY2_KEY}.jsonl`]);
  });
});
