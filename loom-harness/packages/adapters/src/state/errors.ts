/**
 * L0 状态层类型化错误（T08）。文件路径/行号随错误携带，审计与 catch 侧都能拿到坐标。
 */

/** 日志损坏：中段坏行（append-only 下崩溃只可能撕裂**尾部**，中段坏 = 真损坏）。 */
export class StateCorruptionError extends Error {
  readonly filePath: string;
  readonly lineNumber: number;

  constructor(message: string, filePath: string, lineNumber: number) {
    super(message);
    this.name = "StateCorruptionError";
    this.filePath = filePath;
    this.lineNumber = lineNumber;
  }
}

/** 账本违例：expected/actual 重复登记、缺关联键等（Ledger 边界校验）。 */
export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

/** 会话分片违例：seq 断裂、分片目录不一致等（SessionShards 边界校验）。 */
export class SessionShardsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionShardsError";
  }
}
