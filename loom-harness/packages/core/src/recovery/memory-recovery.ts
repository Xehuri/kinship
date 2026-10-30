/**
 * 内存恢复件 —— 端口假件（core 测试 + server 装配前的占位）。
 *
 * `MemoryRecoveryLedger` 语义**逐条镜像** T12 `MemoryLedger` 与真 `Ledger`：
 *   - expected 重复登记同名 runId → 抛错；
 *   - actual 必须先有 expected、且不可重复收口 → 抛错；
 *   - rows()/gaps() 与真 Ledger 同语义（缺口 = 有 expected 无 actual）。
 * 差异（故意）：不落地文件（真 Ledger 由 server 装配注入）。
 */

import type { LedgerTerminalStatus, RunRow } from "../run-engine/index.js";
import { DEAD_LETTER_MARK } from "../convergence/index.js";
import type {
  AutoResumePort,
  CatchupDispatchPort,
  CatchupPolicyPort,
  CatchupRequest,
  CatchupStrategy,
  DeadLetterReceipt,
  MainDeliverPort,
  RecoveryLedgerPort,
  RecoveryLedgerRow,
} from "./types.js";

/** 内存账本：恢复端口的可读可写假件（测试观察对象）。 */
export class MemoryRecoveryLedger implements RecoveryLedgerPort {
  private readonly _rows: RecoveryLedgerRow[] = [];

  /** 全量行副本（按写入序）。 */
  rows(): readonly RecoveryLedgerRow[] {
    return [...this._rows];
  }

  /** 缺口 = 有 expected 无 actual 的 runId（与真 Ledger.gaps() 同语义）。 */
  gaps(): string[] {
    const closed = new Set(
      this._rows.filter((r) => r.t === "actual").map((r) => r.runId),
    );
    const opened: string[] = [];
    const seen = new Set<string>();
    for (const r of this._rows) {
      if (r.t === "actual") continue;
      if (!seen.has(r.runId)) {
        seen.add(r.runId);
        opened.push(r.runId);
      }
    }
    return opened.filter((id) => !closed.has(id));
  }

  expected(runId: string, at: number, payload: unknown = null): void {
    if (this._rows.some((r) => r.runId === runId)) {
      throw new Error(`run ${runId} already has ledger rows`);
    }
    this._rows.push({ t: "expected", runId, at, payload });
  }

  actual(runId: string, at: number, status: LedgerTerminalStatus, payload: unknown = null): void {
    if (!this._rows.some((r) => r.runId === runId && r.t === "expected")) {
      throw new Error(`actual for run ${runId} without expected row`);
    }
    if (this._rows.some((r) => r.runId === runId && r.t === "actual")) {
      throw new Error(`run ${runId} already closed with an actual row`);
    }
    this._rows.push({ t: "actual", runId, at, status, payload });
  }

  /** 测试辅助：登记一条 expected（payload = RunRow，模拟 T12 dispatch 落盘）。 */
  seed(row: RunRow, at: number): void {
    this.expected(row.run_id, at, row);
  }
}

/** 内存自动续跑端口：记录 resume 调用（level 1 观察对象）。 */
export class MemoryAutoResume implements AutoResumePort {
  readonly resumed: RunRow[] = [];
  resume(run: RunRow): void {
    this.resumed.push(run);
  }
}

/** 内存追赶派发端口：记录 catchup 请求（level 2 观察对象）。 */
export class MemoryCatchupDispatch implements CatchupDispatchPort {
  readonly requests: CatchupRequest[] = [];
  dispatchCatchup(request: CatchupRequest): void {
    this.requests.push(request);
  }
}

/** 内存死信投主端口：记录投递回执（dead-letter 观察对象）。 */
export class MemoryMainDeliver implements MainDeliverPort {
  readonly delivered: DeadLetterReceipt[] = [];
  deliver(receipt: DeadLetterReceipt): void {
    this.delivered.push(receipt);
  }
}

/** 内存策略表：缺键回落到 fallback（缺省 "none" = 保守不补跑）。 */
export class MapCatchupPolicy implements CatchupPolicyPort {
  constructor(
    private readonly _map: ReadonlyMap<string, CatchupStrategy>,
    private readonly _fallback: CatchupStrategy = "none",
  ) {}

  strategyFor(workflow: string): CatchupStrategy {
    return this._map.get(workflow) ?? this._fallback;
  }
}

/**
 * 死信回执 → 主会话 deliver 文本（带【死信】前缀；D23 副会话回执直投主会话的格式）。
 * 仅格式装配，不含副作用；`MainDeliverPort` 实现可选用。
 */
export function deadLetterMessage(receipt: DeadLetterReceipt): string {
  return (
    `${DEAD_LETTER_MARK}副会话回执 run=${receipt.run_id} workflow=${receipt.workflow} ` +
    `attempt=${receipt.attempt} status=dead-letter：${receipt.digest}`
  );
}
