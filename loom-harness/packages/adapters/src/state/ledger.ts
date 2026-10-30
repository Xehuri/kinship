/**
 * Ledger —— L0 期望账本 `ledger/{date}.jsonl`（T08，docs/01 D15「兜底=期望账本」）。
 *
 * 语义：expected 先落盘、先于执行（fsync），actual 记终态；差集=缺口。对账器（T13）重启
 * 全量重扫本账本、无内存态。行只有两型：expected / actual（t 标签判别，runId 关联两半）。
 *
 * 持久性：D15「崩溃即重放」要求 expected 真实先于执行落盘，故 Ledger **强制 fsyncOnAppend**
 * （L0 里唯一强制 fsync 的流；trace/config/inbox 走 page cache 即可）。
 */

import { Journal, type JsonObjectRow } from "./journal.js";
import { LedgerError } from "./errors.js";

/** 终态（side 三态 + 死信；queued/admitted/running 属 T12 状态机，账本只记开火与终态）。 */
export const LEDGER_STATUSES = ["done", "partial", "failed", "dead-letter"] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

/** 账本行：expected（开火即落盘）与 actual（终态），runId 关联两半。 */
export type LedgerRow =
  | {
      readonly t: "expected";
      readonly runId: string;
      readonly at: number;
      readonly payload: unknown;
    }
  | {
      readonly t: "actual";
      readonly runId: string;
      readonly at: number;
      readonly status: LedgerStatus;
      readonly payload: unknown;
    };

function isLedgerStatus(x: unknown): x is LedgerStatus {
  return typeof x === "string" && LEDGER_STATUSES.some((s) => s === x);
}

/** Journal 边界形状校验（照 vendor isLogRecord：判别字段和载荷一起验，残缺行按位置判 torn/损坏）。 */
export function isLedgerRowShape(row: JsonObjectRow): boolean {
  const t = row["t"];
  if (t !== "expected" && t !== "actual") return false;
  if (typeof row["runId"] !== "string" || typeof row["at"] !== "number") return false;
  return t === "expected" || isLedgerStatus(row["status"]);
}

/** 边界解析：JsonObjectRow → LedgerRow（形状非法响亮抛 LedgerError）。 */
export function parseLedgerRow(row: JsonObjectRow): LedgerRow {
  const runId = row["runId"];
  const at = row["at"];
  if (typeof runId !== "string" || typeof at !== "number") {
    throw new LedgerError(`ledger row missing runId/at: ${JSON.stringify(row)}`);
  }
  switch (row["t"]) {
    case "expected":
      return { t: "expected", runId, at, payload: row["payload"] };
    case "actual": {
      const status = row["status"];
      if (!isLedgerStatus(status)) {
        throw new LedgerError(`ledger actual row has unknown status: ${JSON.stringify(status)}`);
      }
      return { t: "actual", runId, at, status, payload: row["payload"] };
    }
    default:
      throw new LedgerError(`ledger row has unknown tag t=${JSON.stringify(row["t"])}`);
  }
}

/**
 * 单日账本（路径经 StateLayout.dayPath("ledger", date) 注入）。
 * `expected()` 必须在对 runId 做任何执行动作**之前**调用；`actual()` 在 run 进终态时调用。
 * 同一账本文件单写者（同 vendor 并发契约）。
 */
export class Ledger {
  private readonly _journal: Journal;

  constructor(filePath: string) {
    // expected 先于执行落盘 = D15 的持久性承诺，fsync 不可关闭。
    this._journal = new Journal(filePath, {
      fsyncOnAppend: true,
      isRow: isLedgerRowShape,
    });
  }

  /** 账本文件路径（只读暴露）。 */
  get filePath(): string {
    return this._journal.filePath;
  }

  /** 有效行数（增量读游标锚点）。 */
  get size(): number {
    return this._journal.size;
  }

  /** 开火登记：expected 行 fsync 落盘后才返回。同 runId 重复登记响亮拒绝。 */
  expected(runId: string, at: number, payload: unknown = null): void {
    if (this._tagsOfRun(runId).length > 0) {
      throw new LedgerError(`run ${runId} already has ledger rows`);
    }
    const row: LedgerRow = { t: "expected", runId, at, payload };
    this._journal.append(row);
  }

  /** 终态登记：actual 行。必须先有 expected 且未收口（否则 = 记账序错误）。 */
  actual(runId: string, at: number, status: LedgerStatus, payload: unknown = null): void {
    const tags = this._tagsOfRun(runId);
    if (!tags.includes("expected")) {
      throw new LedgerError(`actual for run ${runId} without expected row`);
    }
    if (tags.includes("actual")) {
      throw new LedgerError(`run ${runId} already closed with an actual row`);
    }
    const row: LedgerRow = { t: "actual", runId, at, status, payload };
    this._journal.append(row);
  }

  /** 全量行（对账器重启全量重扫用）。 */
  rows(): LedgerRow[] {
    return this._journal.read().map(parseLedgerRow);
  }

  /** 增量读：fromRow 起的行（游标由上层持有，O(增量)）。 */
  readFrom(fromRow: number): LedgerRow[] {
    return this._journal.read(fromRow).map(parseLedgerRow);
  }

  /** 缺口 = 有 expected、无 actual 的 runId（D15：差集=缺口，catchup 的输入）。 */
  gaps(): string[] {
    const closed = new Set<string>();
    const opened: string[] = [];
    const seenOpen = new Set<string>();
    for (const r of this.rows()) {
      if (r.t === "actual") {
        closed.add(r.runId);
      } else if (!seenOpen.has(r.runId)) {
        seenOpen.add(r.runId);
        opened.push(r.runId);
      }
    }
    return opened.filter((id) => !closed.has(id));
  }

  /** 某 run 已登记的行标签（序校验用）。 */
  private _tagsOfRun(runId: string): Array<"expected" | "actual"> {
    const out: Array<"expected" | "actual"> = [];
    for (const raw of this._journal.read()) {
      if (raw["runId"] !== runId) continue;
      const tag = raw["t"];
      switch (tag) {
        case "expected":
        case "actual":
          out.push(tag);
          break;
        default:
          break; // 未知标签由 parseLedgerRow/rows() 响亮报错
      }
    }
    return out;
  }
}
