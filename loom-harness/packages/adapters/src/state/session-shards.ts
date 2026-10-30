/**
 * SessionShards —— L0 会话分片 + 目录索引（T08，docs/01 D20「L0 按 N 轮分片+目录索引；
 * 读路径永不重放 L0 全量」）。
 *
 * 形态：`session/{id}/shard-NNNNNN.jsonl`（每 N turn 一片）+ `session/{id}/index.jsonl`
 * （封片记录，一行一片）。
 *   - `readIndex()` 只回放 index + 列目录 + 取活动片内存长度，**不读已封片内容**——O(片数)。
 *   - `readAfter(startTurn)` 按索引定位起点，只打开覆盖 [startTurn, ∞) 的分片——O(增量)，
 *     装配（T18/T19）永不整回放；`openedShards` 是这条复杂度的可观测证明量。
 *
 * 崩溃语义照 vendor torn-tail：每个 shard / index 都是 Journal（尾行撕裂容忍、中段损坏抛错）。
 * index 撕裂尾行 = 封片记录丢失，重开时按目录实况自动补封（幂等：按片号去重）。
 * 无内存真源：任何新实例从盘上重建全部状态。同一会话目录单写者（同 vendor 并发契约）。
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Journal, type JsonObjectRow, type JournalOptions } from "./journal.js";
import { SessionShardsError } from "./errors.js";

/** 默认每 N turn 封一片。 */
export const DEFAULT_TURNS_PER_SHARD = 50;

/** 分片文件名：shard-000001.jsonl …（六位零填充，字典序=片号序）。 */
const SHARD_FILE_RE = /^shard-(\d{6})\.jsonl$/;

function shardFileName(no: number): string {
  return `shard-${String(no).padStart(6, "0")}.jsonl`;
}

function parseShardNo(fileName: string): number | null {
  const m = SHARD_FILE_RE.exec(fileName);
  return m === null ? null : Number(m[1]);
}

/** 目录索引条目：一个分片的元信息。no 从 1 起；firstTurn 为该片首 turn 的全局下标。 */
export interface ShardEntry {
  readonly no: number;
  readonly file: string;
  readonly firstTurn: number;
  readonly turns: number;
  /** false = 活动片（未封，turns < N，随写随增）。 */
  readonly sealed: boolean;
}

/** index.jsonl 的一行载荷（firstTurn 冗余落盘仅作可读性；重建一律按片序现算）。 */
export type IndexRow = {
  readonly t: "seal";
  readonly no: number;
  readonly file: string;
  readonly turns: number;
};

/** Journal 形状校验：封片记录判别字段和载荷一起验（照 vendor isLogRecord 做法）。 */
export function isIndexRowShape(row: JsonObjectRow): boolean {
  if (row["t"] !== "seal") return false;
  return (
    typeof row["no"] === "number" &&
    typeof row["file"] === "string" &&
    typeof row["turns"] === "number"
  );
}

/** 边界解析：JsonObjectRow → IndexRow（形状非法抛 SessionShardsError）。 */
export function parseIndexRow(row: JsonObjectRow): IndexRow {
  const { t, no, file, turns } = row;
  if (
    t !== "seal" ||
    typeof no !== "number" ||
    typeof file !== "string" ||
    typeof turns !== "number"
  ) {
    throw new SessionShardsError(`bad index row: ${JSON.stringify(row)}`);
  }
  return { t: "seal", no, file, turns };
}

/** `readAfter` 结果：增量行 + 本次实际打开的分片文件数（O(增量) 的证明观测量）。 */
export interface ShardSlice {
  readonly rows: JsonObjectRow[];
  readonly openedShards: number;
}

export interface SessionShardsOptions {
  readonly turnsPerShard?: number;
  /** 传给底层 Journal（shard 与 index 共用；账本级持久性需要时开 fsyncOnAppend）。 */
  readonly journal?: JournalOptions;
}

/** 封片后的常驻索引条目（不含 firstTurn——按片序现算，防盘上绝对值过期）。 */
type SealedEntry = { readonly no: number; readonly file: string; readonly turns: number };

/**
 * 单会话的分片读写器。目录经 StateLayout.sessionDir(id) 注入；构造即建目录并从盘重建
 * 索引（无内存真源）。
 */
export class SessionShards {
  private readonly _dir: string;
  private readonly _n: number;
  private readonly _journalOpts: JournalOptions;
  /** index.jsonl 常驻（Journal 构造已回放）；读写都走它。 */
  private readonly _index: Journal;
  /** 已封片：no → 元信息（index 有效行 + 撕裂补封的并集，按 no 去重）。 */
  private readonly _sealed = new Map<number, SealedEntry>();
  /** 活动（未封）分片；null = 尚未开片或刚封满。 */
  private _active: { readonly no: number; readonly journal: Journal } | null = null;

  constructor(sessionDir: string, opts: SessionShardsOptions = {}) {
    this._dir = sessionDir;
    const n = opts.turnsPerShard ?? DEFAULT_TURNS_PER_SHARD;
    if (n < 1 || !Number.isInteger(n)) {
      throw new SessionShardsError(`turnsPerShard must be a positive integer: ${String(n)}`);
    }
    this._n = n;
    this._journalOpts = opts.journal ?? {};
    // 构造 Journal 即 mkdir + 回放 index（撕裂尾行由 Journal 容忍并修复，_recover 再按目录补封）。
    this._index = new Journal(join(this._dir, "index.jsonl"), {
      ...this._journalOpts,
      isRow: isIndexRowShape,
    });
    this._recover();
  }

