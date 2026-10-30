// L0 状态层（T08）：JSONL journal / 账本 / 会话分片 + 根路径注入。
// 下游契约消费方：T12 运行引擎（Ledger）、T13 对账（gaps）、T15 cron（trace 日分片）、
// T17 暂停开关（ledger 行）、T19 压缩（SessionShards 增量读）、T21 trace 审计（Journal）。

export {
  Journal,
  isJsonObjectRow,
  type JsonObjectRow,
  type JournalOptions,
} from "./journal.js";

export {
  StateLayout,
  STATE_DIRS,
  type StateDir,
  type StateLayoutOptions,
  assertSafeSegment,
  assertDateKey,
  stateDateKey,
  defaultStateRoot,
  resolveStateRoot,
  StateLayoutError,
} from "./layout.js";

export {
  StateCorruptionError,
  LedgerError,
  SessionShardsError,
} from "./errors.js";

export {
  Ledger,
  LEDGER_STATUSES,
  type LedgerStatus,
  type LedgerRow,
  parseLedgerRow,
  isLedgerRowShape,
} from "./ledger.js";

// 跨 UTC 日轮转账本（修「启动日冻结」缺陷）：写时取 now() 的日分片，读视图=目录全部分片。
export {
  RotatingLedger,
  type RotatingLedgerOptions,
} from "./ledger-rotating.js";

export {
  SessionShards,
  DEFAULT_TURNS_PER_SHARD,
  type ShardEntry,
  type ShardSlice,
  type SessionShardsOptions,
  type IndexRow,
  parseIndexRow,
  isIndexRowShape,
} from "./session-shards.js";
