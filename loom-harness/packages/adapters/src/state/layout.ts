/**
 * L0 状态层布局与根路径注入（T08，docs/02 §T08 / docs/01 §9）。
 *
 * 真源布局（全部 append-only JSONL，L0 唯一真源、无内存态）：
 *   <root>/trace/{date}.jsonl               运行 trace/span（T21 消费）
 *   <root>/ledger/{date}.jsonl              期望账本 expected/actual（T12/T13 消费）
 *   <root>/session/{id}/shard-NNNNNN.jsonl  会话分片 + 目录索引（每 N turn 一片）
 *   <root>/config/{date}.jsonl              配置变更事件（T20 消费）
 *   <root>/inbox/{name}.jsonl               待投递消息（T10 轮边界消费）
 *   <root>/dead-letter/{name}.jsonl         死信（T13 终态回执投主）
 *
 * 计划文本写 `session/{id}.jsonl`；在「每 N turn 分片 + 目录索引」约束下落成
 * `session/{id}/shard-*.jsonl` 目录形态——目录名即会话、文件名即分片序号，
 * readIndex 只列目录不读文件内容（D20：读路径永不重放 L0 全量）。
 *
 * 根路径**参数注入**：构造参数 > 环境变量 AXEUH_STATE_ROOT > 仓库默认 `<repo>/state`
 * （默认值相对模块位置计算，src 与 dist 同深度；禁止硬编码绝对路径）。
 */

import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Journal, type JournalOptions } from "./journal.js";

/** L0 六个子目录（STATE_DIRS 是唯一真源列表）。 */
export const STATE_DIRS = [
  "trace",
  "ledger",
  "session",
  "config",
  "inbox",
  "dead-letter",
] as const;

export type StateDir = (typeof STATE_DIRS)[number];

const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 布局层错误：根路径、文件/会话名、日期键等非法输入（边界校验，响亮失败）。 */
export class StateLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateLayoutError";
  }
}

/** 校验单段路径名（会话 id / 消息流名 / 文件名）：首字符字母数字，防 `..`/`/` 逃逸。 */
export function assertSafeSegment(raw: string, what: string): string {
  if (!SAFE_SEGMENT_RE.test(raw)) {
    throw new StateLayoutError(
      `invalid ${what} (must match ${String(SAFE_SEGMENT_RE)}): ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/** 校验日期键 `YYYY-MM-DD`（trace/ledger/config 的日分片文件名）。 */
export function assertDateKey(raw: string): string {
  if (!DATE_KEY_RE.test(raw)) {
    throw new StateLayoutError(
      `invalid state date key (want YYYY-MM-DD): ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/** 毫秒时间戳 → 日分片键（UTC ISO 日期前缀）。 */
export function stateDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 默认根：从模块位置向上 4 级到仓库根再进 `state/`（不硬编码绝对路径）。 */
export function defaultStateRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../../state");
}

/** 根解析优先级：显式参数 > 环境变量 AXEUH_STATE_ROOT > 仓库默认。 */
export function resolveStateRoot(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit);
  const env = process.env["AXEUH_STATE_ROOT"];
  if (env !== undefined && env.length > 0) return resolve(env);
  return defaultStateRoot();
}

export interface StateLayoutOptions {
  readonly root?: string;
}

/** 路径注入中枢：所有 L0 读写器经它拿目录/文件路径，杜绝散落硬编码。 */
export class StateLayout {
  readonly root: string;

  constructor(opts: StateLayoutOptions = {}) {
    this.root = resolveStateRoot(opts.root);
  }

  /** 六个子目录之一（不建目录，纯路径计算）。 */
  dir(d: StateDir): string {
    return join(this.root, d);
  }

  /** 幂等建齐六个子目录，返回各目录路径。 */
  ensureDirs(): string[] {
    for (const d of STATE_DIRS) {
      mkdirSync(this.dir(d), { recursive: true });
    }
    return STATE_DIRS.map((d) => this.dir(d));
  }

  /** <root>/<dir>/<fileName>，文件名做安全段校验。 */
  filePath(d: StateDir, fileName: string): string {
    return join(this.dir(d), assertSafeSegment(fileName, "state file name"));
  }

  /** <root>/<dir>/<date>.jsonl，日期键做格式校验（trace/ledger/config 日分片）。 */
  dayPath(d: StateDir, date: string): string {
    return join(this.dir(d), `${assertDateKey(date)}.jsonl`);
  }

  /** <root>/session/<id>（会话分片目录，不建目录）。 */
  sessionDir(sessionId: string): string {
    return join(this.dir("session"), assertSafeSegment(sessionId, "session id"));
  }

  /** 打开一个命名文件流的 Journal（inbox / dead-letter 用）。 */
  openJournal(d: StateDir, fileName: string, opts: JournalOptions = {}): Journal {
    return new Journal(this.filePath(d, fileName), opts);
  }

  /** 打开一个日分片 Journal（trace / config / ledger 用）。 */
  openDayJournal(d: StateDir, date: string, opts: JournalOptions = {}): Journal {
    return new Journal(this.dayPath(d, date), opts);
  }
}
