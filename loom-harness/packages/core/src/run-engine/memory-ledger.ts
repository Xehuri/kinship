/**
 * MemoryLedger —— LedgerPort 的内存实现（core 测试 + server 装配前的占位）。
 *
 * 语义逐条镜像 T08 `adapters/src/state/ledger.ts` 的 Ledger（已核对）：
 *   - expected 重复登记同名 runId → 抛错；
 *   - actual 必须先有 expected、且不可重复收口 → 抛错；
 *   - 「同步即落盘」模拟 fsync 语义：expected() 返回时账本已含该行。
 * 差异（故意）：不落地文件。真 Ledger 由 server 装配注入（见 DoneClaim）。
 */

import type { LedgerPort, LedgerTerminalStatus } from "./types.js";

/** 一条账本事件（测试时序断言的观察对象）。 */
export interface MemoryLedgerEntry {
  readonly seq: number;
  readonly t: "expected" | "actual";
  readonly runId: string;
  readonly at: number;
  readonly status?: LedgerTerminalStatus;
  readonly payload: unknown;
}

export class MemoryLedger implements LedgerPort {
  private readonly _entries: MemoryLedgerEntry[] = [];
  private _seq = 0;

  /** 全部行（按写入序）。测试据此断「expected 先于执行」「终态写 actual」。 */
  get entries(): readonly MemoryLedgerEntry[] {
    return this._entries;
  }

  /** 缺口 = 有 expected 无 actual 的 runId（与 Ledger.gaps() 同语义）。 */
  gaps(): string[] {
    const closed = new Set(this._entries.filter((e) => e.t === "actual").map((e) => e.runId));
    return [
      ...new Set(
        this._entries.filter((e) => e.t === "expected" && !closed.has(e.runId)).map((e) => e.runId),
      ),
    ];
  }

  expected(runId: string, at: number, payload: unknown = null): void {
    if (this._entries.some((e) => e.runId === runId)) {
      throw new Error(`run ${runId} already has ledger rows`);
    }
    this._entries.push({ seq: this._seq++, t: "expected", runId, at, payload });
  }

  actual(runId: string, at: number, status: LedgerTerminalStatus, payload: unknown = null): void {
    if (!this._entries.some((e) => e.runId === runId && e.t === "expected")) {
      throw new Error(`actual for run ${runId} without expected row`);
    }
    if (this._entries.some((e) => e.runId === runId && e.t === "actual")) {
      throw new Error(`run ${runId} already closed with an actual row`);
    }
    this._entries.push({ seq: this._seq++, t: "actual", runId, at, status, payload });
  }
}
