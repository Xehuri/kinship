/**
 * RotatingLedger —— 「写时按 UTC 日轮转」的期望账本（修 T08 分片轴缺陷：启动日冻结）。
 *
 * 缺陷背景：`new Ledger(layout.dayPath("ledger", stateDateKey(Date.now())))` 的分片路径在
 * 进程启动时算一次就冻结，进程跨 UTC 日在线时账继续写进启动日文件——残账永出不了
 * 重启日的扫描窗。本类把「取哪片文件」从**构造时**挪到**每次追加写入时**：
 * 每个 append 先算 `stateDateKey(now())`，跨日即轮转打开当日新分片续写。
 *
 * 与 `Ledger`（旧单日账本类）的关系：
 *   - 公开签名逐一对齐（expected / actual / rows / readFrom / gaps / size / filePath），
 *     结构化满足 core 的 `LedgerPort`（写面）与 `RecoveryLedgerPort`（rows 全量重放）；
 *     静态断言见 ledger-rotating.test.ts。
 *   - 旧构造 `new Ledger(path)` **原样保留**：harness 等「钉死路径」用法零破坏
 *     （ledger-e2e harness 固定 START_MS 的 dayPath 仍走旧类）。
 *
 * 语义决定：
 *   - 写分片 = `now()` 的 UTC 日；轮转发生在 append 内、全程同步（Journal 无 await，
 *     单写者契约下同进程不可能交错）——旧片行已 fsync、切片只换目标文件，写序不丢行。
 *   - 读视图（rows / size / readFrom / gaps）= 目录内**全部** `YYYY-MM-DD.jsonl` 分片按
 *     日期键升序拼接。对账器「重启全量重扫」因此看得见旧日残账（D15 无内存态语义的
 *     整本形式）；`gaps()` 的 expected 与跨日补记的 actual 分居两片也能正确收口。
 *   - 持久性同 Ledger：每片 Journal 强制 `fsyncOnAppend=true`（逐分片保持 D15 承诺）。
 *   - 日期注入点 `now: () => number`（缺省 Date.now）：跨日轮转可用假时钟单测。
 *   - 目录里非日期分片名的文件被无视（不是账本片）；序校验（expected 查重 / actual 前置）
 *     走全目录读视图——新片首扫即回放、此后走缓存，同 Journal 单写者契约下成本可摊薄。
 */

import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { Journal } from "./journal.js";
import { LedgerError } from "./errors.js";
import { assertDateKey, stateDateKey } from "./layout.js";
import { isLedgerRowShape, parseLedgerRow, type LedgerRow, type LedgerStatus } from "./ledger.js";

/** 日分片文件名（`<root>/ledger/` 下唯一被认领的形态）。 */
const SHARD_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface RotatingLedgerOptions {
  /** 账本目录 = `StateLayout.dir("ledger")`（分片文件按 UTC 日在该目录下轮转）。 */
  readonly dir: string;
  /** 时钟注入点（毫秒）；缺省 `Date.now`。每次追加写入时取当前 UTC 日决定落片。 */
  readonly now?: () => number;
}

/**
 * 跨日轮转账本。用法（server 装配主线）：
 *   `new RotatingLedger({ dir: layout.dir("ledger") })`
 * 测试注入假时钟：
 *   `new RotatingLedger({ dir, now: () => fakeMs })`
 */
export class RotatingLedger {
  private readonly _dir: string;
  private readonly _now: () => number;
  /** 已开分片缓存：dateKey → Journal（构造即全量回放既有片；轮转/重扫增量补开）。 */
  private readonly _shards = new Map<string, Journal>();

  constructor(opts: RotatingLedgerOptions) {
    if (typeof opts.dir !== "string" || opts.dir.trim().length === 0) {
      throw new LedgerError(`RotatingLedger: dir must be a non-empty path (StateLayout.dir("ledger"))`);
    }
    this._dir = opts.dir;
    this._now = opts.now ?? Date.now;
    // 目录幂等自建（readdir 前置条件；与 StateLayout.ensureDirs 兼容并存）。
    mkdirSync(this._dir, { recursive: true });
    // 构造即扫盘开片 = 「重启全量重扫」的入口（同旧 Ledger 构造即回放的语义位）。
    this._discover();
  }

  /** 账本目录（只读暴露，审计/测试定位用）。 */
  get dir(): string {
    return this._dir;
  }