  /** 会话目录路径（只读暴露；测试做撕裂模拟用）。 */
  get dir(): string {
    return this._dir;
  }

  /** 分片容量 N。 */
  get turnsPerShard(): number {
    return this._n;
  }

  private _shardPath(no: number): string {
    return join(this._dir, shardFileName(no));
  }

  /** 打开一个分片文件做只读回放（不占活动指针）。 */
  private _openShard(no: number): Journal {
    return new Journal(this._shardPath(no), this._journalOpts);
  }

  /** 从盘重建：index 有效行入 _sealed；索引缺席的片按目录实况推算（封片前崩溃的尾部）。 */
  private _recover(): void {
    for (const r of this._index.read()) {
      const e = parseIndexRow(r);
      if (!this._sealed.has(e.no)) {
        this._sealed.set(e.no, { no: e.no, file: e.file, turns: e.turns });
      }
    }
    const shardNos = readdirSync(this._dir)
      .map(parseShardNo)
      .filter((no): no is number => no !== null)
      .sort((a, b) => a - b);

    for (const no of shardNos) {
      if (this._sealed.has(no)) continue; // 已封片：不读内容，只认索引
      // 索引没有 = 崩溃在封片之前。该片长度 ≤ N，读它重建尾部。
      const journal = this._openShard(no);
      if (journal.size >= this._n) {
        const entry = { no, file: shardFileName(no), turns: journal.size };
        this._sealed.set(no, entry);
        this._appendIndex(entry); // 补封（幂等：_sealed 去重）
      } else {
        if (this._active !== null) {
          throw new SessionShardsError(
            `multiple unsealed shards in ${this._dir}: ${String(this._active.no)} and ${String(no)}`,
          );
        }
        this._active = { no, journal };
      }
    }
  }

  private _appendIndex(entry: SealedEntry): void {
    const row: IndexRow = { t: "seal", no: entry.no, file: entry.file, turns: entry.turns };
    this._index.append(row);
  }

  /** 追加 turn 批次：按活动片剩余容量分块写，写满 N 自动封片、滚动新片。 */
  writeShard(turns: readonly JsonObjectRow[]): void {
    let rest: readonly JsonObjectRow[] = turns;
    while (rest.length > 0) {
      const active = this._ensureActive();
      const take = Math.min(rest.length, this._n - active.journal.size);
      if (take === 0) {
        // 活动片已满（等值 N 的情形由上一轮封口处理）：兜底封掉再循环。
        this._sealActive();
        continue;
      }
      active.journal.appendMany(rest.slice(0, take));
      rest = rest.slice(take);
      if (active.journal.size === this._n) this._sealActive();
    }
  }

  /** 追加单个 turn（writeShard([turn]) 的便捷别名，主循环热路径用）。 */
  appendTurn(turn: JsonObjectRow): void {
    this.writeShard([turn]);
  }

  private _ensureActive(): { readonly no: number; readonly journal: Journal } {
    if (this._active !== null) return this._active;
    const nextNo = this._sealed.size + 1;
    if (this._sealed.has(nextNo)) {
      // 片号=封片数+1 却已被封：索引/目录失配（损坏），响亮失败。
      throw new SessionShardsError(`shard ${String(nextNo)} sealed but active pointer inconsistent`);
    }
    this._active = { no: nextNo, journal: this._openShard(nextNo) };
    return this._active;
  }

  private _sealActive(): void {
    const active = this._active;
    if (active === null) return;
    const entry = { no: active.no, file: shardFileName(active.no), turns: active.journal.size };
    this._sealed.set(active.no, entry);
    this._appendIndex(entry);
    this._active = null;
  }

  /**
   * 目录索引：已封片（不读片内容）+ 活动片（内存镜像长度）。firstTurn 按片序现算。
   * 代价 O(片数)，与历史总长无关——装配读路径的锚。
   */
  readIndex(): ShardEntry[] {
    const out: ShardEntry[] = [];
    let firstTurn = 0;
    for (const no of [...this._sealed.keys()].sort((a, b) => a - b)) {
      const e = this._sealed.get(no);
      if (e === undefined) {
        throw new SessionShardsError(`sealed shard ${String(no)} vanished from index`);
      }
      out.push({ ...e, firstTurn, sealed: true });
      firstTurn += e.turns;
    }
    if (this._active !== null && this._active.journal.size > 0) {
      out.push({
        no: this._active.no,
        file: shardFileName(this._active.no),
        firstTurn,
        turns: this._active.journal.size,
        sealed: false,
      });
    }
    return out;
  }

  /** 全局 turn 总数（索引求和，O(片数)）。 */
  turnCount(): number {
    return this.readIndex().reduce((sum, e) => sum + e.turns, 0);
  }

  /**
   * 增量读：全局下标 `startTurn` 起的行。按索引跳过完全早于起点的分片，**只打开**覆盖
   * 区间的分片（活动片直接用内存镜像不重复开）。`readAfter(0)` 才等价全量。
   */
  readAfter(startTurn: number): ShardSlice {
    const from = Math.max(0, startTurn);
    const rows: JsonObjectRow[] = [];
    let openedShards = 0;
    for (const e of this.readIndex()) {
      if (e.firstTurn + e.turns <= from) continue;
      const journal =
        this._active !== null && this._active.no === e.no
          ? this._active.journal
          : this._openShard(e.no);
      openedShards += 1;
      rows.push(...journal.read(Math.max(0, from - e.firstTurn)));
    }
    return { rows, openedShards };
  }
}
