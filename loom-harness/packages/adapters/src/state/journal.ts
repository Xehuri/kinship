/**
 * Journal —— L0 单文件 append-only JSONL 日志（T08）。
 *
 * 语义照 vendor `jsonl-session-store.ts`（同包，不改它）：
 *   - 写 = 追加一行 JSON（先落盘、成功后才进内存）。进程崩溃后重启回放可完整恢复；
 *     断电可能丢尾部未刷盘字节，且崩溃可能在尾部留下一条**半截（torn）记录**。
 *   - 回放对**末尾**坏行容忍（丢弃、恢复其余全部历史）；**中段**坏行 = 真损坏、响亮抛错。
 *   - `fsyncOnAppend=true` 时每行 append 后 fsync（账本 expected 用，D15「先于执行」的持久性承诺）。
 *   - `isRow` 形状校验器照 vendor isLogRecord：判别字段和载荷一起验——torn 不只产生 parse 不了的
 *     JSON，也产生 parse 得了但形状残缺的行；残缺行按**位置**判 torn（尾）或损坏（中段）。
 *   - 并发契约与 vendor 一致：单写者，调用方保证同一文件串行写。
 *
 * 读路径：构造时回放建内存行数组；`read(fromRow)` 按下标切片——增量读不重放（D20）。
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { StateCorruptionError } from "./errors.js";

/** 日志一行的载荷：任意 JSON 对象（键 → 值）；各域在自己边界再做形状解析。 */
export type JsonObjectRow = { readonly [key: string]: unknown };

export interface JournalOptions {
  /** 每行追加后 fsync（断电持久性；默认 false=page cache，同 vendor 边界声明）。 */
  readonly fsyncOnAppend?: boolean;
  /**
   * 行形状校验器。返回 false 的行按「坏行」处理（尾行容忍 / 中段抛错），
   * 域层（Ledger/SessionShards 索引）用它把 parse 得了但载荷残缺的 torn 行挡在门外。
   */
  readonly isRow?: ((row: JsonObjectRow) => boolean) | undefined;
}

/** 边界解析一行：JSON 对象（非 null、非数组）才返回；否则 null（坏行，位置判定交给回放）。 */
function parseRow(line: string): JsonObjectRow | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  return isJsonObjectRow(value) ? value : null;
}

/** 校验未知值是否为 JSON 对象行（各域做形状解析时可复用）。 */
export function isJsonObjectRow(x: unknown): x is JsonObjectRow {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export class Journal {
  private readonly _rows: JsonObjectRow[] = [];
  private readonly _filePath: string;
  private readonly _fsync: boolean;
  private readonly _isRow: ((row: JsonObjectRow) => boolean) | undefined;

  constructor(filePath: string, opts: JournalOptions = {}) {
    this._filePath = filePath;
    this._fsync = opts.fsyncOnAppend ?? false;
    this._isRow = opts.isRow;
    mkdirSync(dirname(filePath), { recursive: true });
    this._replay();
  }

  /** 日志文件路径（只读暴露；测试做撕裂模拟、审计定位用）。 */
  get filePath(): string {
    return this._filePath;
  }

  /** 已落盘且回放认可的有效行数（内存镜像恒 ⊆ 盘上内容：先落盘后才进内存）。 */
  get size(): number {
    return this._rows.length;
  }

  /**
   * 回放整个文件重建行数组。坏行处理逐条对齐 vendor `_load`：
   * 只有**最后一条非空行**可能是崩溃截断的 torn 行 → 容忍丢弃；中段坏行 → StateCorruptionError。
   * 尾行被撕裂判丢时顺手**截掉**（tail repair）：vendor 只容忍不改盘，恢复后继续 append 会把
   * 新行拼在撕裂残段后变成中段损坏；截掉撕裂段后 append 可安全续写（T12/T13 崩溃恢复依赖此）。
   */
  private _replay(): void {
    if (!existsSync(this._filePath)) return;
    const lines = readFileSync(this._filePath, "utf8").split("\n");
    let lastNonEmpty = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if ((lines[i] ?? "").trim().length > 0) {
        lastNonEmpty = i;
        break;
      }
    }
    // 逐行起始字节偏移（utf8 多字节安全），供撕裂尾行的截断定位。
    let tornByteStart = -1;
    let byteCursor = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const lineByteStart = byteCursor;
      byteCursor += Buffer.byteLength(line, "utf8") + 1; // +1 = "\n"
      if (line.trim().length === 0) continue;
      const row = parseRow(line);
      if (row === null || (this._isRow !== undefined && !this._isRow(row))) {
        if (i === lastNonEmpty) {
          tornByteStart = lineByteStart; // torn 尾行：容忍、恢复其余历史，稍后截掉
          break;
        }
        throw new StateCorruptionError(
          `journal corrupt at ${this._filePath}:${String(i + 1)}`,
          this._filePath,
          i + 1,
        );
      }
      this._rows.push(row);
    }
    if (tornByteStart >= 0) this._repairTail(tornByteStart);
  }

  /** 把撕裂尾行连同其后的所有内容从盘上截掉（撕裂段之后的字节都不可信）。 */
  private _repairTail(byteStart: number): void {
    const fd = openSync(this._filePath, "r+");
    try {
      ftruncateSync(fd, byteStart);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** 追加一行：先落盘（可选 fsync）成功后才进内存。写失败抛错、内存不被污染。 */
  append(row: JsonObjectRow): void {
    this._appendLines([row]);
  }

  /** 批量追加：一次 write 落多行（torn 爆炸半径 = 一批，与 vendor fork 批写同构）。 */
  appendMany(rows: readonly JsonObjectRow[]): void {
    if (rows.length === 0) return;
    this._appendLines(rows);
  }

  private _appendLines(rows: readonly JsonObjectRow[]): void {
    const text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    if (this._fsync) {
      const fd = openSync(this._filePath, "a");
      try {
        // 循环写全：writeSync 允许短写，写全后才 fsync（账本「先于执行」不许半行落盘）。
        const buf = Buffer.from(text, "utf8");
        let off = 0;
        while (off < buf.length) {
          off += writeSync(fd, buf, off);
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } else {
      appendFileSync(this._filePath, text);
    }
    for (const r of rows) this._rows.push(r);
  }

  /**
   * 读：`fromRow` 起的行切片（增量读 O(增量)，装配路径不整文件重放）。
   * 返回新数组；行对象本身是回放时的共享引用（L0 行视为不可变）。
   */
  read(fromRow = 0): JsonObjectRow[] {
    return this._rows.slice(Math.max(0, fromRow));
  }
}