  /** 下一次写入将落的分片路径（= `now()` 的 UTC 日；纯计算，无开片副作用）。 */
  get filePath(): string {
    return this._shardPath(stateDateKey(this._now()));
  }

  /** 全部已落分片的总有效行数（拼接视图的增量读游标锚点）。 */
  get size(): number {
    let n = 0;
    for (const journal of this._sortedShards()) n += journal.size;
    return n;
  }

  /** 开火登记：expected 行 fsync 落**当日**分片后才返回。全本任意片已有该 runId 行则响亮拒绝。 */
  expected(runId: string, at: number, payload: unknown = null): void {
    if (this._tagsOfRun(runId).length > 0) {
      throw new LedgerError(`run ${runId} already has ledger rows`);
    }
    const row: LedgerRow = { t: "expected", runId, at, payload };
    this._journalForWrite().append(row);
  }

  /** 终态登记：actual 行落**当日**分片（可与 expected 分居两片）。必须先有 expected 且未收口。 */
  actual(runId: string, at: number, status: LedgerStatus, payload: unknown = null): void {
    const tags = this._tagsOfRun(runId);
    if (!tags.includes("expected")) {
      throw new LedgerError(`actual for run ${runId} without expected row`);
    }
    if (tags.includes("actual")) {
      throw new LedgerError(`run ${runId} already closed with an actual row`);
    }
    const row: LedgerRow = { t: "actual", runId, at, status, payload };
    this._journalForWrite().append(row);
  }

  /** 全量行（对账器重启全量重扫用）：各分片按日期键升序拼接、片内保持写序。 */
  rows(): LedgerRow[] {
    const out: LedgerRow[] = [];
    for (const journal of this._sortedShards()) {
      for (const raw of journal.read()) out.push(parseLedgerRow(raw));
    }
    return out;
  }

  /**
   * 增量读：拼接视图下标 fromRow 起的行。游标在「日期键不往回调」的追加模式下稳定
   * ——写只落当日片（升序末片），旧片只读不改。
   */
  readFrom(fromRow: number): LedgerRow[] {
    const out: LedgerRow[] = [];
    let skip = Math.max(0, fromRow);
    for (const journal of this._sortedShards()) {
      const n = journal.size;
      if (skip >= n) {
        skip -= n;
        continue;
      }
      for (const raw of journal.read(skip)) out.push(parseLedgerRow(raw));
      skip = 0;
    }
    return out;
  }

  /** 缺口 = 有 expected、无 actual 的 runId（跨片收口正确；算法同 Ledger.gaps，整本视图）。 */
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

  /** 目录重扫：开尚未缓存的日期分片（跨日轮转的新片在**写路径**开，此处只管读视图补齐）。 */
  private _discover(): void {
    for (const name of readdirSync(this._dir)) {
      const key = SHARD_FILE_RE.exec(name)?.[1];
      if (key === undefined || this._shards.has(key)) continue;
      this._shards.set(key, this._openJournal(key));
    }
  }

  /** 当前写入目标片（= `now()` 的 UTC 日）；跨日未开则开新片——轮转唯一发生地，同步完成。 */
  private _journalForWrite(): Journal {
    const key = stateDateKey(this._now());
    const hit = this._shards.get(key);
    if (hit !== undefined) return hit;
    const opened = this._openJournal(key);
    this._shards.set(key, opened);
    return opened;
  }

  /** 分片 Journal 打开（fsync 强制、形状校验同 Ledger，逐分片保持 D15 持久性承诺）。 */
  private _openJournal(dateKey: string): Journal {
    return new Journal(this._shardPath(dateKey), {
      fsyncOnAppend: true,
      isRow: isLedgerRowShape,
    });
  }

  private _shardPath(dateKey: string): string {
    return join(this._dir, `${assertDateKey(dateKey)}.jsonl`);
  }

  /** 读视图分片序列：重扫目录后按日期键升序（ISO 键字典序 = 时序）。 */
  private _sortedShards(): Journal[] {
    this._discover();
    const keys = [...this._shards.keys()];
    keys.sort();
    const out: Journal[] = [];
    for (const key of keys) {
      const journal = this._shards.get(key);
      if (journal !== undefined) out.push(journal);
    }
    return out;
  }

  /** 某 run 在全本（含旧日分片）已登记的行标签（序校验用）。 */
  private _tagsOfRun(runId: string): Array<"expected" | "actual"> {
    const out: Array<"expected" | "actual"> = [];
    for (const journal of this._sortedShards()) {
      for (const raw of journal.read()) {
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
    }
    return out;
  }
}
